import { join } from "node:path";
import { atomicWriteJson, fileExists, readJsonFile } from "../fs-io.js";
import { logger } from "../logger.js";
import {
  appendRule,
  type PermissionAction,
  type PermissionRule,
  type RuleMap,
  sortRulesInPlace,
} from "./policy.js";

export interface ProjectSettings {
  version?: string;
  permissions?: {
    alwaysAllowed?: string[];
    rules?: Record<string, Record<string, PermissionAction>>;
  };
  [key: string]: unknown;
}

const SETTINGS_VERSION = "0.2.0";

export function getProjectSettingsPath(cwd: string): string {
  return join(cwd, ".squad", "settings.json");
}

export async function loadProjectRules(cwd: string): Promise<RuleMap> {
  const path = getProjectSettingsPath(cwd);
  const out: RuleMap = new Map();
  if (!(await fileExists(path))) return out;
  let data: ProjectSettings;
  try {
    data = await readJsonFile<ProjectSettings>(path);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), path },
      "failed to read project settings; treating as empty",
    );
    return out;
  }
  const legacy = data.permissions?.alwaysAllowed;
  if (Array.isArray(legacy)) {
    for (const tool of legacy) {
      if (typeof tool === "string") {
        appendRule(out, tool, { pattern: "*", action: "allow" });
      }
    }
  }
  const ruleObj = data.permissions?.rules;
  if (ruleObj && typeof ruleObj === "object") {
    for (const [tool, patterns] of Object.entries(ruleObj)) {
      if (!patterns || typeof patterns !== "object") continue;
      for (const [pattern, action] of Object.entries(patterns)) {
        if (action === "allow" || action === "deny" || action === "ask") {
          appendRule(out, tool, { pattern, action });
        }
      }
    }
  }
  sortRulesInPlace(out);
  return out;
}

export async function persistProjectRule(
  cwd: string,
  toolName: string,
  pattern: string,
  action: PermissionAction,
): Promise<void> {
  const path = getProjectSettingsPath(cwd);
  let existing: ProjectSettings = {};
  if (await fileExists(path)) {
    try {
      existing = await readJsonFile<ProjectSettings>(path);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), path },
        "project settings unreadable; will overwrite",
      );
    }
  }

  const ruleObj: Record<string, Record<string, PermissionAction>> = {
    ...(existing.permissions?.rules ?? {}),
  };
  const toolPatterns = { ...(ruleObj[toolName] ?? {}) };
  if (toolPatterns[pattern] === action) return;
  toolPatterns[pattern] = action;
  ruleObj[toolName] = toolPatterns;

  const next: ProjectSettings = {
    ...existing,
    version: existing.version ?? SETTINGS_VERSION,
    permissions: {
      ...(existing.permissions ?? {}),
      rules: ruleObj,
    },
  };
  if (next.permissions?.alwaysAllowed === undefined) {
    delete (next.permissions as { alwaysAllowed?: string[] }).alwaysAllowed;
  }
  await atomicWriteJson(path, next);
}

export async function loadProjectAllowList(cwd: string): Promise<{
  rules: RuleMap;
  hasLegacy: boolean;
}> {
  const path = getProjectSettingsPath(cwd);
  const out: RuleMap = new Map();
  if (!(await fileExists(path))) return { rules: out, hasLegacy: false };
  let data: ProjectSettings;
  try {
    data = await readJsonFile<ProjectSettings>(path);
  } catch {
    return { rules: out, hasLegacy: false };
  }
  const hasLegacy = Array.isArray(data.permissions?.alwaysAllowed);
  out.clear();
  for (const [tool, list] of (await loadProjectRules(cwd)).entries()) {
    out.set(tool, list);
  }
  return { rules: out, hasLegacy };
}

export function ruleListForTool(
  rules: RuleMap,
  toolName: string,
): PermissionRule[] {
  return rules.get(toolName) ?? [];
}
