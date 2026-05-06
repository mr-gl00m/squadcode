import Anthropic, { APIError } from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageCreateParamsStreaming,
  MessageParam,
  StopReason,
  TextBlockParam,
  Tool as AnthropicTool,
  ToolResultBlockParam,
  ToolUseBlockParam,
  RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages.js";
import { ProviderError } from "../errors.js";
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

// Anthropic Messages API adapter. The wire format is genuinely different
// from llm-chat: interleaved content blocks by index (text / tool_use /
// thinking), each with start / delta / stop events, plus message-level
// usage in message_delta. Cache_control breakpoints attach to specific
// content blocks (system prompt's last block, tools array's last entry).
// Thinking blocks map to canonical reasoning_delta.

export interface LlmMessageProviderOptions {
  apiKey: string;
  baseUrl?: string;
  // Surfaced as LLMProvider.name; user-facing provider id from the catalog
  // row (typically "anthropic").
  providerId: string;
  capabilities?: ModelCapabilities;
}

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_THINKING_BUDGET_TOKENS = 16_384;

// Anthropic requires alternating user/assistant. The squad canonical
// message stream has separate "tool" entries (one per tool result) which
// must coalesce into a single user message with multiple tool_result
// content blocks. This builder accumulates and flushes on role transitions.
class MessageBuilder {
  private readonly out: MessageParam[] = [];
  private pendingUserBlocks: ContentBlockParam[] | null = null;

  pushUserBlock(block: ContentBlockParam): void {
    if (this.pendingUserBlocks === null) this.pendingUserBlocks = [];
    this.pendingUserBlocks.push(block);
  }

  flushPendingUser(): void {
    if (this.pendingUserBlocks === null) return;
    this.out.push({ role: "user", content: this.pendingUserBlocks });
    this.pendingUserBlocks = null;
  }

  pushAssistant(blocks: ContentBlockParam[]): void {
    this.flushPendingUser();
    this.out.push({ role: "assistant", content: blocks });
  }

  finalize(): MessageParam[] {
    this.flushPendingUser();
    return this.out;
  }
}

// Exported for unit-test access. The factory uses these internally.
export function toAnthropicMessages(
  req: CanonicalRequest,
): { system: string | undefined; messages: MessageParam[] } {
  let system = req.system;
  const builder = new MessageBuilder();

  for (const m of req.messages) {
    switch (m.role) {
      case "system":
        // Concatenate any system messages into the system field — Anthropic
        // doesn't accept system as a conversational role.
        system = system ? `${system}\n\n${m.content}` : m.content;
        continue;
      case "user":
        builder.flushPendingUser();
        builder.pushUserBlock({ type: "text", text: m.content });
        builder.flushPendingUser();
        continue;
      case "tool": {
        const toolResult: ToolResultBlockParam = {
          type: "tool_result",
          tool_use_id: m.toolCallId ?? "",
          content: m.content,
        };
        builder.pushUserBlock(toolResult);
        continue;
      }
      case "assistant": {
        const blocks: ContentBlockParam[] = [];
        if (m.content && m.content.length > 0) {
          blocks.push({ type: "text", text: m.content });
        }
        if (m.toolCalls) {
          for (const tc of m.toolCalls) {
            const input =
              typeof tc.args === "object" && tc.args !== null
                ? (tc.args as Record<string, unknown>)
                : tryParseJson(tc.args) ?? {};
            const block: ToolUseBlockParam = {
              type: "tool_use",
              id: tc.id,
              name: tc.name,
              input,
            };
            blocks.push(block);
          }
        }
        if (blocks.length === 0) {
          // Empty assistant turn — Anthropic rejects empty content arrays.
          // Insert a placeholder text block so resume replays don't fail.
          blocks.push({ type: "text", text: "" });
        }
        builder.pushAssistant(blocks);
        continue;
      }
    }
  }

  return { system, messages: builder.finalize() };
}

