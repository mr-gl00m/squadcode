// Provider error taxonomy. Centralizes the retryable/terminal/model-visible
// decision the three adapters (llm-chat, llm-message, llm-response) each used
// to hand-roll as a private `isRetryableStatus` + `mapErrorEvent` pair.
//
// SDK-agnostic on purpose. The OpenAI and Anthropic SDKs both throw an
// APIError carrying status/message/code|type/headers, but importing either
// here would couple the taxonomy to one vendor — against the vendor-neutral
// abstraction rule. Instead the classifier duck-types the fields it needs off
// `unknown`, so a raw fetch failure, a Node network errno, or either SDK's
// APIError all classify through the same path.
//
// The core invariant is a three-way partition: every classified error is
// exactly one of
//   - retryable     — the loop backs off and retries the SAME request
//   - model-visible — the loop feeds the error text back so the MODEL can
//                     change its output and try again
//   - terminal      — the loop stops and the user sees it
// No kind is both retryable and model-visible. `terminal` is the absence of
// both. `classifyProviderError` exposes the partition as a `modelVisible` flag;
// the loop's recovery branch that would consume it is not built yet.

import type { CanonicalEvent } from "./types.js";

export type ProviderErrorKind =
  | "rate_limited"
  | "server_error"
  | "network"
  | "timeout"
  | "auth"
  | "invalid_request"
  | "model"
  | "content_policy"
  | "parse"
  | "context_length"
  | "other";

export interface ClassifiedProviderError {
  kind: ProviderErrorKind;
  // Stable UPPER_SNAKE code derived from the kind. Surfaced on the canonical
  // error event and on thrown ProviderError.code — more useful to the loop
  // than the raw HTTP_429 the adapters used to emit.
  code: string;
  message: string;
  // HTTP status when the error carried one. Absent for transport failures.
  status?: number;
  // Loop should retry the same request after a backoff.
  retryable: boolean;
  // Loop should feed the error back to the model as a recoverable message.
  modelVisible: boolean;
  // Hint parsed from Retry-After when the upstream rate-limited us.
  retryAfterMs?: number;
}

const KIND_CODE: Record<ProviderErrorKind, string> = {
  rate_limited: "RATE_LIMITED",
  server_error: "SERVER_ERROR",
  network: "NETWORK",
  timeout: "TIMEOUT",
  auth: "AUTH",
  invalid_request: "INVALID_REQUEST",
  model: "MODEL",
  content_policy: "CONTENT_POLICY",
  parse: "PARSE",
  context_length: "CONTEXT_LENGTH",
  other: "OTHER",
};

// The partition table. Keep this the single source of truth — the booleans
// on a ClassifiedProviderError are read straight from here.
const KIND_DISPOSITION: Record<
  ProviderErrorKind,
  { retryable: boolean; modelVisible: boolean }
> = {
  rate_limited: { retryable: true, modelVisible: false },
  server_error: { retryable: true, modelVisible: false },
  network: { retryable: true, modelVisible: false },
  timeout: { retryable: true, modelVisible: false },
  auth: { retryable: false, modelVisible: false },
  model: { retryable: false, modelVisible: false },
  other: { retryable: false, modelVisible: false },
  invalid_request: { retryable: false, modelVisible: true },
  content_policy: { retryable: false, modelVisible: true },
  parse: { retryable: false, modelVisible: true },
  context_length: { retryable: false, modelVisible: true },
};

// Node / undici transport error codes. Connection-level failures retry;
// timeout-class codes route to "timeout" (same disposition, clearer label).
const NETWORK_ERRNO = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ECONNABORTED",
  "EPROTO",
  "UND_ERR_SOCKET",
]);
const TIMEOUT_ERRNO = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

// 400/422 bodies don't carry a stable machine code across providers, so the
// disambiguation is keyword-based on the message + body text. Ordered:
// context-length wins over content-policy when both somehow match, because a
// context overflow is the more actionable signal for the loop.
const CONTEXT_LENGTH_RE =
  /context[_ ]?length|context window|maximum context|too many tokens|maximum.{0,20}tokens|reduce the length|exceed.{0,20}context|input is too long|prompt is too long|string too long|too long for/;
const CONTENT_POLICY_RE =
  /content[_ ]?policy|content management policy|content filter|moderation|safety system|safety guideline|flagged|responsible ai|jailbreak|violat(?:e|es|ion).{0,20}polic/;

function readField(err: unknown, key: string): unknown {
  if (typeof err === "object" && err !== null && key in err) {
    return (err as Record<string, unknown>)[key];
  }
  return undefined;
}

function statusOf(err: unknown): number | undefined {
  const s = readField(err, "status");
  if (typeof s === "number" && Number.isFinite(s)) return s;
  const sc = readField(err, "statusCode");
  if (typeof sc === "number" && Number.isFinite(sc)) return sc;
  return undefined;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  const m = readField(err, "message");
  if (typeof m === "string") return m;
  return String(err);
}

