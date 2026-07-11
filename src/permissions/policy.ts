import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolPermissionMode } from "../tools/types.js";
import { SENSITIVE_DEFAULTS } from "./defaults.js";
import { compilePattern, extractMatchKeys, specificity } from "./match.js";
import { classifyShellCommand, type Mode, planVerdict } from "./plan.js";

export type PermissionAction = "allow" | "deny" | "ask";

export interface PermissionRule {
  pattern: string;
  action: PermissionAction;
}

export type RuleMap = Map<string, PermissionRule[]>;

export interface PolicyConfig {
  defaultMode: "ask" | "allow" | "deny";
  rules: RuleMap;
  // Ordered precedence stack (highest first), built by the engine as
  // [sensitive, session, project, user-global, cli]. When present, decideAction
  // resolves through it instead of the flat `rules` map; the first layer with a
  // matching rule wins, and deny wins within a layer. Absent in tests that pass
  // only `rules` — those fall back to treating `rules` as a single layer.
  layers?: RuleMap[];
  dangerouslySkipPermissions: boolean;
  // Read-scoped sibling of dangerouslySkipPermissions: when set, file reads
  // whose path resolves under `cwd` auto-allow without a prompt, bypassing the
  // sensitive-file layer (.env, id_rsa, …) for in-project paths. Reads outside
  // `cwd` and every mutating tool stay on the normal layered path. Set via
  // --dangerously-skip-read-permissions; it's the door-time switch behind a
  // `wtf`-style read-only diagnostic.
  dangerouslySkipReadPermissions?: boolean;
  // Project root, used to scope dangerouslySkipReadPermissions to in-project
  // reads. Absent in unit tests that don't exercise the read-skip path.
  cwd?: string;
  // Mode is mutable on this object — the REPL toggles it via /mode plan
  // / /mode act and the engine reads it on each decision.
  mode: Mode;
}

let cachedSensitiveLayer: RuleMap | null = null;

// The sensitive-file defaults as a standalone, sorted RuleMap — the top of the
// precedence stack, the floor that project / user-global / cli rules can't
// override. Built once and shared read-only.
export function sensitiveLayer(): RuleMap {
  if (cachedSensitiveLayer) return cachedSensitiveLayer;
  const layer: RuleMap = new Map();
  for (const [tool, list] of Object.entries(SENSITIVE_DEFAULTS)) {
    for (const rule of list) appendRule(layer, tool, rule);
  }
  sortRulesInPlace(layer);
  cachedSensitiveLayer = layer;
  return layer;
}

export interface CliPolicyArgs {
  defaultMode: "ask" | "allow" | "deny";
  allowedTools?: string | undefined;
  disallowedTools?: string | undefined;
  dangerouslySkipPermissions?: boolean | undefined;
  dangerouslySkipReadPermissions?: boolean | undefined;
  cwd?: string | undefined;
  mode?: Mode | undefined;
}

