import { describe, expect, it, vi } from "vitest";
import {
  type NotificationConfig,
  notifyTurnComplete,
  type TurnCompletionPayload,
} from "../src/notifications.js";

const payload: TurnCompletionPayload = {
  event: "turn_complete",
  sessionId: "s1",
  cwd: "/repo",
  provider: "test",
  model: "model",
  ok: true,
  durationMs: 123,
  turn: 2,
};

function config(
  overrides: Partial<NotificationConfig> = {},
): NotificationConfig {
  return {
    terminalMode: "off",
    terminalMethod: "osc9",
    permissionSound: true,
    ...overrides,
  };
}

describe("turn completion notifications", () => {
  it("sends the typed JSON payload to a configured external program", async () => {
    const runProgram = vi.fn(async () => undefined);
    await notifyTurnComplete(config({ program: "notify" }), payload, {
      focused: true,
      runProgram,
    });
    expect(runProgram).toHaveBeenCalledWith("notify", payload);
  });

  it("writes OSC9 only when an unfocused-mode terminal is unfocused", async () => {
    const writeTerminal = vi.fn();
    const settings = config({ terminalMode: "unfocused" });
    await notifyTurnComplete(settings, payload, {
      focused: true,
      writeTerminal,
    });
    expect(writeTerminal).not.toHaveBeenCalled();
    await notifyTurnComplete(settings, payload, {
      focused: false,
      writeTerminal,
    });
    expect(writeTerminal).toHaveBeenCalledWith(
      "\x1b]9;Squad turn complete\x07",
    );
  });

  it("supports an always-on BEL terminal signal", async () => {
    const writeTerminal = vi.fn();
    await notifyTurnComplete(
      config({ terminalMode: "always", terminalMethod: "bell" }),
      payload,
      { focused: true, writeTerminal },
    );
    expect(writeTerminal).toHaveBeenCalledWith("\x07");
  });
});
