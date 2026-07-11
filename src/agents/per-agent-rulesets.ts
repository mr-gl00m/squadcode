import { mergeRules, type RuleMap } from "../permissions/policy.js";

// Pairs a per-agent permission ruleset with the per-agent model selection —
// the actual vetting unlock. Each subagent gets its own merged posture the way
// OpenCode's explore/scout/general agents do: defaults provide the floor, the
// agent definition layers its own rules on top, and an optional user override
// wins last. Merge order is preserved into one RuleMap; the matcher's
// deny-wins / most-specific resolution then decides per call. Override is
// expressed by a more-specific or denying rule, never by silent replacement.
export interface AgentRulesetSources {
  defaults?: RuleMap;
  agentRules?: RuleMap;
  userOverride?: RuleMap;
}

export function resolveAgentRuleset(sources: AgentRulesetSources): RuleMap {
  const layers: RuleMap[] = [];
  if (sources.defaults) layers.push(sources.defaults);
  if (sources.agentRules) layers.push(sources.agentRules);
  if (sources.userOverride) layers.push(sources.userOverride);
  return mergeRules(...layers);
}
