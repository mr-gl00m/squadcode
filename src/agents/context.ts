import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentId } from "./types.js";

// Per-subagent ambient context, propagated with Node's stdlib AsyncLocalStorage
// (no third-party dep). spawn.ts runs the subagent's whole loop inside
// runInSubagentContext, so any tool or provider call made deep inside that run
// can recover which agent it belongs to without threading the id through every
// signature. The main (top-level) loop runs with no store — currentSubagent()
// returns undefined there, which is how callers tell "main loop" from "child".
export interface SubagentContext {
  agentId: AgentId;
  parentAgentId?: AgentId;
  slotKey: number;
  model: string;
  provider: string;
  abortController: AbortController;
}

const storage = new AsyncLocalStorage<SubagentContext>();

export function runInSubagentContext<T>(ctx: SubagentContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentAgentId(): AgentId | undefined {
  return storage.getStore()?.agentId;
}
