import type { z } from "zod";
import type { JobRegistry } from "../engine/job-registry.js";
import type { DiagnosticsTracker } from "../engine/post-edit-diagnostics.js";
import type { TimerRegistry } from "../engine/timer-registry.js";
import type { YoloSession } from "../yolo/index.js";

export type ToolPermissionMode = "auto-allow" | "ask" | "auto-deny";

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  callId: string;
  yolo?: YoloSession;
  // When true, the always-on delete guard is bypassed for this run (set by the
  // user via --dangerously-allow-deletes; never settable by the model).
  allowDeletes?: boolean;
  // Per-session (or per-subagent) long-running registries. Present when the
  // engine threads them in; the job/timer tools and Shell's background mode
  // read them here. A subagent gets its own pair — no cross-registry visibility.
  jobs?: JobRegistry;
  timers?: TimerRegistry;
  // Post-edit diagnostics tracker. Mutating file tools record touched paths
  // here on success; the pre-turn injector drains and syntax-checks them.
  diagnostics?: DiagnosticsTracker;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  error?: string;
  mutations?: FileMutation[];
}

export interface FileMutation {
  path: string;
  before: string | null;
  after: string | null;
}

export interface PreviewResult {
  display: string;
  metadata?: unknown;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly inputZod: z.ZodType<unknown>;
  readonly defaultPermission: ToolPermissionMode;
  readonly isReadOnly: boolean;
  // When true, the tool's full JSON Schema is withheld from the canonical
  // tool list until the model explicitly loads it via ToolSearch. The name
  // and one-line description still appear in the deferred catalog so the
  // model knows the tool exists.
  readonly defer?: boolean;
  preview?(input: unknown, ctx: ToolContext): Promise<PreviewResult>;
  execute(
    input: unknown,
    ctx: ToolContext,
    metadata?: unknown,
  ): Promise<ToolResult>;
  summarize?(input: unknown, result: ToolResult): string;
}

export interface ToolSpec<T> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  inputZod: z.ZodType<T>;
  defaultPermission: ToolPermissionMode;
  isReadOnly: boolean;
  defer?: boolean;
  preview?: (input: T, ctx: ToolContext) => Promise<PreviewResult>;
  execute: (
    input: T,
    ctx: ToolContext,
    metadata?: unknown,
  ) => Promise<ToolResult>;
  summarize?: (input: T, result: ToolResult) => string;
}

export function defineTool<T>(spec: ToolSpec<T>): Tool {
  const tool: Tool = {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    inputZod: spec.inputZod as z.ZodType<unknown>,
    defaultPermission: spec.defaultPermission,
    isReadOnly: spec.isReadOnly,
    ...(spec.defer !== undefined && { defer: spec.defer }),
    execute: async (
      input: unknown,
      ctx: ToolContext,
      metadata?: unknown,
    ): Promise<ToolResult> => {
      const parsed = spec.inputZod.parse(input);
      return spec.execute(parsed, ctx, metadata);
    },
  };
  if (spec.preview) {
    const previewFn = spec.preview;
    tool.preview = async (
      input: unknown,
      ctx: ToolContext,
    ): Promise<PreviewResult> => {
      const parsed = spec.inputZod.parse(input);
      return previewFn(parsed, ctx);
    };
  }
  if (spec.summarize) {
    const summarize = spec.summarize;
    tool.summarize = (input: unknown, result: ToolResult): string => {
      const parsed = spec.inputZod.parse(input);
      return summarize(parsed, result);
    };
  }
  return tool;
}