function nameOf(err: unknown): string | undefined {
  const n = readField(err, "name");
  return typeof n === "string" ? n : undefined;
}

// Node attaches a string `code` (ECONNREFUSED, …) to network errors; undici /
// the fetch layer wraps the real error in `cause`, so follow one hop down.
function errnoOf(err: unknown, depth = 0): string | undefined {
  const direct = readField(err, "code");
  if (typeof direct === "string" && /^[A-Z][A-Z0-9_]+$/.test(direct)) {
    return direct;
  }
  if (depth < 3) {
    const cause = readField(err, "cause");
    if (cause !== undefined && cause !== err) return errnoOf(cause, depth + 1);
  }
  return undefined;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (headers === undefined || headers === null) return undefined;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const v = (getter as (n: string) => string | null).call(headers, name);
    return v ?? undefined;
  }
  if (typeof headers === "object") {
    const rec = headers as Record<string, unknown>;
    const v = rec[name] ?? rec[name.toLowerCase()];
    if (typeof v === "string") return v;
    if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  }
  return undefined;
}

function retryAfterMsOf(err: unknown): number | undefined {
  const headers = readField(err, "headers");
  const ra = headerValue(headers, "retry-after");
  if (ra !== undefined) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
    const when = Date.parse(ra);
    if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  }
  const raMs = headerValue(headers, "retry-after-ms");
  if (raMs !== undefined) {
    const ms = Number(raMs);
    if (Number.isFinite(ms)) return Math.max(0, Math.round(ms));
  }
  return undefined;
}

// Build the lowercased haystack the 400-disambiguation regexes scan: the
// message plus any structured body the SDK parsed (`error`) plus loose
// type/code fields.
function bodyText(err: unknown): string {
  const parts: string[] = [messageOf(err)];
  const body = readField(err, "error");
  if (body !== undefined) {
    if (typeof body === "string") {
      parts.push(body);
    } else {
      try {
        parts.push(JSON.stringify(body));
      } catch {
        // circular body — message alone has to carry the signal
      }
    }
  }
  const type = readField(err, "type");
  if (typeof type === "string") parts.push(type);
  const code = readField(err, "code");
  if (typeof code === "string") parts.push(code);
  return parts.join(" ").toLowerCase();
}

function disambiguate400(
  text: string,
): "context_length" | "content_policy" | "invalid_request" {
  if (CONTEXT_LENGTH_RE.test(text)) return "context_length";
  if (CONTENT_POLICY_RE.test(text)) return "content_policy";
  return "invalid_request";
}

function classifyKind(err: unknown): ProviderErrorKind {
  // Local parse failures involve no network and must not be read as transport.
  const name = nameOf(err);
  if (err instanceof SyntaxError || name === "SyntaxError") return "parse";

  const errno = errnoOf(err);
  if (errno && TIMEOUT_ERRNO.has(errno)) return "timeout";
  if (errno && NETWORK_ERRNO.has(errno)) return "network";
  if (name === "AbortError" || name === "TimeoutError") return "timeout";

  const status = statusOf(err);
  if (status === undefined) {
    const msg = messageOf(err).toLowerCase();
    if (msg.includes("timed out") || msg.includes("timeout")) return "timeout";
    if (
      msg.includes("fetch failed") ||
      msg.includes("network") ||
      msg.includes("socket hang up") ||
      msg.includes("econnrefused")
    ) {
      return "network";
    }
    return "other";
  }

  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "model";
  if (status === 413) return "context_length";
  if (status === 400 || status === 422) return disambiguate400(bodyText(err));
  if (status >= 500) return "server_error";
  if (status >= 400) return "invalid_request";
  return "other";
}

export function classifyProviderError(err: unknown): ClassifiedProviderError {
  const kind = classifyKind(err);
  const disposition = KIND_DISPOSITION[kind];
  const result: ClassifiedProviderError = {
    kind,
    code: KIND_CODE[kind],
    message: messageOf(err),
    retryable: disposition.retryable,
    modelVisible: disposition.modelVisible,
  };
  const status = statusOf(err);
  if (status !== undefined) result.status = status;
  if (kind === "rate_limited") {
    const ms = retryAfterMsOf(err);
    if (ms !== undefined) result.retryAfterMs = ms;
  }
  return result;
}

// Replaces the per-adapter mapErrorEvent. Adapters yield this when a provider
// call throws so the loop sees a uniform { code, retryable } on the canonical
// error event.
export function toCanonicalErrorEvent(err: unknown): CanonicalEvent {
  const c = classifyProviderError(err);
  return {
    type: "error",
    code: c.code,
    message: c.message,
    retryable: c.retryable,
    ...(c.retryAfterMs !== undefined && { retryAfterMs: c.retryAfterMs }),
  };
}
