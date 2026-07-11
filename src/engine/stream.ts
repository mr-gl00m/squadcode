import { logger } from "../logger.js";
import {
  computeRetryDelayMs,
  DEFAULT_MAX_RETRIES,
  sleep,
} from "../providers/retry.js";
import type {
  CanonicalEvent,
  CanonicalRequest,
  LLMProvider,
} from "../providers/types.js";

export interface RetryOptions {
  signal?: AbortSignal;
  maxRetries?: number;
  // Injectable for tests so they don't actually wait out the backoff.
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

async function* runTurn(
  provider: LLMProvider,
  req: CanonicalRequest,
  signal?: AbortSignal,
): AsyncIterable<CanonicalEvent> {
  logger.debug(
    {
      provider: provider.name,
      model: req.model,
      messageCount: req.messages.length,
      hasTools: Boolean(req.tools && req.tools.length > 0),
    },
    "turn start",
  );
  let outputChars = 0;
  let toolCallCount = 0;
  let lastReason: string | undefined;
  const callOpts: { signal?: AbortSignal } = {};
  if (signal) callOpts.signal = signal;
  for await (const ev of provider.stream(req, callOpts)) {
    if (ev.type === "text_delta") outputChars += ev.text.length;
    if (ev.type === "tool_call_done") toolCallCount += 1;
    if (ev.type === "done") lastReason = ev.reason;
    yield ev;
  }
  logger.debug(
    {
      provider: provider.name,
      model: req.model,
      outputChars,
      toolCallCount,
      finishReason: lastReason,
    },
    "turn end",
  );
}

// runTurn wrapped with retry/backoff on retryable provider errors. A retry only
// fires when the error is the FIRST event of the turn — i.e. the request failed
// before any content streamed (429s, connection refusals, etc.). Once any event
// has been yielded, re-running the request would duplicate output, so a
// mid-stream error is passed straight through. A server-issued Retry-After is
// honored over the exponential fallback; on exhaustion (or a non-retryable
// error) the error event surfaces normally and the loop stops on it.
export async function* runTurnWithRetry(
  provider: LLMProvider,
  req: CanonicalRequest,
  opts: RetryOptions = {},
): AsyncIterable<CanonicalEvent> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const doSleep = opts.sleepFn ?? sleep;
  for (let attempt = 0; ; attempt += 1) {
    let yielded = false;
    let retryDelayMs: number | null = null;
    for await (const ev of runTurn(provider, req, opts.signal)) {
      if (
        !yielded &&
        ev.type === "error" &&
        ev.retryable &&
        attempt < maxRetries
      ) {
        retryDelayMs = computeRetryDelayMs(attempt, ev.retryAfterMs);
        logger.warn(
          {
            provider: provider.name,
            model: req.model,
            attempt: attempt + 1,
            maxRetries,
            retryDelayMs,
            code: ev.code,
          },
          "retryable provider error before any output; backing off",
        );
        break;
      }
      yielded = true;
      yield ev;
    }
    if (retryDelayMs === null) return;
    await doSleep(retryDelayMs, opts.signal);
    if (opts.signal?.aborted) return;
  }
}
