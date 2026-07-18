import { describe, expect, it } from "vitest";
import {
  describeRecord,
  formatLedgerCounts,
  formatLedgerSummary,
  ledgerCounts,
  ledgerDelta,
  ledgerInterrupt,
  ledgerResult,
  ledgerRun,
  ledgerStart,
  ledgerWindow,
  liveRowText,
  replayEntries,
  resultLineTag,
  type ToolCallRecord,
} from "../src/cli/tool-ledger.js";

// Drive the ledger the way the turn controller does: start -> deltas ->
// run (args parsed) -> result.
function completedCall(
  ledger: readonly ToolCallRecord[],
  id: string,
  name: string,
  preview: string,
  result: Parameters<typeof ledgerResult>[3],
): readonly ToolCallRecord[] {
  let next: readonly ToolCallRecord[] = ledgerStart(ledger, id, name);
  next = ledgerRun(next, id, name, preview);
  return ledgerResult(next, id, name, result);
}

describe("tool ledger lifecycle", () => {
  it("tracks a call from preparing through ok", () => {
    let ledger: readonly ToolCallRecord[] = ledgerStart([], "c1", "Shell");
    expect(ledger[0]).toMatchObject({
      id: "c1",
      name: "Shell",
      status: "preparing",
      argBytes: 0,
    });

    ledger = ledgerDelta(ledger, "c1", 24);
    ledger = ledgerDelta(ledger, "c1", 8);
    expect(ledger[0]?.argBytes).toBe(32);

    ledger = ledgerRun(ledger, "c1", "Shell", "ran git status");
    expect(ledger[0]).toMatchObject({
      status: "running",
      preview: "ran git status",
    });

    ledger = ledgerResult(ledger, "c1", "Shell", { ok: true });
    expect(ledger[0]?.status).toBe("ok");
    expect(ledger).toHaveLength(1);
  });

  it("keeps parallel calls separate and matches results by id", () => {
    let ledger: readonly ToolCallRecord[] = ledgerStart([], "a", "Shell");
    ledger = ledgerRun(ledger, "a", "Shell", "ran git log");
    ledger = ledgerStart(ledger, "b", "Glob");
    ledger = ledgerRun(ledger, "b", "Glob", "matched **/*parser*");

    // Results arrive out of order.
    ledger = ledgerResult(ledger, "b", "Glob", { ok: true });
    ledger = ledgerResult(ledger, "a", "Shell", {
      ok: false,
      error: "EXIT_1",
    });

    expect(ledger.map((r) => r.status)).toEqual(["failed", "ok"]);
    expect(ledger[0]?.error).toBe("EXIT_1");
  });

  it("tolerates duplicate call ids by resolving the most recent open call", () => {
    let ledger: readonly ToolCallRecord[] = completedCall(
      [],
      "dup",
      "Read",
      "read a.ts",
      { ok: true },
    );
    ledger = ledgerStart(ledger, "dup", "Read");
    ledger = ledgerRun(ledger, "dup", "Read", "read b.ts");
    ledger = ledgerResult(ledger, "dup", "Read", { ok: true });

    expect(ledger).toHaveLength(2);
    expect(ledger.map((r) => r.preview)).toEqual(["read a.ts", "read b.ts"]);
    // seq stays unique for render keys even with duplicate ids.
    expect(new Set(ledger.map((r) => r.seq)).size).toBe(2);
  });

  it("records a result that arrives without a start (recovered calls)", () => {
    const ledger = ledgerResult([], "ghost", "Grep", {
      ok: false,
      error: "GREP_BAD_REGEX",
    });
    expect(ledger[0]).toMatchObject({
      id: "ghost",
      name: "Grep",
      status: "failed",
      error: "GREP_BAD_REGEX",
    });
    expect(describeRecord(ledger[0] as ToolCallRecord)).toBe(
      "[Grep] called · failed (GREP_BAD_REGEX)",
    );
  });

  it("marks still-open calls interrupted at turn end and is a no-op otherwise", () => {
    let ledger: readonly ToolCallRecord[] = ledgerStart([], "x", "Shell");
    ledger = ledgerRun(ledger, "x", "Shell", "ran npm test");
    const interrupted = ledgerInterrupt(ledger);
    expect(interrupted[0]?.status).toBe("interrupted");

    const settled = ledgerResult(ledger, "x", "Shell", { ok: true });
    // Reference-stable when nothing is open, so setState skips a render.
    expect(ledgerInterrupt(settled)).toBe(settled);
  });

  it("ignores deltas for unknown or already-running calls", () => {
    let ledger: readonly ToolCallRecord[] = ledgerStart([], "d", "Grep");
    ledger = ledgerRun(ledger, "d", "Grep", "searched foo");
    const before = ledger;
    expect(ledgerDelta(ledger, "d", 10)).toBe(before);
    expect(ledgerDelta(ledger, "nope", 10)).toBe(before);
  });

  it("sanitizes model-controlled strings at insertion", () => {
    let ledger: readonly ToolCallRecord[] = ledgerStart(
      [],
      "evil",
      "Sh\x1b[31mell",
    );
    expect(ledger[0]?.name).toBe("Shell");
    ledger = ledgerRun(ledger, "evil", "Shell", "ran \x1b]0;pwn\x07echo hi");
    expect(ledger[0]?.preview).not.toContain("\x1b");
  });
});

