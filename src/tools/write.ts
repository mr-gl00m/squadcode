import { z } from "zod";
import { atomicWriteText } from "../fs-io.js";
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
    const target = await resolveAndValidate(input.path, {
      root: ctx.cwd,
      mustExist: false,
    });
    await atomicWriteText(target, input.content);
    return {
      ok: true,
      content: `Wrote ${input.content.length} chars to ${input.path}`,
    };
  },
  summarize: (input, result) =>
    result.ok
      ? `Wrote ${input.path} (${input.content.length} chars)`
      : `Write ${input.path} (failed)`,
});
