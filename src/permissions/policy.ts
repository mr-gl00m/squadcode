import type { ToolPermissionMode } from "../tools/types.js";

export type PermissionAction = "allow" | "deny" | "ask";

export interface PolicyConfig {
  defaultMode: "ask" | "allow" | "deny";
  allowedTools: Set<string>;
  disallowedTools: Set<string>;
  dangerouslySkipPermissions: boolean;
}

export interface CliPolicyArgs {
  defaultMode: "ask" | "allow" | "deny";
  allowedTools?: string | undefined;
  disallowedTools?: string | undefined;
  dangerouslySkipPermissions?: boolean | undefined;
}

export function buildPolicyFromCli(args: CliPolicyArgs): PolicyConfig {
  return {
    defaultMode: args.defaultMode,
    allowedTools: new Set(parseList(args.allowedTools)),
    disallowedTools: new Set(parseList(args.disallowedTools)),
    dangerouslySkipPermissions: args.dangerouslySkipPermissions ?? false,
  };
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function decideAction(
  toolName: string,
  toolDefault: ToolPermissionMode,
  cfg: PolicyConfig,
): PermissionAction {
  if (cfg.disallowedTools.has(toolName)) return "deny";
  if (cfg.dangerouslySkipPermissions) return "allow";
  if (cfg.allowedTools.has(toolName)) return "allow";
  if (toolDefault === "auto-allow") return "allow";
  if (toolDefault === "auto-deny") return "deny";
  if (cfg.defaultMode === "allow") return "allow";
  if (cfg.defaultMode === "deny") return "deny";
  return "ask";
}
