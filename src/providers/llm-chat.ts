import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { ProviderError } from "../errors.js";
import { parseToolArgs } from "./arg-repair.js";
import type { ModelCapabilities } from "./catalog.js";
import { toCanonicalErrorEvent } from "./llm-error.js";
import { sanitizeToolSchema } from "./schema-sanitize.js";
import type {
  CanonicalEvent,
  CanonicalFinishReason,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalToolCall,
  CanonicalToolSpec,
  CanonicalUsage,
  LLMProvider,
  ProviderCallOptions,
} from "./types.js";

// Generic chat-completions adapter. Speaks the OpenAI-compat wire format used
// by DeepSeek, Together, Groq, Fireworks, OpenRouter, classic gpt-4o, and
// (with a /v1 path append) Ollama. Per-backend behavior — reasoning_content
// extraction, prompt-cache-hit token reporting — is gated on capabilities
// from the catalog row, not on hardcoded provider-name checks.

export interface LlmChatProviderOptions {
  apiKey: string;
  baseUrl: string;
  // Surfaced as LLMProvider.name; the user-facing provider id from the
  // catalog row, not the kind tag. Lets pricing / cost / audit consumers
  // identify which backend a turn ran against.
  providerId: string;
  capabilities?: ModelCapabilities;
}

function toOpenAIMessages(req: CanonicalRequest): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  if (req.system) {
    out.push({ role: "system", content: req.system });
  }
  for (const m of req.messages) {
    out.push(toOpenAIMessage(m));
  }
  return out;
}

function toOpenAIMessage(m: CanonicalMessage): ChatCompletionMessageParam {
  switch (m.role) {
    case "system":
      return { role: "system", content: m.content };
    case "user":
      return { role: "user", content: m.content };
    case "assistant": {
      const param: ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: m.content,
      };
      if (m.toolCalls && m.toolCalls.length > 0) {
        const toolCalls: ChatCompletionMessageToolCall[] = m.toolCalls.map(
          (tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments:
                typeof tc.args === "string"
                  ? tc.args
                  : JSON.stringify(tc.args ?? {}),
            },
          }),
        );
        param.tool_calls = toolCalls;
      }
      if (m.reasoningContent) {
        (param as unknown as Record<string, unknown>).reasoning_content =
          m.reasoningContent;
      }
      return param;
    }
    case "tool":
      return {
        role: "tool",
        content: m.content,
        tool_call_id: m.toolCallId ?? "",
      };
  }
}

function toOpenAITools(
  tools: CanonicalToolSpec[] | undefined,
): ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: sanitizeToolSchema(t.inputSchema),
    },
  }));
}

function mapFinishReason(
  reason: string | null | undefined,
): CanonicalFinishReason {
  switch (reason) {
    case "length":
      return "max_tokens";
    case "content_filter":
      return "content_filter";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "stop":
    default:
      return "stop";
  }
}

interface PendingToolCall {
  id: string;
  name: string;
  argsBuffer: string;
  startEmitted: boolean;
}

// If no SSE chunk arrives for this long, treat the upstream stream as stalled
// and surface an error rather than waiting forever. Generous default — local
// models can be slow on the first token after a heavy prompt, and hosted
// endpoints occasionally pause mid-response.
const STREAM_IDLE_TIMEOUT_MS = 120_000;
const IDLE_TIMEOUT_SENTINEL: unique symbol = Symbol("stream-idle-timeout");

export function createLlmChatProvider(
  opts: LlmChatProviderOptions,
): LLMProvider {
  const client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl });
  const wantsReasoning = opts.capabilities?.reasoning === true;
  const wantsCacheTokens = opts.capabilities?.cache_control === true;

  async function* stream(
    req: CanonicalRequest,
    callOpts?: ProviderCallOptions,
  ): AsyncIterable<CanonicalEvent> {
    const params: ChatCompletionCreateParamsStreaming = {
      model: req.model,
      messages: toOpenAIMessages(req),
      stream: true,
      stream_options: { include_usage: true },
    };
    const mappedTools = toOpenAITools(req.tools);
    if (mappedTools) params.tools = mappedTools;
    if (req.maxTokens !== undefined) params.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) params.temperature = req.temperature;

    const requestOpts: { signal?: AbortSignal } = {};
    if (callOpts?.signal) requestOpts.signal = callOpts.signal;

    // biome-ignore lint/suspicious/noImplicitAnyLet: SDK create() is overloaded; a precise annotation collapses to a non-iterable union, so response stays inferred and is consumed via the typed async iterator below
    let response;
    try {
      response = await client.chat.completions.create(params, requestOpts);
    } catch (err: unknown) {
      yield toCanonicalErrorEvent(err);
      return;
    }

    const pending = new Map<number, PendingToolCall>();
    let finishReason: CanonicalFinishReason = "stop";
    let usage: CanonicalUsage | undefined;

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
        const chunk = result.value;
        const choice = chunk.choices[0];
        const delta = choice?.delta;

        if (delta?.content) {
          yield { type: "text_delta", text: delta.content };
        }

        if (wantsReasoning) {
          const reasoning = (delta as Record<string, unknown> | undefined)?.[
            "reasoning_content"
          ];
          if (typeof reasoning === "string" && reasoning.length > 0) {
            yield { type: "reasoning_delta", text: reasoning };
          }
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            let entry = pending.get(idx);
            if (!entry) {
              entry = {
                id: tc.id ?? `call_${idx}`,
                name: tc.function?.name ?? "",
                argsBuffer: "",
                startEmitted: false,
              };
              pending.set(idx, entry);
            } else if (tc.id && entry.id.startsWith("call_")) {
              entry.id = tc.id;
            }
            if (tc.function?.name && !entry.name) {
              entry.name = tc.function.name;
            }
            if (entry.name && !entry.startEmitted) {
              entry.startEmitted = true;
              yield { type: "tool_call_start", id: entry.id, name: entry.name };
            }
            const argsDelta = tc.function?.arguments ?? "";
            if (argsDelta) {
              entry.argsBuffer += argsDelta;
              yield { type: "tool_call_delta", id: entry.id, argsDelta };
            }
          }
        }

        if (choice?.finish_reason) {
          finishReason = mapFinishReason(choice.finish_reason);
        }
        if (chunk.usage) {
          const raw = chunk.usage as unknown as Record<string, unknown>;
          let cachedInputTokens: number | undefined;
          if (wantsCacheTokens) {
            const cacheHit = raw["prompt_cache_hit_tokens"];
            if (typeof cacheHit === "number" && cacheHit > 0) {
              cachedInputTokens = cacheHit;
            }
          }
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            totalTokens: chunk.usage.total_tokens ?? 0,
            ...(cachedInputTokens !== undefined && { cachedInputTokens }),
          };
        }
      }
    } catch (err: unknown) {
      yield toCanonicalErrorEvent(err);
      return;
    }

    for (const entry of pending.values()) {
      const parsed = parseToolArgs(entry.argsBuffer);
      yield {
        type: "tool_call_done",
        id: entry.id,
        name: entry.name,
        args: parsed,
      };
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
