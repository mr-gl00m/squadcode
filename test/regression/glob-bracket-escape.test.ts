// Invariant: matchesGlob accepts any string as a glob pattern and returns a
// boolean. The Glob, Grep, and IndexList tool docstrings claim to "list files
// matching a glob pattern" — passing a syntactically odd pattern should
// return false (no match), not crash.
// Violation: src/tools/scan.ts:57 (compileGlob) escapes regex metacharacters
// `.+^$()|{}\` but NOT `[` or `]`. A glob pattern containing a literal `[`
// without a matching `]` produces a malformed regex source, and `new RegExp`
// throws SyntaxError. matchesGlob does not catch this, so the entire tool
// call rejects with a regex syntax error rather than returning false.
// Predicted failure: matchesGlob("src/foo.ts", "src/[broken") throws
// SyntaxError; the assertion that it returns a boolean fails.
import { describe, expect, it } from "vitest";
import { compileGlob, matchesGlob } from "../../src/tools/scan.js";

describe("BH-2026-05-20-103: compileGlob crashes on unescaped [ in pattern", () => {
  it("matchesGlob returns a boolean for any glob pattern (does not throw on `[`)", () => {
    // A glob with a literal `[` and no `]` is unusual but possible — the
    // model could emit it by accident, or a filename literally contains it.
    // The current implementation throws SyntaxError. A correct implementation
    // returns false (or matches a file literally containing `[`).
    expect(() => matchesGlob("src/foo.ts", "src/[broken")).not.toThrow();
  });

  it("compileGlob does not throw on `[`", () => {
    expect(() => compileGlob("foo[bar")).not.toThrow();
  });
});
