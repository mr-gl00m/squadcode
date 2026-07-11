// Backoff policy for retryable provider errors. The error classifier
// (llm-error.ts) already parses Retry-After / retry-after-ms into
// ClassifiedProviderError.retryAfterMs and rides it onto the canonical error
// event; this turns an attempt index (plus that optional server hint) into a
// concrete wait, and provides an abort-aware sleep. The orchestration that
// consumes these lives in engine/stream.ts (runTurnWithRetry).

const BASE_MS = 2_000;
// Ceiling on the exponential fallback: 2s, 4s, 8s, 16s, 30s (32s clamped), …
const EXP_CAP_MS = 30_000;
// A server can legitimately ask for a long Retry-After; honor it, but don't let
// a "retry after 3600" hang the CLI for an hour.
const RETRY_AFTER_CAP_MS = 60_000;

export const DEFAULT_MAX_RETRIES = 5;

// A server-issued Retry-After wins (it's the upstream telling us exactly how
// long to wait), capped. Otherwise fall back to exponential backoff.
export function computeRetryDelayMs(
  attempt: number,
  retryAfterMs?: number,
): number {
  if (
    retryAfterMs !== undefined &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs >= 0
  ) {
    return Math.min(retryAfterMs, RETRY_AFTER_CAP_MS);
  }
  const exp = BASE_MS * 2 ** Math.max(0, attempt);
  return Math.min(exp, EXP_CAP_MS);
}

// setTimeout-based sleep that resolves early (without rejecting) if the signal
// aborts — a mid-backoff Ctrl-C shouldn't have to wait out the full delay.
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
