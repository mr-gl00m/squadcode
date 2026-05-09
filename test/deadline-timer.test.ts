import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeadlineTimer } from "../src/deadline-timer.js";

describe("DeadlineTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts after the configured timeout", () => {
    const t = new DeadlineTimer(1000);
    expect(t.signal.aborted).toBe(false);
    vi.advanceTimersByTime(999);
    expect(t.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(t.signal.aborted).toBe(true);
    expect((t.signal.reason as Error).message).toBe("Timeout exceeded.");
  });

  it("uses a custom reason when one is supplied", () => {
    const t = new DeadlineTimer(100, "Tool budget exhausted.");
    vi.advanceTimersByTime(100);
    expect((t.signal.reason as Error).message).toBe("Tool budget exhausted.");
  });

  it("pauses the budget so it does not bleed", () => {
    const t = new DeadlineTimer(1000);
    vi.advanceTimersByTime(400);
    t.pause();
    // While paused, real time advances but the budget stays at 600ms.
    vi.advanceTimersByTime(5000);
    expect(t.signal.aborted).toBe(false);
    t.resume();
    vi.advanceTimersByTime(599);
    expect(t.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(t.signal.aborted).toBe(true);
  });

  it("ignores pause when already paused or aborted", () => {
    const t = new DeadlineTimer(100);
    t.pause();
    t.pause(); // no-op
    t.abort(new Error("manual"));
    t.pause(); // no-op
    expect(t.signal.aborted).toBe(true);
  });

  it("ignores resume when not paused", () => {
    const t = new DeadlineTimer(100);
    t.resume(); // no-op while running
    vi.advanceTimersByTime(100);
    expect(t.signal.aborted).toBe(true);
  });

  it("extends the budget while running", () => {
    const t = new DeadlineTimer(1000);
    vi.advanceTimersByTime(500);
    t.extend(500);
    // Now ~1000ms of budget remaining (500 leftover + 500 extension).
    vi.advanceTimersByTime(999);
    expect(t.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(t.signal.aborted).toBe(true);
  });

  it("extends the budget while paused", () => {
    const t = new DeadlineTimer(1000);
    vi.advanceTimersByTime(300);
    t.pause();
    t.extend(500);
    // Resumed budget: 700 leftover + 500 extension = 1200ms.
    t.resume();
    vi.advanceTimersByTime(1199);
    expect(t.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(t.signal.aborted).toBe(true);
  });

  it("does nothing on extend after abort", () => {
    const t = new DeadlineTimer(100);
    t.abort(new Error("manual"));
    t.extend(1000);
    expect(t.signal.aborted).toBe(true);
  });

  it("aborts immediately with a custom reason on manual abort", () => {
    const t = new DeadlineTimer(10000);
    const reason = new Error("user cancelled");
    t.abort(reason);
    expect(t.signal.aborted).toBe(true);
    expect(t.signal.reason).toBe(reason);
  });

  it("survives extend(ms) call when ms exceeds elapsed", () => {
    const t = new DeadlineTimer(100);
    vi.advanceTimersByTime(50);
    t.extend(200);
    // 50 leftover + 200 extend = 250ms total remaining.
    vi.advanceTimersByTime(249);
    expect(t.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(t.signal.aborted).toBe(true);
  });

  it("clamps remainingMs to 0 when elapsed >= original", () => {
    const t = new DeadlineTimer(100);
    // Pausing AFTER the budget should have fired is a race the timer code
    // guards against by clamping. The setTimeout already aborted, so pause
    // is a no-op.
    vi.advanceTimersByTime(150);
    expect(t.signal.aborted).toBe(true);
    t.pause();
    t.resume();
    expect(t.signal.aborted).toBe(true);
  });
});
