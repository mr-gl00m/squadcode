import OpenAI, { APIError } from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { ProviderError } from "../errors.js";
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

export interface OllamaProviderOptions {
  baseUrl: string;
}

function toOllamaBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const pathname = url.pathname.replace(/\/$/, "");
  if (pathname !== "/v1" && !pathname.endsWith("/v1")) {
    url.pathname = `${pathname}/v1`;
  }
  return url.toString();
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
      parameters: t.inputSchema,
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

interface PendingToolCall {
  id: string;
  name: string;
  argsBuffer: string;
  startEmitted: boolean;
}

export function createOllamaProvider(opts: OllamaProviderOptions): LLMProvider {
  const client = new OpenAI({
    apiKey: "ollama",
    baseURL: toOllamaBaseUrl(opts.baseUrl),
  });

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

    let response;
    try {
      response = await client.chat.completions.create(params, requestOpts);
    } catch (err: unknown) {
      yield mapErrorEvent(err);
      return;
    }

    const pending = new Map<number, PendingToolCall>();
    let finishReason: CanonicalFinishReason = "stop";
    let usage: CanonicalUsage | undefined;

    try {
      for await (const chunk of response) {
        const choice = chunk.choices[0];
        const delta = choice?.delta;

        if (delta?.content) {
          yield { type: "text_delta", text: delta.content };
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
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            totalTokens: chunk.usage.total_tokens ?? 0,
          };
        }
      }
    } catch (err: unknown) {
      yield mapErrorEvent(err);
      return;
    }

    for (const entry of pending.values()) {
      let parsed: unknown = entry.argsBuffer;
      if (entry.argsBuffer) {
        try {
          parsed = JSON.parse(entry.argsBuffer);
        } catch {
          parsed = entry.argsBuffer;
        }
      } else {
        parsed = {};
      }
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
    name: "ollama",
    stream,
    complete,
  };
}
