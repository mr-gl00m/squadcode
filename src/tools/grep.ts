import { promises as fs } from "node:fs";
import { relative } from "node:path";
import { z } from "zod";
import { resolveAndValidate } from "./path.js";
import { matchesGlob, walkFiles } from "./scan.js";
import { defineTool } from "./types.js";

const GREP_INPUT = z.object({
  pattern: z.string().min(1).max(500),
  path: z.string().optional(),
  glob: z.string().optional(),
  case_insensitive: z.boolean().optional(),
  max_matches: z.number().int().positive().max(1000).optional(),
});

const DEFAULT_MAX_MATCHES = 200;
const MAX_FILE_BYTES = 5_000_000;
const MAX_LINE_CHARS = 5_000;
const TOTAL_SCAN_BUDGET_BYTES = 200_000_000;

function hasUnsafeBacktrackingShape(pattern: string): boolean {
  let escaped = false;
  let inCharacterClass = false;
  const stack: string[] = [];
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      const next = pattern[i + 1] ?? "";
      if (!inCharacterClass && /[1-9]/.test(next)) return true;
      escaped = true;
      continue;
    }
    if (ch === "[" && !inCharacterClass) {
      inCharacterClass = true;
      continue;
    }
    if (ch === "]" && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;
    if (ch === "(") {
      stack.push("");
      continue;
    }
    if (ch === ")" && stack.length > 0) {
      const body = stack.pop() ?? "";
      const next = pattern[i + 1] ?? "";
      if (/[*+?]/.test(next) || next === "{") {
        // Repetition of another repetition, or of an alternation, is the
        // common catastrophic-backtracking shape. Reject the whole class
        // before JavaScript's backtracking engine sees any file content.
        if (/[*+?]|\{\d|\|/.test(body)) return true;
      }
      if (stack.length > 0) stack[stack.length - 1] += body;
      continue;
    }
    if (stack.length > 0) stack[stack.length - 1] += ch;
  }
  return false;
}

export const grepTool = defineTool({
  name: "Grep",
  description:
    "Search file contents with a JavaScript regex. Returns relative_path:line:match lines. Skips node_modules, .git, dist, files >5MB, and lines >5000 chars.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", maxLength: 500 },
      path: { type: "string" },
      glob: { type: "string" },
      case_insensitive: { type: "boolean" },
      max_matches: { type: "integer", minimum: 1, maximum: 1000 },
    },
    required: ["pattern"],
  },
  inputZod: GREP_INPUT,
  defaultPermission: "auto-allow",
  isReadOnly: true,
  execute: async (input, ctx) => {
    const root = input.path
      ? await resolveAndValidate(input.path, {
          root: ctx.cwd,
          mustExist: true,
        })
      : ctx.cwd;

    let regex: RegExp;
    try {
      if (hasUnsafeBacktrackingShape(input.pattern)) {
        return {
          ok: false,
          content:
            "unsafe regex: nested quantified groups can stall JavaScript regex matching",
          error: "GREP_UNSAFE_REGEX",
        };
      }
      regex = new RegExp(input.pattern, input.case_insensitive ? "i" : "");
    } catch (err: unknown) {
      return {
        ok: false,
        content: `invalid regex: ${err instanceof Error ? err.message : String(err)}`,
        error: "GREP_BAD_REGEX",
      };
    }

    const max = input.max_matches ?? DEFAULT_MAX_MATCHES;
    const out: string[] = [];
    let count = 0;
    let bytesScanned = 0;
    let filesSkippedSize = 0;

    for await (const file of walkFiles(root)) {
      if (ctx.signal.aborted) {
        return { ok: false, content: "aborted", error: "ABORTED" };
      }

      const stat = await fs.stat(file).catch(() => null);
      if (stat === null) continue;
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_BYTES) {
        filesSkippedSize += 1;
        continue;
      }
      if (bytesScanned + stat.size > TOTAL_SCAN_BUDGET_BYTES) {
        out.push(
          `(scan budget reached at ${TOTAL_SCAN_BUDGET_BYTES} bytes; results truncated)`,
        );
        break;
      }
      bytesScanned += stat.size;

      const rel = relative(ctx.cwd, file).replace(/\\/g, "/");
      if (input.glob && !matchesGlob(rel, input.glob)) continue;

      let raw: string;
      try {
        raw = await fs.readFile(file, "utf-8");
      } catch {
        continue;
      }
      const lines = raw.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (ctx.signal.aborted) {
          return { ok: false, content: "aborted", error: "ABORTED" };
        }
        const line = lines[i] ?? "";
        if (line.length > MAX_LINE_CHARS) continue;
        if (regex.test(line)) {
          out.push(`${rel}:${i + 1}:${line}`);
          count += 1;
          if (count >= max) break;
        }
      }
      if (count >= max) break;
    }

    const trailer: string[] = [];
    if (filesSkippedSize > 0) {
      trailer.push(
        `(${filesSkippedSize} files skipped: size > ${MAX_FILE_BYTES} bytes)`,
      );
    }
    if (out.length === 0 && trailer.length === 0) {
      return { ok: true, content: "(no matches)" };
    }
    if (out.length === 0) {
      return { ok: true, content: trailer.join("\n") };
    }
    return { ok: true, content: [...out, ...trailer].join("\n") };
  },
  summarize: (input, result) => {
    if (!result.ok) return `grep ${input.pattern} (failed)`;
    if (result.content === "(no matches)")
      return `grep ${input.pattern} (0 matches)`;
    const matches = result.content
      .split("\n")
      .filter((l) => /:\d+:/.test(l)).length;
    return `grep ${input.pattern} (${matches} matches)`;
  },
});
