import { compilePattern, extractMatchKey } from "../permissions/match.js";
import { TOOL_HOOK_EVENTS, type HookConfig, type HookEvent } from "./config.js";

export interface HookMatchInput {
  event: HookEvent;
  toolName?: string;
  args?: unknown;
}

export function matchesHook(hook: HookConfig, input: HookMatchInput): boolean {
  if (hook.event !== input.event) return false;

  // Non-tool events ignore tool/pattern fields entirely. A SessionStart hook
  // with a `tool` filter shouldn't silently never fire — but if a user
  // misconfigures, we still gate sensibly here so the tool filter can never
  // accidentally apply.
  if (!TOOL_HOOK_EVENTS.has(hook.event)) {
    return true;
  }

  if (hook.tool !== undefined && hook.tool !== input.toolName) return false;
  if (hook.pattern === undefined) return true;

  if (input.toolName === undefined) return false;
  const matchKey = extractMatchKey(input.toolName, input.args);
  const re = compilePattern(hook.pattern, matchKey.kind);
  return re.test(matchKey.key);
}
