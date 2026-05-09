import { relative } from "node:path";
import { z } from "zod";
import { resolveAndValidate } from "./path.js";
import { matchesGlob, walkFiles } from "./scan.js";
import { defineTool } from "./types.js";

const GLOB_INPUT = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  limit: z.number().int().positive().max(10_000).optional(),
});

const DEFAULT_GLOB_LIMIT = 1000;

export const globTool = defineTool({
  name: "Glob",
  description:
    "List files matching a glob pattern (e.g. \"src/**/*.ts\"). Returns paths relative to the project root, capped at 1000 entries by default — pass limit to raise (max 10000) or refine the pattern when truncated.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 10000 },
    },
    required: ["pattern"],
  },
  inputZod: GLOB_INPUT,
  defaultPermission: "auto-allow",
  isReadOnly: true,
  execute: async (input, ctx) => {
    const root = input.path
      ? await resolveAndValidate(input.path, {
          root: ctx.cwd,
          mustExist: true,
        })
      : ctx.cwd;

    const limit = input.limit ?? DEFAULT_GLOB_LIMIT;
    const matches: string[] = [];
    let total = 0;
    for await (const file of walkFiles(root)) {
      if (ctx.signal.aborted) {
        return { ok: false, content: "aborted", error: "ABORTED" };
      }
      const rel = relative(ctx.cwd, file).replace(/\\/g, "/");
      if (matchesGlob(rel, input.pattern)) {
        total += 1;
        if (matches.length < limit) matches.push(rel);
      }
    }
    if (total === 0) return { ok: true, content: "(no matches)" };
    matches.sort();
    if (total > matches.length) {
      const elided = total - matches.length;
      return {
        ok: true,
        content: `${matches.join("\n")}\n(showing ${matches.length} of ${total}; ${elided} more — refine the pattern or pass limit to raise the cap)`,
      };
    }
    return { ok: true, content: matches.join("\n") };
  },
  summarize: (input, result) => {
    if (!result.ok) return `glob ${input.pattern} (failed)`;
    if (result.content === "(no matches)") return `glob ${input.pattern} (0 files)`;
    const files = result.content.split("\n").length;
    return `glob ${input.pattern} (${files} files)`;
  },
});
