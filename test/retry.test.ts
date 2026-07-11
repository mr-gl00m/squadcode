import { describe, expect, it } from "vitest";
import { runTurnWithRetry } from "../src/engine/stream.js";
import { computeRetryDelayMs } from "../src/providers/retry.js";
import type {
  CanonicalEvent,
  CanonicalRequest,
  LLMProvider,
} from "../src/providers/types.js";

const REQ: CanonicalRequest = { model: "m", messages: [] };
const noopSleep = async (): Promise<void> => {};

function scriptedProvider(scripts: CanonicalEvent[][]): {
  provider: LLMProvider;
  calls: () => number;
} {
  let call = 0;
  const provider: LLMProvider = {
    name: "fake",
    // biome-ignore lint/correctness/useYield: fixed script, no awaiting needed
    async *stream() {
      const idx = Math.min(call, scripts.length - 1);
      call += 1;
      for (const ev of scripts[idx] ?? []) yield ev;
    },
    complete: async () => {
      throw new Error("complete is not exercised by these tests");
    },
  };
  return { provider, calls: () => call };
}

async function collect(
  it: AsyncIterable<CanonicalEvent>,
): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const ERR = (retryable: boolean, retryAfterMs?: number): CanonicalEvent => ({
  type: "error",
  code: "RATE_LIMITED",
  message: "429",
  retryable,
  ...(retryAfterMs !== undefined && { retryAfterMs }),
});

describe("computeRetryDelayMs", () => {
  it("falls back to exponential 2s * 2^attempt, capped at 30s", () => {
    expect(computeRetryDelayMs(0)).toBe(2_000);
    expect(computeRetryDelayMs(1)).toBe(4_000);
    expect(computeRetryDelayMs(2)).toBe(8_000);
    expect(computeRetryDelayMs(3)).toBe(16_000);
    expect(computeRetryDelayMs(4)).toBe(30_000); // 32s clamped
    expect(computeRetryDelayMs(9)).toBe(30_000);
  });

  it("honors a server Retry-After over the exponential fallback", () => {
    expect(computeRetryDelayMs(0, 5_000)).toBe(5_000);
    expect(computeRetryDelayMs(3, 1_000)).toBe(1_000);
  });

  it("caps a pathological Retry-After at 60s", () => {
    expect(computeRetryDelayMs(0, 3_600_000)).toBe(60_000);
  });

  it("ignores a negative/invalid Retry-After and uses the fallback", () => {
    expect(computeRetryDelayMs(0, -5)).toBe(2_000);
    expect(computeRetryDelayMs(1, Number.NaN)).toBe(4_000);
  });
});

describe("runTurnWithRetry", () => {
  it("retries a clean pre-content retryable error, then yields the success", async () => {
    const { provider, calls } = scriptedProvider([
      [ERR(true)],
      [
        { type: "text_delta", text: "hi" },
        { type: "done", reason: "stop" },
      ],
    ]);
    const events = await collect(
      runTurnWithRetry(provider, REQ, { sleepFn: noopSleep }),
    );
    expect(events.map((e) => e.type)).toEqual(["text_delta", "done"]);
    expect(calls()).toBe(2);
  });

  it("does NOT retry once any content was emitted (would duplicate output)", async () => {
    const { provider, calls } = scriptedProvider([
      [{ type: "text_delta", text: "partial" }, ERR(true)],
      [{ type: "text_delta", text: "MUST NOT APPEAR" }],
    ]);
    const events = await collect(
      runTurnWithRetry(provider, REQ, { sleepFn: noopSleep }),
    );
    expect(events.map((e) => e.type)).toEqual(["text_delta", "error"]);
    expect(calls()).toBe(1);
  });

  it("surfaces a non-retryable error immediately without retrying", async () => {
    const { provider, calls } = scriptedProvider([[ERR(false)]]);
    const events = await collect(
      runTurnWithRetry(provider, REQ, { sleepFn: noopSleep }),
    );
    expect(events.map((e) => e.type)).toEqual(["error"]);
    expect(calls()).toBe(1);
  });

  it("gives up after maxRetries and surfaces the final error", async () => {
    const { provider, calls } = scriptedProvider([[ERR(true)]]); // always errors
    const events = await collect(
      runTurnWithRetry(provider, REQ, { sleepFn: noopSleep, maxRetries: 2 }),
    );
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    expect(calls()).toBe(3); // initial + 2 retries
  });

  it("passes the server Retry-After through to the backoff", async () => {
    const delays: number[] = [];
    const { provider } = scriptedProvider([
      [ERR(true, 5_000)],
      [{ type: "done", reason: "stop" }],
    ]);
    await collect(
      runTurnWithRetry(provider, REQ, {
        sleepFn: async (ms) => {
          delays.push(ms);
        },
      }),
    );
    expect(delays).toEqual([5_000]);
  });
});
