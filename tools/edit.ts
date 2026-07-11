import { promises as fs } from "node:fs";
import { z } from "zod";
import { detectAndStripBom, restoreBom } from "../bom.js";
import { withFileLock } from "../file-mutex.js";
import { atomicWriteText } from "../fs-io.js";
import {
  detectLineEnding,
  normalizeToLf,
  restoreLineEnding,
} from "../line-endings.js";
import { logger } from "../logger.js";
import {
  countOccurrences,
  type MatchStage,
  resolveEditMatch,
} from "./edit-match.js";
import { detectOmissionPlaceholders } from "./omission-placeholder.js";
import { resolveAndValidate } from "./path.js";
import { defineTool } from "./types.js";

const EDIT_INPUT = z.object({
  path: z.string().min(1),
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

const MAX_EDIT_BYTES = 5_000_000;

interface EditMetadata {
  mtimeMs: number;
}

// Refuse the edit when new_string introduces a shorthand placeholder that
// would be written into the file as literal text. A placeholder also present
// in old_string is allowed — the model is preserving an abbreviation that the
// file legitimately contains, or the EDIT_NO_MATCH error will surface
// naturally if it doesn't.
export function checkEditPlaceholders(args: {
  old_string: string;
  new_string: string;
}): { ok: true } | { ok: false; message: string } {
  const newPh = detectOmissionPlaceholders(args.new_string);
  if (newPh.length === 0) return { ok: true };
  const oldPh = new Set(detectOmissionPlaceholders(args.old_string));
  for (const ph of newPh) {
    if (!oldPh.has(ph)) {
      return {
        ok: false,
        message: `new_string contains an omission placeholder (e.g. '${ph}'); the placeholder would be written into the file as text. Provide literal replacement content.`,
      };
    }
  }
  return { ok: true };
}

// Human-readable suffix for a non-exact match so the transcript (and the
// vetting data) records how sloppy the model's old_string actually was.
function stageSuffix(stage: MatchStage): string {
  return stage === "exact" ? "" : ` (matched via ${stage} fallback)`;
}

export function makeEditDiffPreview(args: {
  path: string;
  raw: string;
  oldStr: string;
  newStr: string;
  at: number;
  replaceAll: boolean;
}): string {
  const { path, raw, oldStr, newStr, at, replaceAll } = args;
  const before = raw.slice(0, at);
  const startLine = (before.match(/\n/g)?.length ?? 0) + 1;
  const occ = countOccurrences(raw, oldStr);
  const header =
    replaceAll && occ > 1
      ? `${path}:${startLine}  (replace_all — ${occ} matches; first shown)`
      : `${path}:${startLine}`;
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const removed = oldLines.map((l) => `- ${l}`).join("\n");
  const added = newLines.map((l) => `+ ${l}`).join("\n");
  return `${header}\n${removed}\n${added}`;
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
  preview: async (input, ctx) => {
    const placeholderCheck = checkEditPlaceholders(input);
    if (!placeholderCheck.ok) {
      return {
        display: `${input.path}\n  → ${placeholderCheck.message}`,
        metadata: { mtimeMs: 0 },
      };
    }
    const target = await resolveAndValidate(input.path, {
      root: ctx.cwd,
      mustExist: true,
      access: "write",
    });
    const stats = await fs.stat(target);
    const metadata: EditMetadata = { mtimeMs: stats.mtimeMs };
    if (stats.size > MAX_EDIT_BYTES) {
      return {
        display: `${input.path}\n  → file is ${stats.size.toLocaleString()} bytes; exceeds ${MAX_EDIT_BYTES.toLocaleString()}-byte edit ceiling`,
        metadata,
      };
    }
    const rawWithBom = await fs.readFile(target, "utf-8");
    const { content: rawWithEol } = detectAndStripBom(rawWithBom);
    const raw = normalizeToLf(rawWithEol);
    const oldStr = normalizeToLf(input.old_string);
    const newStr = normalizeToLf(input.new_string);
    const match = resolveEditMatch(raw, oldStr, {
      replaceAll: input.replace_all === true,
    });
    if (!match.ok) {
      const detail =
        match.reason === "not_unique"
          ? "old_string matches more than one location"
          : "old_string not found in file";
      return {
        display: `${input.path}\n  → ${detail}`,
        metadata,
      };
    }
    const at = raw.indexOf(match.matched);
    return {
      display:
        makeEditDiffPreview({
          path: input.path,
          raw,
          oldStr: match.matched,
          newStr,
          at,
          replaceAll: input.replace_all === true,
        }) + stageSuffix(match.stage),
      metadata,
    };
  },
  execute: async (input, ctx, metadata) => {
    const placeholderCheck = checkEditPlaceholders(input);
    if (!placeholderCheck.ok) {
      return {
        ok: false,
        content: placeholderCheck.message,
        error: "EDIT_OMISSION_PLACEHOLDER",
      };
    }
    const target = await resolveAndValidate(input.path, {
      root: ctx.cwd,
      mustExist: true,
      access: "write",
    });
    const expected = (metadata as EditMetadata | undefined)?.mtimeMs;
    return withFileLock(target, async () => {
      // Acquire the mutex before checking the preview mtime. Otherwise another
      // edit can land after stat() but before this callback starts.
      const stats = await fs.stat(target);
      if (stats.size > MAX_EDIT_BYTES) {
        return {
          ok: false,
          content: `${input.path} exceeds the ${MAX_EDIT_BYTES.toLocaleString()}-byte edit ceiling (size: ${stats.size.toLocaleString()}); use a different tool for files this large`,
          error: "EDIT_TOO_LARGE",
        };
      }
      if (expected !== undefined && stats.mtimeMs !== expected) {
        return {
          ok: false,
          content: `${input.path} changed on disk after the permission prompt was shown (mtime moved); re-run the edit to pick up the new contents`,
          error: "EDIT_STALE_MTIME",
        };
      }
      const rawWithBom = await fs.readFile(target, "utf-8");
      const { content: rawWithEol, bom } = detectAndStripBom(rawWithBom);
      const eol = detectLineEnding(rawWithEol);
      const raw = normalizeToLf(rawWithEol);
      const oldStr = normalizeToLf(input.old_string);
      const newStr = normalizeToLf(input.new_string);

      const match = resolveEditMatch(raw, oldStr, {
        replaceAll: input.replace_all === true,
      });
      if (!match.ok) {
        if (match.reason === "not_unique") {
          return {
            ok: false,
            content: `old_string is not unique in ${input.path}; pass replace_all:true or include more surrounding context`,
            error: "EDIT_NOT_UNIQUE",
          };
        }
        return {
          ok: false,
          content: `old_string not found in ${input.path} (tried exact match and whitespace/indentation/escape/block-anchor fallbacks); re-read the file and copy the target text verbatim`,
          error: "EDIT_NO_MATCH",
        };
      }
      if (match.stage !== "exact") {
        logger.info(
          { path: input.path, stage: match.stage },
          "edit matched via fallback stage",
        );
      }
      let replaced: string;
      let resultMsg: string;
      if (input.replace_all) {
        const occ = countOccurrences(raw, match.matched);
        replaced = raw.split(match.matched).join(newStr);
        resultMsg = `Replaced ${occ} occurrences in ${input.path}${stageSuffix(match.stage)}`;
      } else {
        const at = raw.indexOf(match.matched);
        replaced =
          raw.slice(0, at) + newStr + raw.slice(at + match.matched.length);
        resultMsg = `Edited ${input.path}${stageSuffix(match.stage)}`;
      }
      const finalContent = restoreBom(restoreLineEnding(replaced, eol), bom);
      await atomicWriteText(target, finalContent);
      ctx.diagnostics?.recordTouched(target);
      return {
        ok: true,
        content: resultMsg,
        mutations: [{ path: target, before: rawWithBom, after: finalContent }],
      };
    });
  },
  summarize: (input, result) =>
    result.ok
      ? `Edited ${input.path}${input.replace_all ? " (replace_all)" : ""}`
      : `Edit ${input.path} (failed${result.error ? `: ${result.error}` : ""})`,
});
