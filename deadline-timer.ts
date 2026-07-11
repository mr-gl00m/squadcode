// A pausable elapsed-time tracker. Rebuilt — the v1.1.x src/deadline-timer.ts
// (an AbortController wrapper) was pruned on 2026-05-28 as unwired; this is its
// caller-driven replacement, scoped to exactly what the timer registry needs.
//
// It holds no setTimeout and fires no callback. "Expired" is a question asked at
// a turn boundary against a supplied clock (nowMs), not an event — so the loop
// drains expired timers when it next gets control rather than being interrupted
// mid-turn, and tests stay deterministic by passing their own clock. pause/
// resume exist so a timer doesn't "tick" while the session is paused for user
// input or a compaction (elapsed excludes paused spans).
export interface DeadlineTimer {
  readonly id: string;
  readonly label: string;
  readonly durationMs: number;
  readonly paused: boolean;
  elapsedMs(nowMs: number): number;
  remainingMs(nowMs: number): number;
  expired(nowMs: number): boolean;
  pause(nowMs: number): void;
  resume(nowMs: number): void;
}

export interface DeadlineTimerOptions {
  id: string;
  label: string;
  durationMs: number;
  startedAtMs: number;
}

export function createDeadlineTimer(opts: DeadlineTimerOptions): DeadlineTimer {
  const { id, label, durationMs, startedAtMs } = opts;
  let pausedAccumMs = 0;
  let pausedAtMs: number | null = null;

  function elapsed(nowMs: number): number {
    const gross = Math.max(0, nowMs - startedAtMs);
    const pausedNow = pausedAtMs !== null ? Math.max(0, nowMs - pausedAtMs) : 0;
    return Math.max(0, gross - pausedAccumMs - pausedNow);
  }

  return {
    id,
    label,
    durationMs,
    get paused(): boolean {
      return pausedAtMs !== null;
    },
    elapsedMs: elapsed,
    remainingMs: (nowMs) => Math.max(0, durationMs - elapsed(nowMs)),
    expired: (nowMs) => elapsed(nowMs) >= durationMs,
    pause: (nowMs) => {
      if (pausedAtMs === null) pausedAtMs = nowMs;
    },
    resume: (nowMs) => {
      if (pausedAtMs !== null) {
        pausedAccumMs += Math.max(0, nowMs - pausedAtMs);
        pausedAtMs = null;
      }
    },
  };
}
