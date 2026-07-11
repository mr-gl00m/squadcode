import { describe, expect, it } from "vitest";
import { formatReplay, parseReplayLimit } from "../src/cli/replay.js";
import type { CanonicalMessage } from "../src/providers/types.js";

const u = (content: string): CanonicalMessage => ({ role: "user", content });
const a = (
  content: string,
  toolCalls?: { id: string; name: string; args: unknown }[],
): CanonicalMessage => ({
  role: "assistant",
  content,
  ...(toolCalls && { toolCalls }),
});
const tc = (name: string) => ({ id: name, name, args: {} });

describe("parseReplayLimit", () => {
  it("defaults to 5 for missing or invalid input", () => {
    expect(parseReplayLimit("")).toBe(5);
    expect(parseReplayLimit("abc")).toBe(5);
    expect(parseReplayLimit("0")).toBe(5);
    expect(parseReplayLimit("-3")).toBe(5);
  });

  it("parses a positive count and caps at 50", () => {
    expect(parseReplayLimit("3")).toBe(3);
    expect(parseReplayLimit("999")).toBe(50);
  });
});

describe("formatReplay", () => {
  it("reports when there are no turns to replay", () => {
    expect(formatReplay([], "abc12345", 5)).toContain("no turns to replay");
    expect(formatReplay([a("hi")], "abc12345", 5)).toContain(
      "no turns to replay",
    );
  });

  it("shows only the last N turns", () => {
    const msgs = [
      u("turn one"),
      a("ans one"),
      u("turn two"),
      a("ans two"),
      u("turn three"),
      a("ans three"),
    ];
    const out = formatReplay(msgs, "sess", 2);
    expect(out).toContain("last 2 turns");
    expect(out).not.toContain("turn one");
    expect(out).toContain("turn two");
    expect(out).toContain("turn three");
  });

  it("lists tool-call names under the assistant line", () => {
    const out = formatReplay(
      [u("do it"), a("working", [tc("Read"), tc("Grep")])],
      "sess",
      5,
    );
    expect(out).toContain("▸ you: do it");
    expect(out).toContain("Read · Grep");
  });

  it("singularizes a single turn and collapses whitespace", () => {
    const out = formatReplay([u("line\n\nwith   breaks"), a("ok")], "sess", 5);
    expect(out).toContain("last 1 turn ");
    expect(out).toContain("line with breaks");
  });
});
