// User-facing provider identifier from the catalog row's `provider_id`
// field — surfaced as LLMProvider.name and consumed by pricing / cost /
// audit. Common values: "deepseek", "openai", "anthropic", "ollama",
// "groq", "together", "fireworks". Catalog overrides can introduce new
// values, so the type is open.
export type ProviderName = string;

export type CanonicalRole = "system" | "user" | "assistant" | "tool";

export interface CanonicalMessage {
  role: CanonicalRole;
  content: string;
  // Internal marker for centrally-rendered synthetic context. Providers ignore
  // it; the fragment accumulator uses it to replace/deduplicate across turns.
  contextFragmentId?: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: CanonicalToolCall[];
  reasoningContent?: string;
}

export interface CanonicalToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CanonicalRequest {
  model: string;
  messages: CanonicalMessage[];
  system?: string;
  tools?: CanonicalToolSpec[];
  maxTokens?: number;
  temperature?: number;
}

export interface CanonicalUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
}

export type CanonicalFinishReason =
  | "stop"
  | "tool_use"
  | "max_tokens"
  | "content_filter"
  | "error";

export interface CanonicalToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface CanonicalResponse {
  text: string;
  toolCalls: CanonicalToolCall[];
  finishReason: CanonicalFinishReason;
  usage: CanonicalUsage;
}

export type CanonicalEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; argsDelta: string }
  | { type: "tool_call_done"; id: string; name: string; args: unknown }
  | {
      type: "tool_result";
      id: string;
      name: string;
      ok: boolean;
      error?: string;
      reason?: "denied" | "executed" | "unknown_tool" | "aborted";
      content: string;
      artifact?: { path: string; sha256: string; fullSizeBytes: number };
    }
  | { type: "usage"; usage: CanonicalUsage }
  | { type: "done"; reason: CanonicalFinishReason }
  | {
      type: "error";
      code: string;
      message: string;
      retryable: boolean;
      // Server-issued wait hint (from Retry-After / retry-after-ms) when the
      // upstream supplied one. The retry wrapper honors it over its exponential
      // fallback.
      retryAfterMs?: number;
    };

export interface ProviderCallOptions {
  signal?: AbortSignal;
}

export interface ModelInfo {
  id: string;
  contextWindow?: number;
  description?: string;
}

export interface LLMProvider {
  readonly name: ProviderName;
  listModels?(): Promise<ModelInfo[]>;
  stream(
    req: CanonicalRequest,
    opts?: ProviderCallOptions,
  ): AsyncIterable<CanonicalEvent>;
  complete(
    req: CanonicalRequest,
    opts?: ProviderCallOptions,
  ): Promise<CanonicalResponse>;
}
