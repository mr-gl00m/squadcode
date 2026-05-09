import OpenAI, { APIError } from "openai";
import type {
  FunctionTool,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseInputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { ProviderError } from "../errors.js";
import { parseToolArgs } from "./arg-repair.js";
import type { ModelCapabilities } from "./catalog.js";
import type {
  CanonicalEvent,
  CanonicalFinishReason,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalToolCall,
  CanonicalToolSpec,
  CanonicalUsage,
  LLMProvider,
  ProviderCallOptions,
} from "./types.js";

// OpenAI Responses API adapter. Wire format: SSE stream of response.* events
// addressed by output_index. Output items come in three flavors squad cares
// about — message (text), function_call (tool use), reasoning (o-series and
// gpt-5.x). Each item gets added → has its content streamed in deltas →
// done. The stream-final response.completed carries the usage block.
//
// Differences from llm-chat: no reasoning_content field on a delta; reasoning
// is its own output item type. No tool_calls array on a single delta;
// function_call args arrive as their own typed events keyed by item_id.
// instructions field replaces the system role in input. Prompt caching is
// automatic above ~1024 tokens; cached_tokens surfaces in usage details.

export interface LlmResponseProviderOptions {
  apiKey: string;
  baseUrl: string;
  // Surfaced as LLMProvider.name; user-facing provider id from the catalog
  // row (typically "openai").
  providerId: string;
  capabilities?: ModelCapabilities;
}

const DEFAULT_REASONING_EFFORT: "low" | "medium" | "high" = "medium";

// Convert canonical messages into the Responses API's flat ResponseInput
// list. Unlike chat-completions, items aren't strictly alternating —
// function_call and function_call_output items sit alongside message items.
// system messages collapse into the request-level `instructions` field.
export function toResponseInput(
  req: CanonicalRequest,
): { instructions: string | undefined; input: ResponseInput } {
  let instructions = req.system;
  const input: ResponseInputItem[] = [];

  for (const m of req.messages) {
    switch (m.role) {
      case "system":
        instructions = instructions ? `${instructions}\n\n${m.content}` : m.content;
        continue;
      case "user":
        input.push({
          role: "user",
          content: m.content,
          type: "message",
        });
        continue;
      case "tool":
        input.push({
          type: "function_call_output",
          call_id: m.toolCallId ?? "",
          output: m.content,
        });
        continue;
      case "assistant": {
        if (m.content && m.content.length > 0) {
          input.push({
            role: "assistant",
            content: m.content,
            type: "message",
          });
        }
        if (m.toolCalls) {
          for (const tc of m.toolCalls) {
            const argsStr =
              typeof tc.args === "string"
                ? tc.args
                : JSON.stringify(tc.args ?? {});
            input.push({
              type: "function_call",
              call_id: tc.id,
              name: tc.name,
              arguments: argsStr,
            });
          }
        }
        continue;
      }
    }
  }

  return { instructions, input };
}

export function toResponseTools(
  tools: CanonicalToolSpec[] | undefined,
): FunctionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.inputSchema as Record<string, unknown>,
    strict: false,
  }));
}

function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  return status === 408 || status === 429 || status >= 500;
}

function mapErrorEvent(err: unknown): CanonicalEvent {
  if (err instanceof APIError) {
    return {
      type: "error",
      code: err.code ?? `HTTP_${err.status ?? 0}`,
      message: err.message,
      retryable: isRetryableStatus(err.status),
    };
  }
  if (err instanceof Error) {
    return {
      type: "error",
      code: "PROVIDER_ERROR",
      message: err.message,
      retryable: false,
    };
  }
  return {
    type: "error",
    code: "PROVIDER_ERROR",
    message: String(err),
    retryable: false,
  };
}

interface PendingFunctionCall {
  callId: string;
  name: string;
  argsBuffer: string;
}

const STREAM_IDLE_TIMEOUT_MS = 120_000;
const IDLE_TIMEOUT_SENTINEL: unique symbol = Symbol("stream-idle-timeout");

