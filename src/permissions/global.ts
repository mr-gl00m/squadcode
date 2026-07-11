// User-level (machine-wide) permission rules at ~/.squad/permissions.json.
// Same shape as project rules (.squad/settings.json), but one file for every
// project on the machine — the place a blanket "yes, you can browse my
// N:/proj_* dirs" grant lives so it isn't re-prompted per project. Loaded as
// the `user-global` layer, which sits below sensitive-defaults and project
// rules in the precedence stack (see decideAction): sensitive and project both
// win over it, and a tool with no matching rule here still falls through to the
// normal ask. Tool keys are exact tool names ("Read", "Shell", …), matching how
// [U] grants persist them.

import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson, fileExists, readJsonFile } from "../fs-io.js";
import { logger } from "../logger.js";
import {
  appendRule,
  type PermissionAction,
  type RuleMap,
  sortRulesInPlace,
} from "./policy.js";

export interface UserPermissionSettings {
  version?: string;
  permissions?: {
    rules?: Record<string, Record<string, PermissionAction>>;
  };
  [key: string]: unknown;
}

const SETTINGS_VERSION = "0.1.0";

export function getUserPermissionsPath(): string {
  return join(homedir(), ".squad", "permissions.json");
}

export async function loadUserGlobalRules(): Promise<RuleMap> {
  const path = getUserPermissionsPath();
  const out: RuleMap = new Map();
  if (!(await fileExists(path))) return out;
  let data: UserPermissionSettings;
  try {
    data = await readJsonFile<UserPermissionSettings>(path);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), path },
      "failed to read user permissions; treating as empty",
    );
    return out;
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

export async function persistUserRule(
  toolName: string,
  pattern: string,
  action: PermissionAction,
): Promise<void> {
  const path = getUserPermissionsPath();
  let existing: UserPermissionSettings = {};
  if (await fileExists(path)) {
    try {
      existing = await readJsonFile<UserPermissionSettings>(path);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), path },
        "user permissions unreadable; will overwrite",
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

  const next: UserPermissionSettings = {
    ...existing,
    version: existing.version ?? SETTINGS_VERSION,
    permissions: {
      ...(existing.permissions ?? {}),
      rules: ruleObj,
    },
  };
  await atomicWriteJson(path, next);
}
