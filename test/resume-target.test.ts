import { describe, expect, it } from "vitest";
import { pickResumeTarget } from "../src/cli/resume-target.js";
import type { SessionMetadata } from "../src/sessions/types.js";

function sess(
  id: string,
  over: Partial<SessionMetadata> = {},
): SessionMetadata {
  return {
    sessionId: id,
    startedAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    cwd: "/x",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    turnCount: 0,
    totalTokens: 0,
    archived: false,
    ...over,
  };
}

describe("pickResumeTarget — no argument (most recent real conversation)", () => {
  it("skips the empty current session AND empty stubs, lands on the conversation", () => {
    // store.list order is most-recent-first: a fresh launch + a couple of
    // empty relaunch stubs sit above the big session the user actually wants.
    const sessions = [
      sess("current", { turnCount: 0 }),
      sess("stub1", { turnCount: 0 }),
      sess("stub2", { turnCount: 0 }),
      sess("big", { turnCount: 1, totalTokens: 1_200_000 }),
    ];
    expect(pickResumeTarget(sessions, "current", "")).toEqual({
      sessionId: "big",
      turnCount: 1,
    });
  });

  it("counts a session with tokens but a not-yet-bumped turn count as real", () => {
    const sessions = [
      sess("current"),
      sess("big", { turnCount: 0, totalTokens: 999_000 }),
    ];
    expect(pickResumeTarget(sessions, "current", "")).toMatchObject({
      sessionId: "big",
    });
  });

  it("picks the most recent of several real sessions", () => {
    const sessions = [
      sess("current"),
      sess("newer", { turnCount: 5 }),
      sess("older", { turnCount: 9 }),
    ];
    expect(pickResumeTarget(sessions, "current", "")).toMatchObject({
      sessionId: "newer",
    });
  });

  it("errors when every other session is an empty stub", () => {
    const sessions = [sess("current"), sess("stub", { turnCount: 0 })];
    const res = pickResumeTarget(sessions, "current", "");
    expect("error" in res && res.error).toContain("no earlier conversation");
  });

  it("errors when the current session is the only one", () => {
    const res = pickResumeTarget([sess("current")], "current", "");
    expect("error" in res).toBe(true);
  });
});

describe("pickResumeTarget — explicit id (honor the user's pick)", () => {
  it("matches an exact id even when that session is empty", () => {
    const sessions = [sess("current", { turnCount: 2 }), sess("empty-x")];
    expect(pickResumeTarget(sessions, "current", "empty-x")).toEqual({
      sessionId: "empty-x",
      turnCount: 0,
    });
  });

  it("matches by id prefix", () => {
    const sessions = [
      sess("current"),
      sess("4f9c1a2e-deadbeef", { turnCount: 3 }),
    ];
    expect(pickResumeTarget(sessions, "current", "4f9c")).toMatchObject({
      sessionId: "4f9c1a2e-deadbeef",
    });
  });

  it("errors when no session matches the argument", () => {
    const res = pickResumeTarget([sess("current")], "current", "zzz");
    expect("error" in res && res.error).toContain('no session matching "zzz"');
  });
});
