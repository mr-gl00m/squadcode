import { describe, expect, it } from "vitest";
import {
  handleSlash,
  type SlashContext,
  slashAvailableDuringTurn,
} from "../src/cli/slash.js";

function makeCtx(overrides: Partial<SlashContext> = {}): SlashContext {
  return {
    providerName: "test",
    model: "test-model",
    setProvider: () => null,
    setModel: () => undefined,
    clear: () => undefined,
    messageCount: () => 0,
    skills: () => new Map(),
    outputStyles: () => new Map(),
    activeStyleName: () => null,
    setStyle: () => null,
    clearStyle: () => undefined,
    costSummary: () => "",
    usageReport: () => "",
    toolList: () => "",
    sessionList: () => "",
    ...overrides,
  } as SlashContext;
}

describe("/resume slash command", () => {
  it("reports unavailable when no resolver is wired (e.g. print mode)", () => {
    const result = handleSlash("/resume", makeCtx());
    expect(result.message).toContain("not available");
    expect(result.followup).toBeUndefined();
  });

  it("emits a resume followup with the resolved session id", () => {
    const ctx = makeCtx({
      resolveResume: () => ({ sessionId: "abcd1234ef", turnCount: 3 }),
    });
    const result = handleSlash("/resume", ctx);
    expect(result.message).toContain("resuming session abcd1234");
    expect(result.message).toContain("3 prior turns");
    expect(result.followup).toEqual({
      kind: "resume",
      sessionId: "abcd1234ef",
    });
  });

  it("singularizes a single prior turn", () => {
    const ctx = makeCtx({
      resolveResume: () => ({ sessionId: "x", turnCount: 1 }),
    });
    expect(handleSlash("/resume", ctx).message).toContain("1 prior turn)");
  });

  it("passes the raw argument through to the resolver", () => {
    let seen: string | null = null;
    const ctx = makeCtx({
      resolveResume: (arg) => {
        seen = arg;
        return { sessionId: "deadbeef", turnCount: 0 };
      },
    });
    handleSlash("/resume 9f3a", ctx);
    expect(seen).toBe("9f3a");
  });

  it("surfaces the resolver error and emits no followup", () => {
    const ctx = makeCtx({
      resolveResume: () => ({ error: 'no session matching "zzz"' }),
    });
    const result = handleSlash("/resume zzz", ctx);
    expect(result.message).toContain("no session matching");
    expect(result.followup).toBeUndefined();
  });
});

describe("/diff slash command", () => {
  it("renders the latest in-memory turn diff", () => {
    const result = handleSlash(
      "/diff",
      makeCtx({ diff: () => "--- a/a.txt\n+++ b/a.txt" }),
    );
    expect(result.message).toContain("--- a/a.txt");
  });
});

describe("active-turn slash commands", () => {
  it("allows read-only commands and their aliases", () => {
    expect(slashAvailableDuringTurn("/diff")).toBe(true);
    expect(slashAvailableDuringTurn("/usage cwd 7")).toBe(true);
    expect(slashAvailableDuringTurn("/list-skills")).toBe(true);
    expect(slashAvailableDuringTurn("/sound off")).toBe(true);
  });

  it("blocks commands that mutate or replace REPL state", () => {
    expect(slashAvailableDuringTurn("/mode plan")).toBe(false);
    expect(slashAvailableDuringTurn("/compact")).toBe(false);
    expect(slashAvailableDuringTurn("/quit")).toBe(false);
    expect(slashAvailableDuringTurn("/unknown")).toBe(false);
  });
});

describe("/sound slash command", () => {
  it("toggles the current permission sound when no state is given", () => {
    let enabled = true;
    const ctx = makeCtx({
      notificationSoundEnabled: () => enabled,
      setNotificationSound: (next) => {
        enabled = next;
      },
    });
    expect(handleSlash("/sound", ctx).message).toContain("OFF");
    expect(enabled).toBe(false);
  });

  it("accepts explicit states and the long alias", () => {
    let enabled = false;
    const ctx = makeCtx({
      notificationSoundEnabled: () => enabled,
      setNotificationSound: (next) => {
        enabled = next;
      },
    });
    expect(handleSlash("/notification-sound on", ctx).message).toContain("ON");
    expect(enabled).toBe(true);
    expect(handleSlash("/sound off", ctx).message).toContain("OFF");
    expect(enabled).toBe(false);
  });

  it("rejects unknown states without changing the setting", () => {
    let changed = false;
    const result = handleSlash(
      "/sound maybe",
      makeCtx({
        notificationSoundEnabled: () => true,
        setNotificationSound: () => {
          changed = true;
        },
      }),
    );
    expect(result.message).toContain("use on or off");
    expect(changed).toBe(false);
  });
});
