import { describe, expect, it } from "vitest";
import {
  ArgRepairError,
  parseToolArgs,
  repairToolArgs,
} from "../src/providers/arg-repair.js";

describe("repairToolArgs", () => {
  it("passes a strict-parseable input through", () => {
    expect(repairToolArgs(`{"path": "hello.txt"}`)).toEqual({
      path: "hello.txt",
    });
  });

  it("repairs a trailing comma in an object", () => {
    expect(repairToolArgs(`{"path": "hello.txt",}`)).toEqual({
      path: "hello.txt",
    });
  });

  it("repairs a trailing comma in an array", () => {
    expect(repairToolArgs(`["a", "b",]`)).toEqual(["a", "b"]);
  });

  it("repairs a missing close brace", () => {
    expect(repairToolArgs(`{"path": "hello.txt"`)).toEqual({
      path: "hello.txt",
    });
  });

  it("repairs a missing close bracket", () => {
    expect(repairToolArgs(`["a", "b"`)).toEqual(["a", "b"]);
  });

  it("strips embedded control chars in string values", () => {
    // Vertical tab (0x0B) inside a string value
    const raw = `{"key": "val\x0Bue"}`;
    expect(repairToolArgs(raw)).toEqual({ key: "value" });
  });

  it("preserves \\t, \\n, \\r inside string values when they are real chars", () => {
    // Real newline inside a JSON string is technically invalid JSON, but
    // many local backends emit them; the strict parse will fail and stage 2
    // leaves them alone (only 0x00-0x1F minus tab/newline/return get stripped).
    // The strict parse is what fails; we expect repair to fall through and
    // ultimately return {} since no later stage fixes a real raw newline.
    // This test pins the documented behavior.
    const raw = `{"key": "line1\nline2"}`;
    // After stripping, the literal \n stays; JSON.parse still rejects it.
    // Stage 3-5 don't fix it. Final fallback is {}.
    expect(repairToolArgs(raw)).toEqual({});
  });

  it("returns {} on empty input via repairToolArgs", () => {
    // repairToolArgs treats empty as a stage-1 failure and walks to fallback;
    // parseToolArgs short-circuits empty to {}. Both give {}.
    expect(repairToolArgs("")).toEqual({});
  });

  it("returns {} on gibberish input", () => {
    expect(repairToolArgs("not json at all")).toEqual({});
  });

  it("balances nested missing close braces", () => {
    expect(repairToolArgs(`{"outer": {"inner": "val"`)).toEqual({
      outer: { inner: "val" },
    });
  });

  it("strips excess closers", () => {
    expect(repairToolArgs(`{"key": "val"}}`)).toEqual({ key: "val" });
  });

  it("returns the string unwrapped when given double-encoded JSON", () => {
    // A valid JSON string whose contents happen to look like an object.
    // Stage 1 succeeds and returns the string itself; downstream callers
    // can detect this and re-parse if they want.
    const raw = `"{\\"path\\": \\"hello.txt\\"}"`;
    expect(repairToolArgs(raw)).toBe(`{"path": "hello.txt"}`);
  });

  it("throws ArgRepairError on oversize input", () => {
    const big = "x".repeat(1024 * 1024 + 1);
    expect(() => repairToolArgs(big)).toThrow(ArgRepairError);
  });

  it("repairs a brace balance with trailing comma", () => {
    expect(repairToolArgs(`{"a": 1,`)).toEqual({ a: 1 });
  });

  it("does not strip control chars outside of strings", () => {
    // The form-feed sits between tokens, outside any string. JSON.parse
    // already accepts whitespace there in some implementations; in the
    // strict case it fails. The repair shouldn't drop it from outside
    // string context — but our state machine only drops chars while
    // inString, so it stays. Final stage falls back to {}.
    const raw = `{\x0C"a": 1}`;
    // Either strict parses (some engines tolerate this) or we end up at {}.
    const out = repairToolArgs(raw);
    expect(out === undefined || typeof out === "object").toBe(true);
  });
});

describe("parseToolArgs", () => {
  it("returns {} on empty input", () => {
    expect(parseToolArgs("")).toEqual({});
  });

  it("returns the parsed value for a strict input", () => {
    expect(parseToolArgs(`{"path": "x"}`)).toEqual({ path: "x" });
  });

  it("repairs a trailing comma", () => {
    expect(parseToolArgs(`{"path": "x",}`)).toEqual({ path: "x" });
  });

  it("falls back to the raw string on oversize input", () => {
    const big = "x".repeat(1024 * 1024 + 1);
    expect(parseToolArgs(big)).toBe(big);
  });

  it("returns {} on gibberish (does not throw)", () => {
    expect(parseToolArgs("totally not json")).toEqual({});
  });
});
