import { describe, expect, it } from "vitest";
import { repairToolArgs } from "../../src/providers/arg-repair.js";

// BH-2026-07-12: balanceBraces counted brace/bracket deltas separately and
// appended all `]` before all `}`. That order is only correct when every array
// is outer to every object. When an object is the innermost unclosed structure
// (an object nested inside an array), the appended `]` closes before the inner
// `}`, producing invalid JSON, so a recoverable partial tool-argument buffer
// collapsed to `{}` and the tool executed with empty args.
describe("arg-repair: object nested inside an unclosed array", () => {
  it("closes an object-in-array in LIFO order, not brackets-before-braces", () => {
    expect(repairToolArgs("[{")).toEqual([{}]);
  });

  it("recovers a streamed tool arg cut mid object-in-array", () => {
    expect(repairToolArgs('{"edits":[{"old":"x"')).toEqual({
      edits: [{ old: "x" }],
    });
  });

  it("recovers deeper interleaved array/object nesting", () => {
    expect(repairToolArgs('{"a":[{"b":[')).toEqual({ a: [{ b: [] }] });
  });

  it("still repairs the array-outer case it already handled", () => {
    expect(repairToolArgs('{"items": ["foo[bar"')).toEqual({
      items: ["foo[bar"],
    });
  });
});
