import { describe, expect, it } from "vitest";
import {
  extendRapidRun,
  qualifiesAsPasteBurst,
  replaceComposerText,
} from "../src/cli/paste-burst.js";

describe("Windows paste burst coalescing", () => {
  it("recognizes terminal-speed characters followed by return", () => {
    const start = { value: "prefix ", cursor: 7 };
    let run = extendRapidRun(null, "a", 100, start);
    run = extendRapidRun(run, "b", 101, start);
    run = extendRapidRun(run, "c", 102, start);
    expect(qualifiesAsPasteBurst(run, 103)).toBe(true);
  });

  it("does not classify ordinary typing as paste", () => {
    const start = { value: "", cursor: 0 };
    let run = extendRapidRun(null, "a", 100, start);
    run = extendRapidRun(run, "b", 180, start);
    expect(qualifiesAsPasteBurst(run, 181)).toBe(false);
  });

  it("updates a completed placeholder without moving later text", () => {
    expect(
      replaceComposerText(
        { value: "[Pasted Content 3 chars #1] tail", cursor: 34 },
        "[Pasted Content 3 chars #1]",
        "[Pasted Content 20 chars #1]",
      ),
    ).toEqual({ value: "[Pasted Content 20 chars #1] tail", cursor: 35 });
  });
});
