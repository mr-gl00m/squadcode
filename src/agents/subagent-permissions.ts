import {
  appendRule,
  type PermissionRule,
  type RuleMap,
  sortRulesInPlace,
} from "../permissions/policy.js";
import { AGENT_TOOL_NAME } from "./types.js";

// deriveSubagentSessionPermission builds the highest-precedence (after the
// sensitive floor) rule layer a child runs under. Lifted from the OpenCode
// #26514 lesson: plan mode and other edit-class denies live on the *agent*
// ruleset, not the session, so a child that inherited only the parent session
// would silently bypass them. Squad's depth=1 layer would hit this on day one.
//
// The forwarded layer is deny-only by construction: a parent's allows do NOT
// flow down (the child re-earns every grant through its own prompts, tagged
// with its identity), but every deny the parent is under — session denies and
// the parent agent's edit-class denies — is forwarded so a child can never
// exceed its parent's authority. On top of that, TodoWrite and the Agent tool
// itself default to denied unless the subagent's own ruleset explicitly allows
// them: todos are parent-scoped, and the Agent tool is withheld to keep
// depth=1 (belt-and-suspenders alongside registry-build dropping it entirely).
const PARENT_SCOPED_TOOLS = ["TodoWrite", AGENT_TOOL_NAME];

export interface SubagentPermissionSources {
  parentSessionRules?: RuleMap;
  parentAgentRules?: RuleMap;
  // The child's own merged ruleset (from resolveAgentRuleset). Only consulted
  // to decide whether a parent-scoped tool is explicitly re-permitted.
  subagentRules?: RuleMap;
}

function forwardDenies(src: RuleMap | undefined, into: RuleMap): void {
  if (!src) return;
  for (const [tool, rules] of src.entries()) {
    for (const rule of rules) {
      if (rule.action === "deny") appendRule(into, tool, { ...rule });
    }
  }
}

function rulesetAllows(rules: RuleMap | undefined, toolName: string): boolean {
  const list = rules?.get(toolName);
  if (!list) return false;
  return list.some((r: PermissionRule) => r.action === "allow");
}

export function deriveSubagentSessionPermission(
  sources: SubagentPermissionSources,
): RuleMap {
  const derived: RuleMap = new Map();
  forwardDenies(sources.parentSessionRules, derived);
  forwardDenies(sources.parentAgentRules, derived);
  for (const tool of PARENT_SCOPED_TOOLS) {
    if (!rulesetAllows(sources.subagentRules, tool)) {
      appendRule(derived, tool, { pattern: "*", action: "deny" });
    }
  }
  sortRulesInPlace(derived);
  return derived;
}
