// Invariant: the JSON-argument repair ladder (src/providers/arg-repair.ts)
// must handle braces and brackets inside JSON string values the same way
// stripTrailingCommas does after BH-2026-05-10-003 — by tracking string
// context. The whole ladder exists to recover malformed tool-call args from
// streaming providers; counting brace deltas blind to string context
// undercounts and leaves real shape errors unrepaired.
// Violation: balanceBraces (src/providers/arg-repair.ts:173) and
// stripExcessClosers (line 195) both walk character-by-character counting
// `{`, `}`, `[`, `]` without an inString state. A literal `{` or `}` inside
// a JSON string value is counted as a structural brace. When the outer
// object is missing its closing `}` but a string value contains an `{` or
// `}`, the brace counts appear balanced and no closer is appended.
// Predicted failure: repairToolArgs on `{"path": "foo{bar.ts"` (unclosed
// outer object, string value contains `{`) cannot recover and falls back to
// `{}` — losing the `path` argument the caller intended to supply.
import { describe, expect, it } from "vitest";
import { repairToolArgs } from "../../src/providers/arg-repair.js";

describe("BH-2026-05-20-104: arg-repair brace balancing is not string-context aware", () => {
  it("recovers an unclosed outer object whose string value contains a literal `{`", () => {
    // The model intended to emit {"path": "foo{bar.ts"} but the streaming
    // chunk terminated before the final `}`. balanceBraces should add it.
    const malformed = '{"path": "foo{bar.ts"';
    const repaired = repairToolArgs(malformed);
    // After repair we expect a real object with the `path` key.
    expect(repaired).toEqual({ path: "foo{bar.ts" });
  });

  it("recovers an unclosed outer object whose string value contains a literal `}`", () => {
    const malformed = '{"message": "ok}done"';
    const repaired = repairToolArgs(malformed);
    expect(repaired).toEqual({ message: "ok}done" });
  });

  it("recovers an unclosed array whose string element contains `[` or `]`", () => {
    const malformed = '{"items": ["foo[bar"';
    const repaired = repairToolArgs(malformed);
    expect(repaired).toEqual({ items: ["foo[bar"] });
  });
});
