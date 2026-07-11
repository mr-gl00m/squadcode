import { describe, expect, it } from "vitest";
import { createHowlBus, type HowlEvent } from "../src/agents/howl.js";
import { killAgent } from "../src/agents/kill.js";
import { createAgentRegistry } from "../src/agents/registry.js";
import type { SubagentRecord } from "../src/agents/types.js";
import {
  anguishMeter,
  bandColor,
  cycleFocus,
  emptyPanelState,
  killPickerTarget,
  liveCards,
  type PanelState,
  reducePanels,
} from "../src/cli/agent-panel-state.js";

function spawned(agentId: string, slotKey: number): HowlEvent {
  return {
    kind: "spawned",
    agentId,
    type: "red-team",
    slotKey,
    model: "m",
    provider: "p",
    at: "now",
  };
}

// Drive panel state the way the REPL does: a howl bus feeds reducePanels.
function threeSpawned(): PanelState {
  const bus = createHowlBus();
  let state = emptyPanelState(4);
  bus.subscribe((batch) => {
    state = reducePanels(state, batch);
  });
  bus.emit(spawned("AA-1", 1));
  bus.emit(spawned("BB-2", 2));
  bus.emit(spawned("CC-3", 3));
  return state;
}

describe("panel state reducer", () => {
  it("places three spawned agents in slots 1-3 and leaves slot 4 empty", () => {
    const state = threeSpawned();
    expect(liveCards(state)).toHaveLength(3);
    expect(state.cards[0]?.agentId).toBe("AA-1");
    expect(state.cards[1]?.agentId).toBe("BB-2");
    expect(state.cards[2]?.agentId).toBe("CC-3");
    expect(state.cards[3]?.live).toBe(false);
    expect(state.cards[3]?.agentId).toBeUndefined();
  });

  it("updates anguish, action, and terminal status by agent id", () => {
    let state = threeSpawned();
    state = reducePanels(state, [
      { kind: "anguish", agentId: "BB-2", value: 0.7, band: "urgent" },
      { kind: "action", agentId: "BB-2", action: "Shell npm test" },
      { kind: "terminated", agentId: "AA-1", status: "completed", at: "now" },
    ]);
    expect(state.cards[1]?.band).toBe("urgent");
    expect(state.cards[1]?.action).toBe("Shell npm test");
    expect(state.cards[0]?.live).toBe(false);
    expect(state.cards[0]?.status).toBe("completed");
    // A terminated card stays visible until its slot is reused.
    expect(state.cards[0]?.agentId).toBe("AA-1");
  });
});

describe("focus cycling", () => {
  it("Tab cycles main -> slot 1..4 -> main; Shift+Tab reverses", () => {
    let state = emptyPanelState(4);
    expect(state.focus).toBe(0);
    const seq: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      state = cycleFocus(state, "next");
      seq.push(state.focus);
    }
    expect(seq).toEqual([1, 2, 3, 4, 0]);
    state = cycleFocus(state, "prev");
    expect(state.focus).toBe(4);
  });
});

describe("kill picker", () => {
  it("maps a slot digit to the live agent, escape cancels, empty/unknown is a no-op", () => {
    const state = threeSpawned();
    expect(killPickerTarget(state, "2")).toEqual({
      action: "kill",
      agentId: "BB-2",
    });
    expect(killPickerTarget(state, "escape")).toEqual({ action: "cancel" });
    // Slot 4 is empty.
    expect(killPickerTarget(state, "4")).toEqual({ action: "none" });
    expect(killPickerTarget(state, "x")).toEqual({ action: "none" });
  });

  it("Ctrl+K then '2' kills slot 2 only (registry + controllers)", () => {
    // Mirror the panel into a real registry + controllers, as the REPL does.
    const reg = createAgentRegistry({ maxSlots: 4 });
    const controllers = new Map<string, AbortController>();
    const ids = ["AA-1", "BB-2", "CC-3"];
    for (let i = 0; i < ids.length; i += 1) {
      const slot = reg.claimSlot();
      const id = ids[i] as string;
      controllers.set(id, new AbortController());
      const rec: SubagentRecord = {
        id,
        type: "red-team",
        slotKey: slot ?? i + 1,
        model: "m",
        provider: "p",
        task: "t",
        status: "running",
        anguish: 0,
        startedAt: "now",
      };
      reg.register(rec);
    }

    const state = threeSpawned();
    const target = killPickerTarget(state, "2");
    expect(target.action).toBe("kill");
    if (target.action === "kill") {
      killAgent(reg, controllers, target.agentId);
    }

    expect(reg.get("BB-2")?.status).toBe("user_killed");
    expect(controllers.get("BB-2")?.signal.aborted).toBe(true);
    // Slots 1 and 3 untouched.
    expect(reg.get("AA-1")?.status).toBe("running");
    expect(reg.get("CC-3")?.status).toBe("running");
    expect(controllers.get("AA-1")?.signal.aborted).toBe(false);
    expect(controllers.get("CC-3")?.signal.aborted).toBe(false);
  });
});

describe("meter rendering", () => {
  it("colors bands and renders a fixed-width bar", () => {
    expect(bandColor("calm")).toBe("green");
    expect(bandColor("terminal")).toBe("magenta");
    expect(anguishMeter(0, 10)).toBe("░".repeat(10));
    expect(anguishMeter(1, 10)).toBe("█".repeat(10));
    expect(anguishMeter(0.5, 10)).toBe("█".repeat(5) + "░".repeat(5));
  });
});