function tryParseJson(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function toAnthropicTools(
  tools: CanonicalToolSpec[] | undefined,
  cacheControlOnLast: boolean,
): AnthropicTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  const out: AnthropicTool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as AnthropicTool["input_schema"],
  }));
  if (cacheControlOnLast && out.length > 0) {
    const last = out[out.length - 1]!;
    (last as AnthropicTool & { cache_control?: { type: "ephemeral" } }).cache_control = {
      type: "ephemeral",
    };
  }
  return out;
}

export function systemFieldWithCacheControl(
  system: string | undefined,
  cache: boolean,
): string | TextBlockParam[] | undefined {
  if (!system) return undefined;
  if (!cache) return system;
  return [
    {
      type: "text",
      text: system,
      cache_control: { type: "ephemeral" },
    },
  ];
}

export function mapStopReason(
  reason: StopReason | null | undefined,
): CanonicalFinishReason {
  switch (reason) {
    case "max_tokens":
      return "max_tokens";
    case "tool_use":
      return "tool_use";
    case "refusal":
      return "content_filter";
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
    default:
      return "stop";
  }
}

function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  return status === 408 || status === 429 || status >= 500;
}

function mapErrorEvent(err: unknown): CanonicalEvent {
  if (err instanceof APIError) {
    return {
      type: "error",
      code: err.type ?? `HTTP_${err.status ?? 0}`,
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

interface ActiveToolBlock {
  id: string;
  name: string;
  argsBuffer: string;
  startEmitted: boolean;
}

// Each content block has an index. tool_use blocks track an args buffer,
// text and thinking blocks just stream through. We key by index so an
// interleaved tool_use + text response handles correctly.
type ActiveBlock =
  | { kind: "text"; index: number }
  | { kind: "thinking"; index: number }
  | { kind: "tool_use"; index: number; tool: ActiveToolBlock };

const STREAM_IDLE_TIMEOUT_MS = 120_000;
const IDLE_TIMEOUT_SENTINEL: unique symbol = Symbol("stream-idle-timeout");

export function createLlmMessageProvider(
  opts: LlmMessageProviderOptions,
): LLMProvider {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    ...(opts.baseUrl && { baseURL: opts.baseUrl }),
  });
  const wantsCache = opts.capabilities?.cache_control === true;
  const wantsThinking = opts.capabilities?.thinking === true;

  async function* stream(
    req: CanonicalRequest,
    callOpts?: ProviderCallOptions,
  ): AsyncIterable<CanonicalEvent> {
    const { system, messages } = toAnthropicMessages(req);
    const tools = toAnthropicTools(req.tools, wantsCache);

    const params: MessageCreateParamsStreaming = {
      model: req.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
      stream: true,
    };
    const sysField = systemFieldWithCacheControl(system, wantsCache);
    if (sysField !== undefined) params.system = sysField;
    if (tools) params.tools = tools;
    if (req.temperature !== undefined) params.temperature = req.temperature;
    if (wantsThinking) {
      (params as MessageCreateParamsStreaming & {
        thinking?: { type: "enabled"; budget_tokens: number };
      }).thinking = {
        type: "enabled",
        budget_tokens: DEFAULT_THINKING_BUDGET_TOKENS,
      };
    }

    const requestOpts: { signal?: AbortSignal } = {};
    if (callOpts?.signal) requestOpts.signal = callOpts.signal;

    let response;
    try {
      response = await client.messages.create(params, requestOpts);
    } catch (err: unknown) {
      yield mapErrorEvent(err);
      return;
    }

    const blocks = new Map<number, ActiveBlock>();
    let stopReason: StopReason | null = null;
    let usage: CanonicalUsage | undefined;
    let inputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;
    let outputTokens = 0;

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
        const ev = result.value as RawMessageStreamEvent;

        switch (ev.type) {
          case "message_start": {
            const startUsage = ev.message.usage;
            inputTokens = startUsage.input_tokens;
            cacheCreationTokens = startUsage.cache_creation_input_tokens ?? 0;
            cacheReadTokens = startUsage.cache_read_input_tokens ?? 0;
            outputTokens = startUsage.output_tokens;
            break;
          }
          case "content_block_start": {
            const block = ev.content_block;
            if (block.type === "text") {
              blocks.set(ev.index, { kind: "text", index: ev.index });
            } else if (block.type === "thinking") {
              blocks.set(ev.index, { kind: "thinking", index: ev.index });
            } else if (block.type === "tool_use") {
              const tool: ActiveToolBlock = {
                id: block.id,
                name: block.name,
                argsBuffer: "",
                startEmitted: true,
              };
              blocks.set(ev.index, {
                kind: "tool_use",
                index: ev.index,
                tool,
              });
              yield {
                type: "tool_call_start",
                id: tool.id,
                name: tool.name,
              };
            }
            // Other block kinds (server tool results, citations, redacted
            // thinking) aren't surfaced through the canonical stream — they
            // pass through as opaque content the engine doesn't act on.
            break;
          }
          case "content_block_delta": {
            const active = blocks.get(ev.index);
            if (!active) break;
            const delta = ev.delta;
            if (delta.type === "text_delta" && active.kind === "text") {
              yield { type: "text_delta", text: delta.text };
            } else if (
              delta.type === "thinking_delta" &&
              active.kind === "thinking"
            ) {
              yield { type: "reasoning_delta", text: delta.thinking };
            } else if (
              delta.type === "input_json_delta" &&
              active.kind === "tool_use"
            ) {
              const chunk = delta.partial_json;
              active.tool.argsBuffer += chunk;
              yield {
                type: "tool_call_delta",
                id: active.tool.id,
                argsDelta: chunk,
              };
            }
            // signature_delta and citations_delta intentionally ignored.
            break;
          }
          case "content_block_stop": {
            const active = blocks.get(ev.index);
            if (!active) break;
            if (active.kind === "tool_use") {
              let parsed: unknown = active.tool.argsBuffer;
              if (active.tool.argsBuffer.length > 0) {
                try {
                  parsed = JSON.parse(active.tool.argsBuffer);
                } catch {
                  parsed = active.tool.argsBuffer;
                }
              } else {
                parsed = {};
              }
              yield {
                type: "tool_call_done",
                id: active.tool.id,
                name: active.tool.name,
                args: parsed,
              };
            }
            blocks.delete(ev.index);
            break;
          }
          case "message_delta": {
            stopReason = ev.delta.stop_reason;
            outputTokens = ev.usage.output_tokens;
            // Anthropic also reports cumulative cache values on message_delta;
            // pick up any updates so the final usage row is accurate.
            const md = ev.usage as {
              cache_creation_input_tokens?: number | null;
              cache_read_input_tokens?: number | null;
              input_tokens?: number | null;
            };
            if (md.cache_creation_input_tokens != null) {
              cacheCreationTokens = md.cache_creation_input_tokens;
            }
            if (md.cache_read_input_tokens != null) {
              cacheReadTokens = md.cache_read_input_tokens;
            }
            if (md.input_tokens != null) {
              inputTokens = md.input_tokens;
            }
            break;
          }
          case "message_stop":
            // Final event — usage is already accumulated; finalize below.
            break;
        }
      }
    } catch (err: unknown) {
      yield mapErrorEvent(err);
      return;
    }

    // Anthropic bills cache_creation_input_tokens at full input rate (with
    // a small write surcharge per docs) and cache_read_input_tokens at the
    // 10 percent cached-input rate. squad's CanonicalUsage exposes one
    // cachedInputTokens field, so map cache reads → cachedInputTokens and
    // sum the rest into inputTokens.
    const totalInput = inputTokens + cacheCreationTokens + cacheReadTokens;
    usage = {
      inputTokens: totalInput,
      outputTokens,
      totalTokens: totalInput + outputTokens,
      ...(cacheReadTokens > 0 && { cachedInputTokens: cacheReadTokens }),
    };

    if (usage) yield { type: "usage", usage };
    yield { type: "done", reason: mapStopReason(stopReason) };
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
