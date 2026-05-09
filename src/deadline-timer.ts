// AbortController wrapper with a remaining-time budget that supports pause,
// resume, and dynamic extension. The pause-during-confirmation case is the
// reason it exists: while a permission prompt blocks waiting for user input,
// the wall-clock budget shouldn't bleed.

const DEFAULT_REASON = "Timeout exceeded.";

export class DeadlineTimer {
  private readonly controller: AbortController;
  private timeoutId: NodeJS.Timeout | null = null;
  private remainingMs: number;
  private lastStartedAt: number;
  private isPaused = false;

  constructor(timeoutMs: number, reason: string = DEFAULT_REASON) {
    this.controller = new AbortController();
    this.remainingMs = timeoutMs;
    this.lastStartedAt = Date.now();
    this.schedule(timeoutMs, reason);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  pause(): void {
    if (this.isPaused || this.controller.signal.aborted) return;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    const elapsed = Date.now() - this.lastStartedAt;
    this.remainingMs = Math.max(0, this.remainingMs - elapsed);
    this.isPaused = true;
  }

  resume(reason: string = DEFAULT_REASON): void {
    if (!this.isPaused || this.controller.signal.aborted) return;
    this.lastStartedAt = Date.now();
    this.schedule(this.remainingMs, reason);
    this.isPaused = false;
  }

  extend(ms: number, reason: string = DEFAULT_REASON): void {
    if (this.controller.signal.aborted) return;
    if (this.isPaused) {
      this.remainingMs += ms;
    } else {
      if (this.timeoutId) clearTimeout(this.timeoutId);
      const elapsed = Date.now() - this.lastStartedAt;
      this.remainingMs = Math.max(0, this.remainingMs - elapsed) + ms;
      this.lastStartedAt = Date.now();
      this.schedule(this.remainingMs, reason);
    }
  }

  abort(reason?: unknown): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.isPaused = false;
    this.controller.abort(reason);
  }

  private schedule(ms: number, reason: string): void {
    this.timeoutId = setTimeout(() => {
      this.timeoutId = null;
      this.controller.abort(new Error(reason));
    }, ms);
  }
}
