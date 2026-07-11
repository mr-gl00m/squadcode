import { promises as fs } from "node:fs";
import { z } from "zod";
import { atomicWriteText } from "../fs-io.js";
import { detectOmissionPlaceholders } from "./omission-placeholder.js";
import { resolveAndValidate } from "./path.js";
import { defineTool } from "./types.js";

const WRITE_INPUT = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export const writeTool = defineTool({
  name: "Write",
  description:
    "Atomically create or overwrite a UTF-8 text file (tmp-and-rename). Parent directories are created as needed.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  inputZod: WRITE_INPUT,
  defaultPermission: "ask",
  isReadOnly: false,
  execute: async (input, ctx) => {
    const placeholders = detectOmissionPlaceholders(input.content);
    if (placeholders.length > 0) {
      return {
        ok: false,
        content: `content contains an omission placeholder (e.g. '${placeholders[0]!}'); the placeholder would be written into the file as text. Provide complete file content.`,
        error: "WRITE_OMISSION_PLACEHOLDER",
      };
    }
    const target = await resolveAndValidate(input.path, {
      root: ctx.cwd,
      mustExist: false,
      access: "write",
    });
    let before: string | null = null;
    try {
      before = await fs.readFile(target, "utf8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await atomicWriteText(target, input.content);
    ctx.diagnostics?.recordTouched(target);
    return {
      ok: true,
      content: `Wrote ${input.content.length} chars to ${input.path}`,
      mutations: [{ path: target, before, after: input.content }],
    };
  },
  summarize: (input, result) =>
    result.ok
      ? `Wrote ${input.path} (${input.content.length} chars)`
      : `Write ${input.path} (failed)`,
});
