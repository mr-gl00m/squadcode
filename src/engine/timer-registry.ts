import { createDeadlineTimer, type DeadlineTimer } from "../deadline-timer.js";

// Per-session registry of LLM-set deadline timers. The model calls set-timer to
// plan its own "ping if I'm not done" checks; the loop calls drainExpired at the
// top of each turn and injects a synthetic message for each one that fired. No
// setTimeout anywhere — timers are time-accounting records resolved against a
// clock at turn boundaries (see deadline-timer.ts). Lives across turns within a
// session; cleared on session end.
export interface TimerFired {
  timerId: string;
  label: string;
  elapsedMs: number;
}

export interface TimerView {
  id: string;
  label: string;
  remainingMs: number;
  paused: boolean;
}

export interface TimerRegistry {
  set(label: string, ms: number, nowMs: number): string;
  cancel(timerId: string): boolean;
  list(nowMs: number): TimerView[];
  // Returns and removes every timer that has expired as of nowMs.
  drainExpired(nowMs: number): TimerFired[];
  pauseAll(nowMs: number): void;
  resumeAll(nowMs: number): void;
  clear(): void;
}

export function createTimerRegistry(): TimerRegistry {
  const timers = new Map<string, DeadlineTimer>();
  let seq = 0;

  return {
    set(label: string, ms: number, nowMs: number): string {
      seq += 1;
      const id = `timer_${seq}`;
      timers.set(
        id,
        createDeadlineTimer({ id, label, durationMs: ms, startedAtMs: nowMs }),
      );
      return id;
    },
    cancel: (timerId) => timers.delete(timerId),
    list: (nowMs) =>
      [...timers.values()].map((t) => ({
        id: t.id,
        label: t.label,
        remainingMs: t.remainingMs(nowMs),
        paused: t.paused,
      })),
    drainExpired(nowMs: number): TimerFired[] {
      const fired: TimerFired[] = [];
      for (const [id, timer] of timers) {
        if (timer.expired(nowMs)) {
          fired.push({
            timerId: id,
            label: timer.label,
            elapsedMs: timer.elapsedMs(nowMs),
          });
          timers.delete(id);
        }
      }
      return fired;
    },
    pauseAll: (nowMs) => {
      for (const t of timers.values()) t.pause(nowMs);
    },
    resumeAll: (nowMs) => {
      for (const t of timers.values()) t.resume(nowMs);
    },
    clear: () => timers.clear(),
  };
}
