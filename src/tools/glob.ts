import { relative } from "node:path";
import { z } from "zod";
import { resolveAndValidate } from "./path.js";
import { matchesGlob, walkFiles } from "./scan.js";
import { defineTool } from "./types.js";

const GLOB_INPUT = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
});

export const globTool = defineTool({
  name: "Glob",
  description:
    "List files matching a glob pattern (e.g. \"src/**/*.ts\"). Returns paths relative to the project root.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
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

    const matches: string[] = [];
    for await (const file of walkFiles(root)) {
      if (ctx.signal.aborted) {
        return { ok: false, content: "aborted", error: "ABORTED" };
      }
      const rel = relative(ctx.cwd, file).replace(/\\/g, "/");
      if (matchesGlob(rel, input.pattern)) matches.push(rel);
    }
    if (matches.length === 0) return { ok: true, content: "(no matches)" };
    return { ok: true, content: matches.sort().join("\n") };
  },
  summarize: (input, result) => {
    if (!result.ok) return `glob ${input.pattern} (failed)`;
    if (result.content === "(no matches)") return `glob ${input.pattern} (0 files)`;
    const files = result.content.split("\n").length;
    return `glob ${input.pattern} (${files} files)`;
  },
});
