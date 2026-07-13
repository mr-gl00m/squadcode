import { InvalidArgumentError } from "commander";
import type { RuntimeCliConfig } from "../config/stack.js";

export interface RootOptions {
  print?: string;
  model?: string;
  provider?: string;
  profile?: string;
  simple?: boolean;
  resume?: boolean | string;
  continue?: boolean;
  allowedTools?: string;
  disallowedTools?: string;
  dangerouslySkipPermissions?: boolean;
  dangerouslySkipReadPermissions?: boolean;
  dangerouslyAllowDeletes?: boolean;
  yolo?: boolean;
  mode?: string;
  outputFormat?: string;
  outputSchema?: string;
  outputLastMessage?: string;
  replay?: boolean | string;
  replayLimit?: number;
  shootout?: string;
  notificationSound?: boolean;
}

export function runtimeCliConfig(opts: RootOptions): RuntimeCliConfig {
  return {
    ...(opts.provider !== undefined && { provider: opts.provider }),
    ...(opts.model !== undefined && { model: opts.model }),
    ...(opts.profile !== undefined && { profile: opts.profile }),
    ...(opts.mode !== undefined && { mode: opts.mode }),
    ...(opts.allowedTools !== undefined && {
      allowedTools: opts.allowedTools,
    }),
    ...(opts.disallowedTools !== undefined && {
      disallowedTools: opts.disallowedTools,
    }),
    ...(opts.dangerouslySkipPermissions !== undefined && {
      dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
    }),
    ...(opts.dangerouslySkipReadPermissions !== undefined && {
      dangerouslySkipReadPermissions: opts.dangerouslySkipReadPermissions,
    }),
    ...(opts.dangerouslyAllowDeletes !== undefined && {
      dangerouslyAllowDeletes: opts.dangerouslyAllowDeletes,
    }),
    ...(opts.yolo !== undefined && { yolo: opts.yolo }),
    ...(opts.notificationSound !== undefined && {
      notificationSound: opts.notificationSound,
    }),
  };
}

export function parseOnOff(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "on") return true;
  if (normalized === "off") return false;
  throw new InvalidArgumentError('expected "on" or "off"');
}
