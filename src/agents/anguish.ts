// Anguish: a pressure scalar A in [0,1] derived from how a subagent run is
// going — elapsed time against its budget, retry count, consecutive tool
// failures, and a caller-supplied ambiguity signal. Lifted from FETCH §4
// (Anguish-as-observability) but deliberately NOT §5 (Anguish-as-scheduler):
// this value is read-only. It drives the TUI meter and becomes a quantitative
// model-quality signal across vetting runs, but it is never written into the
// model's prompt — modulating the model under test mid-run would contaminate
// the experimental comparison Squad exists to make.

export type AnguishBand = "calm" | "alert" | "urgent" | "terminal";

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

export interface AnguishInputs {
  elapsedMs: number;
  // Soft time budget. Absent or <= 0 => time contributes nothing (an
  // open-ended run can't be "late").
  deadlineMs?: number;
  retries: number;
  // Retry ceiling the scalar normalizes against. Defaults to 8 to line up with
  // the loop's CONSECUTIVE_FAILURE_HALT.
  maxRetries?: number;
  toolFailures: number;
  // Caller-supplied ambiguity in [0,1] — e.g. a scope-expansion signal. The
  // loop has no native source for this yet, so it stays optional.
  ambiguity?: number;
}

// Weighted blend. Failures and time dominate; retries and ambiguity nudge.
// Weights sum to 1 so the result stays in [0,1] before clamping.
export function computeAnguish(inp: AnguishInputs): number {
  const time =
    inp.deadlineMs && inp.deadlineMs > 0
      ? clamp01(inp.elapsedMs / inp.deadlineMs)
      : 0;
  const maxRetries = inp.maxRetries ?? 8;
  const retry = maxRetries > 0 ? clamp01(inp.retries / maxRetries) : 0;
  const fail = clamp01(inp.toolFailures / 8);
  const amb = clamp01(inp.ambiguity ?? 0);
  return clamp01(0.35 * time + 0.25 * retry + 0.3 * fail + 0.1 * amb);
}

export function anguishBand(a: number): AnguishBand {
  if (a >= 0.85) return "terminal";
  if (a >= 0.6) return "urgent";
  if (a >= 0.3) return "alert";
  return "calm";
}

// Accumulates the raw signals over a run and reports the current scalar. Time
// is supplied per call (nowMs) rather than read from a clock so the value is
// deterministic under test.
export interface AnguishTracker {
  recordRetry(): void;
  recordToolFailure(): void;
  // Resets the consecutive-failure streak, mirroring the loop's own reset on a
  // successful or user-denied tool call.
  recordToolSuccess(): void;
  setAmbiguity(value: number): void;
  value(nowMs: number): number;
  band(nowMs: number): AnguishBand;
}

export interface AnguishTrackerOptions {
  startedAtMs: number;
  deadlineMs?: number;
  maxRetries?: number;
}

export function createAnguishTracker(
  opts: AnguishTrackerOptions,
): AnguishTracker {
  let retries = 0;
  let toolFailures = 0;
  let ambiguity = 0;

  function snapshot(nowMs: number): number {
    const inputs: AnguishInputs = {
      elapsedMs: Math.max(0, nowMs - opts.startedAtMs),
      retries,
      toolFailures,
      ambiguity,
    };
    if (opts.deadlineMs !== undefined) inputs.deadlineMs = opts.deadlineMs;
    if (opts.maxRetries !== undefined) inputs.maxRetries = opts.maxRetries;
    return computeAnguish(inputs);
  }

  return {
    recordRetry: () => {
      retries += 1;
    },
    recordToolFailure: () => {
      toolFailures += 1;
    },
    recordToolSuccess: () => {
      toolFailures = 0;
    },
    setAmbiguity: (value: number) => {
      ambiguity = clamp01(value);
    },
    value: (nowMs: number) => snapshot(nowMs),
    band: (nowMs: number) => anguishBand(snapshot(nowMs)),
  };
}