export function buildPolicyFromCli(args: CliPolicyArgs): PolicyConfig {
  // CLI --allowed-tools / --disallowed-tools become the lowest-precedence
  // (built-in) layer. Sensitive defaults are kept as their own top layer rather
  // than mixed in here, so they stay the un-overridable floor.
  const rules: RuleMap = new Map();
  for (const tool of parseList(args.disallowedTools)) {
    appendRule(rules, tool, { pattern: "*", action: "deny" });
  }
  for (const tool of parseList(args.allowedTools)) {
    appendRule(rules, tool, { pattern: "*", action: "allow" });
  }
  sortRulesInPlace(rules);
  return {
    defaultMode: args.defaultMode,
    rules,
    layers: [sensitiveLayer(), rules],
    dangerouslySkipPermissions: args.dangerouslySkipPermissions ?? false,
    dangerouslySkipReadPermissions:
      args.dangerouslySkipReadPermissions ?? false,
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
    mode: args.mode ?? "act",
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
  // Plan mode is a policy boundary, not a prompt preference. Evaluate its
  // non-allow verdicts before any permission-bypass flag so contradictory
  // programmatic configurations still fail closed even when the CLI guard is
  // bypassed.
  if (cfg.mode === "plan") {
    const planned = planVerdict(toolName, args, { cwd: cfg.cwd });
    if (planned !== null && planned !== "allow") return planned;
  }
  // Read-scoped skip: auto-allow a file read that resolves under the project
  // directory before the layered evaluation runs, so the sensitive-file layer
  // (.env, id_rsa, …) is bypassed for in-project paths. Reads outside cwd and
  // every mutating tool fall through to the normal path below.
  if (
    cfg.dangerouslySkipReadPermissions === true &&
    isInProjectRead(toolName, args, cfg.cwd)
  ) {
    return "allow";
  }

  // Evaluate permission layers in precedence order; the first layer with a
  // matching rule decides. The engine builds the stack as
  // [sensitive, session, project, user-global, cli]; tests that pass only
  // cfg.rules get a single-layer fallback.
  const layers = cfg.layers ?? [cfg.rules];
  for (const layer of layers) {
    const verdict = matchLayer(toolName, args, layer);
    if (verdict === null) continue;
    // Plan mode overrides an "allow" verdict for mutating tools so that
    // --allowed-tools Edit + --mode plan (or any allow rule) doesn't let Edits
    // through. Sensitive denies and asks are already at-least-as-strict, so
    // they pass through unchanged.
    if (cfg.mode === "plan" && verdict === "allow") {
      const planned = planVerdict(toolName, args, { cwd: cfg.cwd });
      if (planned !== null && planned !== "allow") return planned;
    }
    if (verdict === "deny") return "deny";
    return cfg.dangerouslySkipPermissions ? "allow" : verdict;
  }

  if (cfg.mode === "plan") {
    const planned = planVerdict(toolName, args, { cwd: cfg.cwd });
    if (planned !== null) return planned;
  }

  // Permission bypass suppresses prompts; it does not erase a deny found in
  // the layered policy above. Retried calls therefore keep the same maximum
  // access as the original attempt.
  if (cfg.dangerouslySkipPermissions) return "allow";

  // Act mode: let recognized read-only shell commands (ls, cat, git status,
  // Get-ChildItem, …) through without a prompt — the same classifier plan mode
  // applies above. Read-only Shell is no riskier than the Read/Glob/Grep tools,
  // which already auto-allow; this stops "read these docs" tasks from stalling
  // on a prompt per command verb. Scoped to the ask default so explicit
  // --default-mode allow/deny and matched rules (both handled earlier) still
  // win, and a future auto-deny on Shell wouldn't get quietly overridden.
  if (toolName === "Shell" && cfg.defaultMode === "ask") {
    const command = (args as { command?: unknown } | null)?.command;
    if (
      typeof command === "string" &&
      classifyShellCommand(command, { cwd: cfg.cwd }) === "allow"
    ) {
      return "allow";
    }
  }

  if (toolDefault === "auto-allow") return "allow";
  if (toolDefault === "auto-deny") return "deny";
  if (cfg.defaultMode === "allow") return "allow";
  if (cfg.defaultMode === "deny") return "deny";
  return "ask";
}

// A single layer's verdict for (tool, args): deny if ANY matching rule denies
// (deny wins within a layer), otherwise the most-specific matching allow/ask.
// Vector-key tools such as ApplyPatch require every key to match in the same
// layer before an allow/ask can decide the call; a partial match falls through
// so `{a,b}` approval cannot silently authorize a later `{b,c}` patch.
function matchLayer(
  toolName: string,
  args: unknown,
  layer: RuleMap,
): PermissionAction | null {
  const rules = layer.get(toolName);
  if (!rules || rules.length === 0) return null;
  const matches = extractMatchKeys(toolName, args);
  const verdicts: PermissionAction[] = [];
  let allMatched = true;
  for (const match of matches) {
    let best: { action: PermissionAction; spec: number } | null = null;
    for (const rule of rules) {
      const re = compilePattern(rule.pattern, match.kind);
      if (!re.test(match.key)) continue;
      if (rule.action === "deny") return "deny";
      const spec = specificity(rule.pattern);
      if (best === null || spec > best.spec) {
        best = { action: rule.action, spec };
      }
    }
    if (best === null) {
      allMatched = false;
    } else {
      verdicts.push(best.action);
    }
  }
  if (!allMatched) return null;
  return verdicts.includes("ask") ? "ask" : "allow";
}

// True for a Read whose target path resolves inside the project directory.
// Only Read carries sensitive-file rules worth bypassing here; Glob/Grep are
// auto-allow already and have no path to scope, so they're left untouched.
function isInProjectRead(
  toolName: string,
  args: unknown,
  cwd: string | undefined,
): boolean {
  if (toolName !== "Read" || cwd === undefined) return false;
  const path = (args as { path?: unknown } | null)?.path;
  return typeof path === "string" && pathWithinProject(path, cwd);
}

// Resolves a (possibly relative) path against the project root and reports
// whether it stays inside it. Bias is toward "outside": a `..` climb or an
// absolute remainder (a different Windows drive) reads as out-of-project, so a
// false negative just re-prompts rather than auto-reading a secret elsewhere.
// `relative` is case-insensitive on win32, so drive/segment casing is handled.
function pathWithinProject(p: string, cwd: string): boolean {
  const root = resolve(cwd);
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(root, abs);
  if (rel === "") return true;
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    return false;
  }
  return true;
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
