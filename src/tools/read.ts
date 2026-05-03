import { promises as fs } from "node:fs";
import { z } from "zod";
import { resolveAndValidate } from "./path.js";
import { defineTool } from "./types.js";

const READ_INPUT = z.object({
  path: z.string().min(1),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});

export const readTool = defineTool({
  name: "Read",
  description:
    "Read a UTF-8 text file. Optional offset (1-indexed line) and limit slice the output.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1 },
    },
    required: ["path"],
  },
  inputZod: READ_INPUT,
  defaultPermission: "auto-allow",
  isReadOnly: true,
  execute: async (input, ctx) => {
    const target = await resolveAndValidate(input.path, {
      root: ctx.cwd,
      mustExist: true,
    });
    const raw = await fs.readFile(target, "utf-8");
    if (input.offset === undefined && input.limit === undefined) {
      return { ok: true, content: raw };
    }
    const lines = raw.split(/\r?\n/);
    const start = (input.offset ?? 1) - 1;
    const end =
      input.limit !== undefined ? start + input.limit : lines.length;
    return { ok: true, content: lines.slice(start, end).join("\n") };
  },
  summarize: (input, result) => {
    if (!result.ok) return `Read ${input.path} (failed)`;
    const lines = result.content.split("\n").length;
    const bytes = Buffer.byteLength(result.content, "utf-8");
    return `Read ${input.path} (${lines} lines, ${formatBytes(bytes)})`;
  },
});

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
