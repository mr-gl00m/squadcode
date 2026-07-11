import { logger } from "../logger.js";
import type { AnguishBand } from "./anguish.js";
import type { AgentId, AgentStatus } from "./types.js";

// HOWL: an in-process pub/sub channel for subagent lifecycle, anguish, and
// roster changes. Clean-room rebuild of the FETCH §17.5 idea (a broadcast bus
// the UI subscribes to), none of its code.
//
// Turn-buffered commit: publish() queues events; commit() flushes the whole
// batch to every subscriber at once. The point is the Ink panel (Phase 14) —
// it should repaint once per loop turn, not once per individual event, so a
// turn that spawns an agent, bumps its anguish, and updates the roster lands as
// one coherent frame instead of three. emit() is the publish+commit shorthand
// for a standalone event outside any turn.
export type HowlEvent =
  | {
      kind: "spawned";
      agentId: AgentId;
      type: string;
      slotKey: number;
      model: string;
      provider: string;
      at: string;
    }
  | { kind: "status"; agentId: AgentId; status: AgentStatus }
  | { kind: "anguish"; agentId: AgentId; value: number; band: AnguishBand }
  // The subagent's current human-readable action, for the panel's status line.
  | { kind: "action"; agentId: AgentId; action: string }
  | {
      kind: "terminated";
      agentId: AgentId;
      status: AgentStatus;
      reason?: string;
      at: string;
    }
  | { kind: "roster"; living: AgentId[] };

export type HowlListener = (events: HowlEvent[]) => void;

export interface HowlBus {
  subscribe(listener: HowlListener): () => void;
  publish(ev: HowlEvent): void;
  commit(): void;
  emit(ev: HowlEvent): void;
}

export function createHowlBus(): HowlBus {
  const listeners = new Set<HowlListener>();
  let buffer: HowlEvent[] = [];

  function deliver(batch: HowlEvent[]): void {
    for (const listener of listeners) {
      try {
        listener(batch);
      } catch (err: unknown) {
        // A misbehaving subscriber must never break the agent loop that
        // published — telemetry is strictly best-effort here.
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "howl listener threw",
        );
      }
    }
  }

  return {
    subscribe(listener: HowlListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(ev: HowlEvent): void {
      buffer.push(ev);
    },
    commit(): void {
      if (buffer.length === 0) return;
      const batch = buffer;
      buffer = [];
      deliver(batch);
    },
    emit(ev: HowlEvent): void {
      deliver([ev]);
    },
  };
}