export function createLlmResponseProvider(
  opts: LlmResponseProviderOptions,
): LLMProvider {
  const client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl });
  const wantsReasoning = opts.capabilities?.reasoning === true;

  async function* stream(
    req: CanonicalRequest,
    callOpts?: ProviderCallOptions,
  ): AsyncIterable<CanonicalEvent> {
    const { instructions, input } = toResponseInput(req);
    const tools = toResponseTools(req.tools);

    const params: ResponseCreateParamsStreaming = {
      model: req.model,
      input,
      stream: true,
    };
    if (instructions !== undefined) params.instructions = instructions;
    if (tools) params.tools = tools;
    if (req.maxTokens !== undefined) params.max_output_tokens = req.maxTokens;
    if (req.temperature !== undefined) params.temperature = req.temperature;
    if (wantsReasoning) {
      params.reasoning = { effort: DEFAULT_REASONING_EFFORT, summary: "auto" };
    }

    const requestOpts: { signal?: AbortSignal } = {};
    if (callOpts?.signal) requestOpts.signal = callOpts.signal;

    let response;
    try {
      response = await client.responses.create(params, requestOpts);
    } catch (err: unknown) {
      yield mapErrorEvent(err);
      return;
    }

    // Track function_call items by output_index so args deltas / done events
    // can find their pending entry. Text and reasoning don't need tracking
    // because their deltas are forwarded immediately and don't accumulate.
    const pendingCalls = new Map<number, PendingFunctionCall>();
    let sawToolCall = false;
    let usage: CanonicalUsage | undefined;
    let finishReason: CanonicalFinishReason = "stop";

    const iterator = response[Symbol.asyncIterator]();
    try {
      while (true) {
        let timer: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<typeof IDLE_TIMEOUT_SENTINEL>(
          (resolve) => {
            timer = setTimeout(
              () => resolve(IDLE_TIMEOUT_SENTINEL),
              STREAM_IDLE_TIMEOUT_MS,
            );
          },
        );
        const result = await Promise.race([iterator.next(), timeoutPromise]);
        if (timer) clearTimeout(timer);
        if (result === IDLE_TIMEOUT_SENTINEL) {
          try {
            await iterator.return?.(undefined);
          } catch {
            // best-effort cleanup; ignore secondary failures
          }
          yield {
            type: "error",
            code: "STREAM_IDLE_TIMEOUT",
            message: `no stream chunks for ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)}s; upstream appears stalled`,
            retryable: true,
          };
          return;
        }
        if (result.done) break;
        const ev = result.value as ResponseStreamEvent;

        switch (ev.type) {
          case "response.output_item.added": {
            const item = ev.item;
            if (item.type === "function_call") {
              const callId = item.call_id;
              pendingCalls.set(ev.output_index, {
                callId,
                name: item.name,
                argsBuffer: "",
              });
              sawToolCall = true;
              yield {
                type: "tool_call_start",
                id: callId,
                name: item.name,
              };
            }
            // message and reasoning items don't need an explicit start event;
            // their deltas carry the content directly.
            break;
          }
          case "response.output_text.delta": {
            yield { type: "text_delta", text: ev.delta };
            break;
          }
          case "response.function_call_arguments.delta": {
            const call = pendingCalls.get(ev.output_index);
            if (!call) break;
            call.argsBuffer += ev.delta;
            yield {
              type: "tool_call_delta",
              id: call.callId,
              argsDelta: ev.delta,
            };
            break;
          }
          case "response.function_call_arguments.done": {
            const call = pendingCalls.get(ev.output_index);
            if (!call) break;
            // Prefer the stream-final arguments string if present; falls
            // back to the accumulated buffer for stream variants that emit
            // only deltas.
            const argsStr =
              ev.arguments && ev.arguments.length > 0
                ? ev.arguments
                : call.argsBuffer;
            const parsed = parseToolArgs(argsStr);
            yield {
              type: "tool_call_done",
              id: call.callId,
              name: call.name,
              args: parsed,
            };
            pendingCalls.delete(ev.output_index);
            break;
          }
          case "response.reasoning.delta": {
            // reasoning.delta is a string field; some SDK versions also emit
            // reasoning_summary_text.delta with a separate field — handled
            // below.
            const text = (ev as { delta?: unknown }).delta;
            if (typeof text === "string" && text.length > 0) {
              yield { type: "reasoning_delta", text };
            }
            break;
          }
          case "response.reasoning_summary_text.delta": {
            const text = (ev as { delta?: unknown }).delta;
            if (typeof text === "string" && text.length > 0) {
              yield { type: "reasoning_delta", text };
            }
            break;
          }
          case "response.completed": {
            const u = ev.response.usage;
            if (u) {
              const cached = u.input_tokens_details?.cached_tokens ?? 0;
              usage = {
                inputTokens: u.input_tokens,
                outputTokens: u.output_tokens,
                totalTokens: u.total_tokens,
                ...(cached > 0 && { cachedInputTokens: cached }),
              };
            }
            finishReason = sawToolCall ? "tool_use" : "stop";
            break;
          }
          case "response.failed":
          case "response.incomplete": {
            const errInfo =
              ev.type === "response.failed"
                ? ev.response.error
                : { message: "incomplete response", code: "incomplete" };
            yield {
              type: "error",
              code: errInfo?.code ?? "PROVIDER_ERROR",
              message: errInfo?.message ?? "response failed",
              retryable: false,
            };
            return;
          }
          case "error": {
            yield {
              type: "error",
              code: ev.code ?? "PROVIDER_ERROR",
              message: ev.message,
              retryable: false,
            };
            return;
          }
        }
      }
    } catch (err: unknown) {
      yield mapErrorEvent(err);
      return;
    }

    if (usage) yield { type: "usage", usage };
    yield { type: "done", reason: finishReason };
  }

  async function complete(
    req: CanonicalRequest,
    callOpts?: ProviderCallOptions,
  ): Promise<CanonicalResponse> {
    let text = "";
    const toolCalls: CanonicalToolCall[] = [];
    let finishReason: CanonicalFinishReason = "stop";
    let usage: CanonicalUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    for await (const ev of stream(req, callOpts)) {
      switch (ev.type) {
        case "text_delta":
          text += ev.text;
          break;
        case "tool_call_done":
          toolCalls.push({ id: ev.id, name: ev.name, args: ev.args });
          break;
        case "usage":
          usage = ev.usage;
          break;
        case "done":
          finishReason = ev.reason;
          break;
        case "error":
          throw new ProviderError(ev.message, {
            code: ev.code,
            retryable: ev.retryable,
          });
        case "tool_call_start":
        case "tool_call_delta":
        case "reasoning_delta":
        case "tool_result":
          break;
      }
    }
    return { text, toolCalls, finishReason, usage };
  }

  return {
    name: opts.providerId,
    stream,
    complete,
  };
}
