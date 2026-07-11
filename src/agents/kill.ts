import type { AgentRegistry } from "./registry.js";
import type { AgentId } from "./types.js";

// Termination is a status stamp plus an abort. The stamp lands first so a
// spawn finishing right after the abort sees the terminal status and doesn't
// overwrite it with "completed" (see spawn's post-loop status check). reason
// distinguishes a direct kill (Ctrl+K on one slot) from a cascade (Ctrl+C on
// the parent tearing down every live child at once).
export type KillReason = "user killed" | "cascade from parent";

export function killAgent(
  registry: AgentRegistry,
  controllers: Map<AgentId, AbortController>,
  id: AgentId,
  reason: KillReason = "user killed",
): boolean {
  const record = registry.get(id);
  if (!record || record.status !== "running") return false;
  registry.update(id, { status: "user_killed", terminationReason: reason });
  controllers.get(id)?.abort();
  return true;
}

// Cascade-kill every living subagent — the parent's Ctrl+C path and the
// session-teardown path both call this. Returns the ids it actually stopped.
export function killAllAgents(
  registry: AgentRegistry,
  controllers: Map<AgentId, AbortController>,
  reason: KillReason = "cascade from parent",
): AgentId[] {
  const killed: AgentId[] = [];
  for (const record of registry.living()) {
    if (killAgent(registry, controllers, record.id, reason)) {
      killed.push(record.id);
    }
  }
  return killed;
}
