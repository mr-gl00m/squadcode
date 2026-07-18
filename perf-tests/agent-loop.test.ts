// Latency baseline: time a synthetic 3-turn agent-loop run (offline, scripted
// provider) against a committed reference number.
//
// Wall-clock is machine-dependent, so this is advisory, not a hard gate (see
// docs/release-confidence.md). By default it only fails on a catastrophic
// blowup. SQUAD_BENCH_STRICT=1 enforces the regression tolerance against the
// committed baseline; SQUAD_BENCH_UPDATE=1 rewrites the baseline on this machine.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { GoldenFixture } from "../integration-tests/golden/harness.js";
import { runGolden } from "../integration-tests/golden/harness.js";

const BASELINE = fileURLToPath(new URL("./baseline.json", import.meta.url));
const UPDATE = process.env.SQUAD_BENCH_UPDATE === "1";
const STRICT = process.env.SQUAD_BENCH_STRICT === "1";

const ITERATIONS = 25;
const REGRESSION_TOLERANCE = 2.5; // strict: fail above 2.5x baseline
const CATASTROPHIC_CEILING_MS = 2000; // default: only a total blowup fails

function readBaseline(): Record<string, number> {
  if (!existsSync(BASELINE)) return {};
  return JSON.parse(readFileSync(BASELINE, "utf-8")) as Record<string, number>;
}

function writeBaseline(b: Record<string, number>): void {
  writeFileSync(BASELINE, `${JSON.stringify(b, null, 2)}\n`);
}

function threeTurnFixture(): GoldenFixture {
  return {
    name: "perf-3-turn",
    turns: [
      [
        { type: "text_delta", text: "step one" },
        { type: "tool_call_done", id: "a", name: "echo", args: { n: 1 } },
        { type: "done", reason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "step two" },
        { type: "tool_call_done", id: "b", name: "echo", args: { n: 2 } },
        { type: "done", reason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "wrap up" },
        { type: "done", reason: "stop" },
      ],
    ],
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2
    ? (s[m] as number)
    : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

describe("agent-loop latency baseline (synthetic 3-turn, offline)", () => {
  it("runs the loop within the latency budget", async () => {
    // warm up the JIT / module graph before sampling
    await runGolden(threeTurnFixture());

    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      const t0 = performance.now();
      const { provider } = await runGolden(threeTurnFixture());
      samples.push(performance.now() - t0);
      expect(provider.turnsConsumed).toBe(3);
    }
    const med = Math.round(median(samples) * 1000) / 1000;

    const baseline = readBaseline();
    const key = "agentLoop3TurnMedianMs";
    const ref = baseline[key];

    if (UPDATE || ref === undefined) {
      baseline[key] = med;
      writeBaseline(baseline);
      console.log(`[bench] ${key} baseline set to ${med}ms`);
    } else {
      const ratio = ref > 0 ? med / ref : 0;
      console.log(
        `[bench] ${key}: ${med}ms vs baseline ${ref}ms (${ratio.toFixed(2)}x)`,
      );
      if (STRICT && ref > 0) {
        expect(med).toBeLessThanOrEqual(ref * REGRESSION_TOLERANCE);
      }
    }

    expect(med).toBeLessThan(CATASTROPHIC_CEILING_MS);
  });
});
