import { describe, expect, it } from "vitest";
import {
  AUTO_COMPACT_THRESHOLD,
  DEFAULT_TAIL_TURNS,
  STRUCTURED_SUMMARIZER_PROMPT,
  findTailStart,
  shouldAutoCompact,
} from "../src/engine/auto-compact.js";

describe("shouldAutoCompact", () => {
  it("returns false when contextWindow is null", () => {
    expect(shouldAutoCompact(100_000, null)).toBe(false);
  });

  it("returns false when contextWindow is zero or negative", () => {
    expect(shouldAutoCompact(100_000, 0)).toBe(false);
    expect(shouldAutoCompact(100_000, -1)).toBe(false);
  });

  it("returns false below the threshold", () => {
    const ctx = 100_000;
    expect(shouldAutoCompact(0, ctx)).toBe(false);
    expect(shouldAutoCompact(50_000, ctx)).toBe(false);
    expect(shouldAutoCompact(Math.floor(ctx * AUTO_COMPACT_THRESHOLD) - 1, ctx))
      .toBe(false);
  });

  it("returns true at or above the threshold", () => {
    const ctx = 100_000;
    expect(shouldAutoCompact(Math.ceil(ctx * AUTO_COMPACT_THRESHOLD), ctx))
      .toBe(true);
    expect(shouldAutoCompact(ctx, ctx)).toBe(true);
    expect(shouldAutoCompact(ctx + 1, ctx)).toBe(true);
  });
});

describe("findTailStart", () => {
  const m = (role: string) => ({ role });

  it("returns 0 when there are fewer user messages than the tail count", () => {
    expect(findTailStart([m("user"), m("assistant")], 2)).toBe(0);
  });

  it("returns 0 when the message list is empty", () => {
    expect(findTailStart([], 2)).toBe(0);
  });

  it("returns the index of the second-to-last user message for tail=2", () => {
    const messages = [
      m("user"),
      m("assistant"),
      m("user"),
      m("assistant"),
      m("user"),
      m("assistant"),
    ];
    // Three user messages at indices 0, 2, 4. Tail of 2 starts at index 2.
    expect(findTailStart(messages, 2)).toBe(2);
  });

  it("handles the default tail count from DEFAULT_TAIL_TURNS", () => {
    const messages = [
      m("user"),
      m("assistant"),
      m("user"),
      m("assistant"),
      m("user"),
      m("assistant"),
    ];
    expect(findTailStart(messages, DEFAULT_TAIL_TURNS)).toBe(2);
  });

  it("respects tool messages between user messages", () => {
    const messages = [
      m("user"),
      m("assistant"),
      m("tool"),
      m("assistant"),
      m("user"),
      m("assistant"),
    ];
    // Two user messages at indices 0 and 4. Tail of 2 starts at index 0.
    expect(findTailStart(messages, 2)).toBe(0);
  });
});

describe("STRUCTURED_SUMMARIZER_PROMPT", () => {
  it("includes the prescribed section headings", () => {
    expect(STRUCTURED_SUMMARIZER_PROMPT).toContain("## Goal");
    expect(STRUCTURED_SUMMARIZER_PROMPT).toContain("## Constraints & Preferences");
    expect(STRUCTURED_SUMMARIZER_PROMPT).toContain("## Progress");
    expect(STRUCTURED_SUMMARIZER_PROMPT).toContain("### Done");
    expect(STRUCTURED_SUMMARIZER_PROMPT).toContain("### In Progress");
    expect(STRUCTURED_SUMMARIZER_PROMPT).toContain("### Blocked");
    expect(STRUCTURED_SUMMARIZER_PROMPT).toContain("## Open Decisions");
    expect(STRUCTURED_SUMMARIZER_PROMPT).toContain("## Notes");
  });
});
