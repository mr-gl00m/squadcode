import type { z } from "zod";

export type ToolPermissionMode = "auto-allow" | "ask" | "auto-deny";

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  callId: string;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  error?: string;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly inputZod: z.ZodType<unknown>;
  readonly defaultPermission: ToolPermissionMode;
  readonly isReadOnly: boolean;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
  summarize?(input: unknown, result: ToolResult): string;
}

export interface ToolSpec<T> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  inputZod: z.ZodType<T>;
  defaultPermission: ToolPermissionMode;
  isReadOnly: boolean;
  execute: (input: T, ctx: ToolContext) => Promise<ToolResult>;
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
    execute: async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const parsed = spec.inputZod.parse(input);
      return spec.execute(parsed, ctx);
    },
  };
  if (spec.summarize) {
    const summarize = spec.summarize;
    tool.summarize = (input: unknown, result: ToolResult): string => {
      const parsed = spec.inputZod.parse(input);
      return summarize(parsed, result);
    };
  }
  return tool;
}
