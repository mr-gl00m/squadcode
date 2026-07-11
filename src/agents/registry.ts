import {
  AgentError,
  type AgentId,
  isTerminalStatus,
  type SubagentRecord,
} from "./types.js";

// The live roster of subagent records, with two hard caps from the design:
// depth=1 (enforced structurally in registry-build by withholding the Agent
// tool from children, so this layer never even sees a sub-subagent) and a
// 4-slot concurrent ceiling (enforced here). claimSlot() is the gate: it hands
// out a slot number 1..maxSlots or returns null when full, and the caller
// (spawn) turns a null into a fail-fast error rather than queuing.
const DEFAULT_MAX_SLOTS = 4;

export interface AgentRegistry {
  readonly maxSlots: number;
  livingCount(): number;
  freeSlots(): number;
  // Reserve the lowest free slot number, or null if all slots are occupied.
  claimSlot(): number | null;
  // Release a reservation when setup fails before a record can be registered.
  releaseSlot(slot: number): void;
  register(record: SubagentRecord): void;
  get(id: AgentId): SubagentRecord | undefined;
  list(): SubagentRecord[];
  living(): SubagentRecord[];
  update(id: AgentId, patch: Partial<SubagentRecord>): void;
  remove(id: AgentId): void;
}

export interface AgentRegistryOptions {
  maxSlots?: number;
}

export function createAgentRegistry(
  opts: AgentRegistryOptions = {},
): AgentRegistry {
  const maxSlots = opts.maxSlots ?? DEFAULT_MAX_SLOTS;
  const records = new Map<AgentId, SubagentRecord>();
  // Slots held by records that are still running.
  const occupied = new Set<number>();

  function livingRecords(): SubagentRecord[] {
    return [...records.values()].filter((r) => r.status === "running");
  }

  return {
    maxSlots,
    livingCount: () => occupied.size,
    freeSlots: () => maxSlots - occupied.size,
    claimSlot(): number | null {
      for (let slot = 1; slot <= maxSlots; slot += 1) {
        if (!occupied.has(slot)) {
          occupied.add(slot);
          return slot;
        }
      }
      return null;
    },
    releaseSlot(slot: number): void {
      occupied.delete(slot);
    },
    register(record: SubagentRecord): void {
      if (records.has(record.id)) {
        throw new AgentError(
          "AGENT_DUPLICATE_ID",
          `subagent ${record.id} already registered`,
        );
      }
      records.set(record.id, record);
    },
    get: (id) => records.get(id),
    list: () => [...records.values()],
    living: livingRecords,
    update(id: AgentId, patch: Partial<SubagentRecord>): void {
      const existing = records.get(id);
      if (!existing) return;
      const next = { ...existing, ...patch };
      records.set(id, next);
      // A run leaving "running" releases its slot so the ceiling reflects only
      // live work, not historical records the caller hasn't pruned yet.
      if (existing.status === "running" && isTerminalStatus(next.status)) {
        occupied.delete(existing.slotKey);
      }
    },
    remove(id: AgentId): void {
      const existing = records.get(id);
      if (existing) occupied.delete(existing.slotKey);
      records.delete(id);
    },
  };
}