describe("result tags and merged lines", () => {
  it("keeps tag parity with the detailed transcript lines", () => {
    expect(resultLineTag({ ok: true })).toBe("ok");
    expect(resultLineTag({ ok: false, reason: "denied" })).toBe("denied");
    expect(resultLineTag({ ok: false, reason: "aborted" })).toBe("aborted");
    expect(resultLineTag({ ok: false, reason: "unknown_tool" })).toBe(
      "unknown",
    );
    expect(resultLineTag({ ok: false, error: "GREP_BAD_REGEX" })).toBe(
      "failed (GREP_BAD_REGEX)",
    );
    expect(resultLineTag({ ok: false })).toBe("failed");
  });

  it("describes each lifecycle stage on one line", () => {
    let ledger: readonly ToolCallRecord[] = ledgerStart([], "c", "Grep");
    ledger = ledgerDelta(ledger, "c", 46);
    expect(describeRecord(ledger[0] as ToolCallRecord)).toBe(
      "[Grep] preparing arguments (46 B)",
    );
    expect(liveRowText(ledger[0] as ToolCallRecord)).toBe(
      "[Grep] preparing arguments (46 B)",
    );

    ledger = ledgerRun(ledger, "c", "Grep", "searched parse in src");
    expect(describeRecord(ledger[0] as ToolCallRecord)).toBe(
      "[Grep] searched parse in src · running",
    );
    // Live rows drop the tag for running/ok; the glyph carries it.
    expect(liveRowText(ledger[0] as ToolCallRecord)).toBe(
      "[Grep] searched parse in src",
    );

    ledger = ledgerResult(ledger, "c", "Grep", { ok: true });
    expect(describeRecord(ledger[0] as ToolCallRecord)).toBe(
      "[Grep] searched parse in src · ok",
    );
  });
});

describe("rollups and windows", () => {
  function mixedLedger(): readonly ToolCallRecord[] {
    let ledger: readonly ToolCallRecord[] = [];
    ledger = completedCall(ledger, "1", "Shell", "ran a", { ok: true });
    ledger = completedCall(ledger, "2", "Shell", "ran b", { ok: true });
    ledger = completedCall(ledger, "3", "Grep", "searched x", {
      ok: false,
      error: "GREP_BAD_REGEX",
    });
    ledger = completedCall(ledger, "4", "Shell", "ran c", {
      ok: false,
      reason: "denied",
    });
    ledger = completedCall(ledger, "5", "Zap", "called", {
      ok: false,
      reason: "unknown_tool",
    });
    return ledger;
  }

  it("counts by outcome and formats only nonzero buckets", () => {
    const counts = ledgerCounts(mixedLedger());
    expect(counts).toMatchObject({
      total: 5,
      ok: 2,
      failed: 1,
      denied: 1,
      unknown: 1,
      aborted: 0,
      active: 0,
    });
    expect(formatLedgerCounts(counts)).toBe(
      "2 ok · 1 failed · 1 unknown-tool · 1 denied",
    );
  });

  it("builds the turn-close summary and returns null for tool-free turns", () => {
    expect(formatLedgerSummary([])).toBeNull();
    expect(formatLedgerSummary(mixedLedger())).toBe(
      "5 tool calls · 2 ok · 1 failed · 1 unknown-tool · 1 denied",
    );
    const single = completedCall([], "1", "Shell", "ran a", { ok: true });
    expect(formatLedgerSummary(single)).toBe("1 tool call · 1 ok");
  });

  it("windows the live view and summarizes what scrolled out", () => {
    const full = mixedLedger();
    const noOverflow = ledgerWindow(full, 6);
    expect(noOverflow.hidden).toBeNull();
    expect(noOverflow.visible).toHaveLength(5);

    const windowed = ledgerWindow(full, 2);
    expect(windowed.visible.map((r) => r.id)).toEqual(["4", "5"]);
    expect(windowed.hidden).toMatchObject({ total: 3, ok: 2, failed: 1 });
  });

  it("replays merged lines with error kind on failures", () => {
    const entries = replayEntries(mixedLedger());
    expect(entries).toHaveLength(5);
    expect(entries[0]).toEqual({ kind: "tool", text: "[Shell] ran a · ok" });
    expect(entries[2]).toEqual({
      kind: "error",
      text: "[Grep] searched x · failed (GREP_BAD_REGEX)",
    });
    expect(entries[3]?.kind).toBe("error");
    expect(entries[4]?.kind).toBe("error");
  });
});
