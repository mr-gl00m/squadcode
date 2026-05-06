import { z } from "zod";
import { fileExists, readJsonFile } from "../fs-io.js";
import { logger } from "../logger.js";
import { SETTINGS_PATH } from "../settings.js";

export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export const TOOL_HOOK_EVENTS: ReadonlySet<HookEvent> = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
]);

const baseFields = {
  id: z.string().min(1),
  event: z.enum(HOOK_EVENTS),
  // Filter to a specific tool name. Only meaningful for tool-event hooks.
  tool: z.string().optional(),
  // Filter to a specific arg pattern within that tool, using the same
  // grammar as permission rules. Path tools match on path, Shell on command.
  pattern: z.string().optional(),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
};

const CommandHookSchema = z.object({
  ...baseFields,
  type: z.literal("command"),
  command: z.string().min(1),
});

const HttpHookSchema = z.object({
  ...baseFields,
  type: z.literal("http"),
  url: z.string().url(),
  method: z.enum(["POST", "PUT", "GET", "PATCH"]).optional(),
  headers: z.record(z.string()).optional(),
});

export const HookSchema = z.discriminatedUnion("type", [
  CommandHookSchema,
  HttpHookSchema,
]);

export type CommandHook = z.infer<typeof CommandHookSchema>;
export type HttpHook = z.infer<typeof HttpHookSchema>;
export type HookConfig = z.infer<typeof HookSchema>;

const HookSettingsSchema = z
  .object({
    hooks: z.array(z.unknown()).optional(),
  })
  .passthrough();

export interface LoadHooksResult {
  hooks: HookConfig[];
  invalidCount: number;
}

export function parseHooksFromSettings(raw: unknown): LoadHooksResult {
  const settings = HookSettingsSchema.safeParse(raw);
  if (!settings.success) {
    logger.warn(
      { err: settings.error.message },
      "settings.json is not a valid object; ignoring hooks",
    );
    return { hooks: [], invalidCount: 0 };
  }
  const list = settings.data.hooks;
  if (!Array.isArray(list)) return { hooks: [], invalidCount: 0 };

  const hooks: HookConfig[] = [];
  let invalidCount = 0;
  const seenIds = new Set<string>();
  for (const entry of list) {
    const parsed = HookSchema.safeParse(entry);
    if (!parsed.success) {
      logger.warn(
        { err: parsed.error.message },
        "skipping invalid hook entry in settings.json",
      );
      invalidCount += 1;
      continue;
    }
    if (seenIds.has(parsed.data.id)) {
      logger.warn(
        { id: parsed.data.id },
        "skipping duplicate hook id in settings.json",
      );
      invalidCount += 1;
      continue;
    }
    seenIds.add(parsed.data.id);
    hooks.push(parsed.data);
  }
  return { hooks, invalidCount };
}

export async function loadHooks(
  settingsPath: string = SETTINGS_PATH,
): Promise<LoadHooksResult> {
  if (!(await fileExists(settingsPath))) {
    return { hooks: [], invalidCount: 0 };
  }
  let raw: unknown;
  try {
    raw = await readJsonFile<unknown>(settingsPath);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "failed to read settings.json; ignoring hooks",
    );
    return { hooks: [], invalidCount: 0 };
  }
  return parseHooksFromSettings(raw);
}
