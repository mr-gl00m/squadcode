import { promises as fs } from "node:fs";
import { z } from "zod";
import { atomicWriteText } from "../fs-io.js";
import { resolveAndValidate } from "./path.js";
import { defineTool } from "./types.js";

const EDIT_INPUT = z.object({
  path: z.string().min(1),
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

export const editTool = defineTool({
  name: "Edit",
  description:
    "Replace a substring in a file. Fails if old_string is not unique unless replace_all:true.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" },
    },
    required: ["path", "old_string", "new_string"],
  },
  inputZod: EDIT_INPUT,
  defaultPermission: "ask",
  isReadOnly: false,
  execute: async (input, ctx) => {
    const target = await resolveAndValidate(input.path, {
      root: ctx.cwd,
      mustExist: true,
    });
    const raw = await fs.readFile(target, "utf-8");
    const occ = countOccurrences(raw, input.old_string);
    if (occ === 0) {
      return {
        ok: false,
        content: `old_string not found in ${input.path}`,
        error: "EDIT_NO_MATCH",
      };
    }
    if (input.replace_all) {
      const replaced = raw.split(input.old_string).join(input.new_string);
      await atomicWriteText(target, replaced);
      return {
        ok: true,
        content: `Replaced ${occ} occurrences in ${input.path}`,
      };
    }
    if (occ > 1) {
      return {
        ok: false,
        content: `old_string is not unique in ${input.path} (${occ} matches); pass replace_all:true or include more surrounding context`,
        error: "EDIT_NOT_UNIQUE",
      };
    }
    const at = raw.indexOf(input.old_string);
    const replaced =
      raw.slice(0, at) +
      input.new_string +
      raw.slice(at + input.old_string.length);
    await atomicWriteText(target, replaced);
    return { ok: true, content: `Edited ${input.path}` };
  },
  summarize: (input, result) =>
    result.ok
      ? `Edited ${input.path}${input.replace_all ? " (replace_all)" : ""}`
      : `Edit ${input.path} (failed${result.error ? `: ${result.error}` : ""})`,
});
