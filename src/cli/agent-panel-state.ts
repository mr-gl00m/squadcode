import type { AnguishBand } from "../agents/anguish.js";
import type { HowlEvent } from "../agents/howl.js";
import type { AgentId, AgentStatus } from "../agents/types.js";

// Pure panel state, kept out of the .tsx so it's testable without importing
// Ink/React. The Ink component (agent-panel.tsx) is a thin render over this;
// the REPL feeds it howl batches and keypresses through these reducers.

export interface PanelCard {
  slot: number;
  agentId?: AgentId;
  type?: string;
  model?: string;
  provider?: string;
  action?: string;
  anguish: number;
  band: AnguishBand;
  status?: AgentStatus;
  // True while the run is in flight; a terminated card stays visible (showing
  // its terminal status) until its slot is reused, so the user sees the result.
  live: boolean;
}

export interface PanelState {
  // Length === maxSlots. Index i is slot i+1.
  cards: PanelCard[];
  // 0 = the main composer; 1..maxSlots = that slot.
  focus: number;
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

export function emptyPanelState(maxSlots = 4): PanelState {
  return {
    cards: Array.from({ length: maxSlots }, (_unused, i) => ({
      slot: i + 1,
      anguish: 0,
      band: "calm" as AnguishBand,
      live: false,
    })),
    focus: 0,
  };
}

function findByAgent(
  cards: PanelCard[],
  agentId: AgentId,
): PanelCard | undefined {
  return cards.find((c) => c.agentId === agentId);
}

// Fold a batch of howl events into new panel state. The cards are the source of
// truth for what each slot shows; "roster" is advisory and ignored here.
export function reducePanels(
  state: PanelState,
  events: HowlEvent[],
): PanelState {
  const cards = state.cards.map((c) => ({ ...c }));
  for (const ev of events) {
    switch (ev.kind) {
      case "spawned": {
        const card = cards.find((c) => c.slot === ev.slotKey);
        if (card) {
          card.agentId = ev.agentId;
          card.type = ev.type;
          card.model = ev.model;
          card.provider = ev.provider;
          card.status = "running";
          card.live = true;
          card.anguish = 0;
          card.band = "calm";
          delete card.action;
        }
        break;
      }
      case "anguish": {
        const card = findByAgent(cards, ev.agentId);
        if (card) {
          card.anguish = ev.value;
          card.band = ev.band;
        }
        break;
      }
      case "action": {
        const card = findByAgent(cards, ev.agentId);
        if (card) card.action = ev.action;
        break;
      }
      case "status": {
        const card = findByAgent(cards, ev.agentId);
        if (card) card.status = ev.status;
        break;
      }
      case "terminated": {
        const card = findByAgent(cards, ev.agentId);
        if (card) {
          card.status = ev.status;
          card.live = false;
        }
        break;
      }
      case "roster":
        break;
    }
  }
  return { cards, focus: state.focus };
}

// Tab / Shift+Tab cycle: main(0) -> slot 1 -> ... -> slot N -> main, wrapping.
// Cycles through every slot, occupied or not (empty slots still render).
export function cycleFocus(
  state: PanelState,
  dir: "next" | "prev",
): PanelState {
  const positions = state.cards.length + 1;
  const delta = dir === "next" ? 1 : -1;
  const focus = (((state.focus + delta) % positions) + positions) % positions;
  return { ...state, focus };
}

export type KillPickerResult =
  | { action: "kill"; agentId: AgentId }
  | { action: "cancel" }
  | { action: "none" };

// Maps a kill-picker keypress: "1".."N" target the live agent in that slot,
// "escape" cancels, anything else (or an empty/dead slot) is a no-op.
export function killPickerTarget(
  state: PanelState,
  key: string,
): KillPickerResult {
  if (key === "escape" || key === "esc") return { action: "cancel" };
  const slot = Number.parseInt(key, 10);
  if (!Number.isInteger(slot)) return { action: "none" };
  const card = state.cards.find((c) => c.slot === slot);
  if (card?.live && card.agentId !== undefined) {
    return { action: "kill", agentId: card.agentId };
  }
  return { action: "none" };
}

export function liveCards(state: PanelState): PanelCard[] {
  return state.cards.filter((c) => c.live);
}

// Ink color name for an anguish band — the meter coloring.
export function bandColor(band: AnguishBand): string {
  switch (band) {
    case "calm":
      return "green";
    case "alert":
      return "yellow";
    case "urgent":
      return "red";
    case "terminal":
      return "magenta";
  }
}

// A fixed-width filled bar for the anguish meter.
export function anguishMeter(value: number, width = 10): string {
  const filled = Math.round(clamp01(value) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}
