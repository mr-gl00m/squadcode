// Memory baseline: replay a long transcript through the real agent loop and
// record the retained-heap delta against a committed reference number.
//
// Heap deltas without a forced GC are inherently noisy, so this is an advisory
// signal, not a hard gate (see docs/release-confidence.md). By default it only
// fails on a catastrophic blowup. Run with --expose-gc for a cleaner number,
// SQUAD_BENCH_STRICT=1 to enforce the regression tolerance, and
// SQUAD_BENCH_UPDATE=1 to rewrite the committed baseline on this machine.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { GoldenFixture } from "../integration-tests/golden/harness.js";
import { runGolden } from "../integration-tests/golden/harness.js";
import type { GoldenTurn } from "../integration-tests/golden/replay-provider.js";

const BASELINE = fileURLToPath(new URL("./baseline.json", import.meta.url));
const UPDATE = process.env.SQUAD_BENCH_UPDATE === "1";
const STRICT = process.env.SQUAD_BENCH_STRICT === "1";

const TURNS = 200;
const REGRESSION_TOLERANCE = 2.5; // strict: fail above 2.5x baseline
const CATASTROPHIC_CEILING_MB = 512; // default: only a total blowup fails

function readBaseline(): Record<string, number> {
  if (!existsSync(BASELINE)) return {};
  return JSON.parse(readFileSync(BASELINE, "utf-8")) as Record<string, number>;
}

function writeBaseline(b: Record<string, number>): void {
  writeFileSync(BASELINE, `${JSON.stringify(b, null, 2)}\n`);
}

// A long conversation: each turn emits a chunk of text and a tool call with a
// distinct arg, so the repeat-guard's fresh-signature reset keeps the loop going
// turn after turn (no false halt) and the message history grows the whole way.
function longTranscript(turns: number): GoldenFixture {
  const t: GoldenTurn[] = [];
  for (let i = 0; i < turns - 1; i += 1) {
    t.push([
      { type: "text_delta", text: "x".repeat(256) },
      { type: "tool_call_done", id: `c${i}`, name: "echo", args: { i } },
      { type: "done", reason: "tool_use" },
    ]);
  }
  t.push([
    { type: "text_delta", text: "end" },
    { type: "done", reason: "stop" },
  ]);
  return { name: "mem-long-transcript", turns: t };
}

describe("transcript replay memory baseline", () => {
  it(`replays a ${TURNS}-turn transcript within the memory budget`, async () => {
    const maybeGc = (globalThis as { gc?: () => void }).gc;
    maybeGc?.();
    const before = process.memoryUsage().heapUsed;

    const { provider } = await runGolden(longTranscript(TURNS), {
      maxTurns: TURNS + 5,
    });
    expect(provider.turnsConsumed).toBe(TURNS);

    maybeGc?.();
    const after = process.memoryUsage().heapUsed;
    const deltaMb =
      Math.round((Math.max(0, after - before) / (1024 * 1024)) * 100) / 100;

    const baseline = readBaseline();
    const key = "transcriptReplayHeapMb";
    const ref = baseline[key];

    if (UPDATE || ref === undefined) {
      baseline[key] = deltaMb;
      writeBaseline(baseline);
      console.log(`[bench] ${key} baseline set to ${deltaMb}MB`);
    } else {
      const ratio = ref > 0 ? deltaMb / ref : 0;
      console.log(
        `[bench] ${key}: ${deltaMb}MB vs baseline ${ref}MB (${ratio.toFixed(2)}x)${maybeGc ? "" : " [no --expose-gc; noisy]"}`,
      );
      if (STRICT && ref > 0) {
        expect(deltaMb).toBeLessThanOrEqual(ref * REGRESSION_TOLERANCE);
      }
    }

    expect(deltaMb).toBeLessThan(CATASTROPHIC_CEILING_MB);
  });
});
