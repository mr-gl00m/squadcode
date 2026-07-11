import { AppError } from "../errors.js";
import type { RuleMap } from "../permissions/policy.js";

// Subagent identifier — a two-letter+digit designation like "KT-4", allocated
// by agents/identity.ts and unique among living subagents.
export type AgentId = string;

// The model-facing name of the Agent tool. Lives here (not in tools/agent.ts)
// so registry-build and subagent-permissions can reference it to enforce
// depth=1 without importing the tool module — that import would cycle, since
// tools/agent.ts depends on the spawn machinery in this directory.
export const AGENT_TOOL_NAME = "Agent";

// Lifecycle status. The terminal set is lifted from FETCH §12 (the Mister
// Fetch status taxonomy this layer cherry-picks): a run ends in exactly one of
// completed / failed_unfulfilled / scope_refused / anguish_terminal /
// user_killed / user_released. "running" is the only non-terminal state — a
// record is created already running, because spawn launches the loop
// immediately rather than queuing.
export type AgentStatus =
  | "running"
  | "completed"
  | "failed_unfulfilled"
  | "scope_refused"
  | "anguish_terminal"
  | "user_killed"
  | "user_released";

const TERMINAL: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  "completed",
  "failed_unfulfilled",
  "scope_refused",
  "anguish_terminal",
  "user_killed",
  "user_released",
]);

export function isTerminalStatus(status: AgentStatus): boolean {
  return TERMINAL.has(status);
}

// A subagent definition. Loaded from .squad/agents/<name>.md frontmatter
// (agents/loader.ts) or supplied as a built-in. The per-agent model + provider
// + ruleset triple is the Squad-original vetting unlock: "for THIS task, use
// THIS prompt + model + ruleset".
export interface SubagentDef {
  name: string;
  // One-line summary surfaced in the Agent tool's subagent_type enum.
  description: string;
  whenToUse?: string;
  // Tool allowlist with wildcard support (*, mcp_*, mcp_<server>_*, exact
  // names). Absent or ["*"] means "every non-Agent tool the parent has".
  tools?: string[];
  // Per-agent model + provider override. Absent => inherit the parent's.
  model?: string;
  provider?: string;
  systemPrompt: string;
  // Per-agent permission ruleset, merged over the defaults in agent-definition
  // order (agents/per-agent-rulesets.ts).
  permissions?: RuleMap;
  // "worktree" runs this agent in a fresh git worktree (agents/worktree.ts) so
  // its edits stay isolated for the parent to review — the natural pairing with
  // an external-CLI backend. Absent => runs in the parent's cwd.
  isolation?: "worktree";
}

// The single structured payload a subagent returns to its parent. Parsed from
// the model's final ### SUMMARY / ### EVIDENCE / ### CHANGES / ### RISKS /
// ### BLOCKERS sections (see src/prompts/subagent-output-format.md), with the
// whole text retained in `raw` as a fallback the parent can always read.
export interface SubagentReport {
  summary: string;
  evidence: string[];
  changes: string[];
  risks: string[];
  blockers: string[];
  raw: string;
}

// Lifecycle record for one subagent run. Phase 13's job registry shares this
// shape (subagent records ARE job records), so the fields kept here are the
// intersection both layers need: id, status, timestamps, and the result.
export interface SubagentRecord {
  id: AgentId;
  // The subagent_type / def name this run was launched from.
  type: string;
  // 1..maxSlots — the concurrent slot this run occupies, for the TUI panel.
  slotKey: number;
  model: string;
  provider: string;
  // Absent => spawned by the top-level (main) loop rather than another agent.
  parentAgentId?: AgentId;
  // The task prompt the parent handed down.
  task: string;
  status: AgentStatus;
  // Last observed anguish scalar in [0,1] — observability only, never fed back
  // into the model's prompt.
  anguish: number;
  startedAt: string;
  completedAt?: string;
  report?: SubagentReport;
  error?: string;
  terminationReason?: string;
  // Path to the isolated git worktree this run used, if any — the parent reads
  // it to diff and decide what to merge back.
  worktree?: string;
}

export class AgentError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, { statusCode: 500, retryable: false, details });
    this.name = "AgentError";
  }
}
