// Plan mode profile. Hardcoded tool verdicts that short-circuit decideAction
// when policy.mode === "plan". Sensitive defaults still apply through the
// normal rule path before this fallback strictness layer.

import type { PermissionAction } from "./policy.js";
import { classifyShellCommand } from "./shell-safety.js";

export { classifyShellCommand };

export type Mode = "act" | "plan";

const MUTATING_TOOLS = new Set(["Edit", "Write", "ApplyPatch", "NotebookEdit"]);

const READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "IndexList",
  "IndexFetch",
  "TodoWrite",
  "ToolSearch",
]);

export function planVerdict(
  toolName: string,
  args?: unknown,
  opts: { cwd?: string | undefined } = {},
): PermissionAction | null {
  if (MUTATING_TOOLS.has(toolName)) return "deny";
  if (READ_ONLY_TOOLS.has(toolName)) return "allow";
  if (toolName === "Shell") {
    const command = (args as { command?: unknown } | null)?.command;
    return typeof command === "string"
      ? classifyShellCommand(command, { cwd: opts.cwd })
      : "ask";
  }
  return "ask";
}

export function applyModeAddendums(
  base: string,
  parts: { yolo?: string | null; plan?: boolean },
): string {
  const out = [base];
  if (parts.yolo) out.push(parts.yolo);
  if (parts.plan) out.push(planSystemPromptAddendum());
  return out.join("\n\n");
}

export function planSystemPromptAddendum(): string {
  return [
    "",
    "## Plan mode",
    "You are in PLAN mode. The permission engine denies Edit/Write/ApplyPatch/NotebookEdit outright. Literal, parsed read-only Shell commands may run; every other Shell shape prompts the user.",
    "Your job in plan mode is to READ the code, understand the task, and produce a concrete plan — file paths, function names, the sequence of changes, the order to make them in.",
    "Do not propose a plan that requires running mutating tools to find out 'what would happen.' Read first, plan second.",
    "When you're ready to execute, end your response with a clear plan and ask the user to switch to act mode (`/mode act`).",
    "Don't apologize for the restriction or describe plan mode back to the user — they know what it is. Just plan.",
  ].join("\n");
}
