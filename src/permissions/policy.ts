import type { ToolPermissionMode } from "../tools/types.js";
import { SENSITIVE_DEFAULTS } from "./defaults.js";
import {
  compilePattern,
  extractMatchKey,
  specificity,
} from "./match.js";

export type PermissionAction = "allow" | "deny" | "ask";

export interface PermissionRule {
  pattern: string;
  action: PermissionAction;
}

export type RuleMap = Map<string, PermissionRule[]>;

export interface PolicyConfig {
  defaultMode: "ask" | "allow" | "deny";
  rules: RuleMap;
  dangerouslySkipPermissions: boolean;
}

export interface CliPolicyArgs {
  defaultMode: "ask" | "allow" | "deny";
  allowedTools?: string | undefined;
  disallowedTools?: string | undefined;
  dangerouslySkipPermissions?: boolean | undefined;
}

export function buildPolicyFromCli(args: CliPolicyArgs): PolicyConfig {
  const rules: RuleMap = new Map();
  for (const tool of parseList(args.disallowedTools)) {
    appendRule(rules, tool, { pattern: "*", action: "deny" });
  }
  for (const tool of parseList(args.allowedTools)) {
    appendRule(rules, tool, { pattern: "*", action: "allow" });
  }
  for (const [tool, list] of Object.entries(SENSITIVE_DEFAULTS)) {
    for (const rule of list) appendRule(rules, tool, rule);
  }
  sortRulesInPlace(rules);
  return {
    defaultMode: args.defaultMode,
    rules,
    dangerouslySkipPermissions: args.dangerouslySkipPermissions ?? false,
  };
}

export function appendRule(
  rules: RuleMap,
  toolName: string,
  rule: PermissionRule,
): void {
  const list = rules.get(toolName) ?? [];
  list.push(rule);
  rules.set(toolName, list);
}

export function sortRulesInPlace(rules: RuleMap): void {
  for (const list of rules.values()) {
    list.sort((a, b) => specificity(b.pattern) - specificity(a.pattern));
  }
}

export function mergeRules(...sources: RuleMap[]): RuleMap {
  const merged: RuleMap = new Map();
  for (const src of sources) {
    for (const [tool, list] of src.entries()) {
      for (const rule of list) appendRule(merged, tool, rule);
    }
  }
  sortRulesInPlace(merged);
  return merged;
}

export function decideAction(
  toolName: string,
  toolDefault: ToolPermissionMode,
  args: unknown,
  cfg: PolicyConfig,
): PermissionAction {
  if (cfg.dangerouslySkipPermissions) return "allow";

  const toolRules = cfg.rules.get(toolName);
  if (toolRules && toolRules.length > 0) {
    const match = extractMatchKey(toolName, args);
    for (const rule of toolRules) {
      const re = compilePattern(rule.pattern, match.kind);
      if (re.test(match.key)) return rule.action;
    }
  }

  if (toolDefault === "auto-allow") return "allow";
  if (toolDefault === "auto-deny") return "deny";
  if (cfg.defaultMode === "allow") return "allow";
  if (cfg.defaultMode === "deny") return "deny";
  return "ask";
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
