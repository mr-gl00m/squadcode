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
import { resolveAndValidate } from "./path.js";
import { defineTool } from "./types.js";

const APPLY_PATCH_INPUT = z.object({
  patch: z.string().min(1),
});

const MAX_PATCH_FILES = 50;
const MAX_FILE_BYTES = 5_000_000;

export interface FileHunk {
  oldString: string;
  newString: string;
}

export interface FilePatch {
  path: string;
  isNew: boolean;
  hunks: FileHunk[];
}

export interface ApplyPatchMetadata {
  mtimes: Record<string, number>;
}

export function parseUnifiedDiff(patch: string): FilePatch[] {
  const lines = patch.split(/\r?\n/);
  const out: FilePatch[] = [];
  let i = 0;
  while (i < lines.length) {
    while (i < lines.length && !lines[i]!.startsWith("--- ")) i += 1;
    if (i >= lines.length) break;
    const oldHeader = lines[i]!;
    i += 1;
    if (i >= lines.length || !lines[i]!.startsWith("+++ ")) {
      throw new Error(
        `expected '+++ ' line after '--- ' near line ${i + 1}`,
      );
    }
    const newHeader = lines[i]!;
    i += 1;

    const oldPath = oldHeader.slice(4).split("\t")[0]!.trim();
    const newPath = newHeader.slice(4).split("\t")[0]!.trim();
    const isNew = oldPath === "/dev/null";
    const targetPath = stripPathPrefix(isNew ? newPath : oldPath);

    const hunks: FileHunk[] = [];
    while (i < lines.length && lines[i]!.startsWith("@@")) {
      i += 1;
      const oldChunk: string[] = [];
      const newChunk: string[] = [];
      while (
        i < lines.length &&
        !lines[i]!.startsWith("@@") &&
        !lines[i]!.startsWith("--- ")
      ) {
        const line = lines[i]!;
        if (line.startsWith("\\")) {
          i += 1;
          continue;
        }
        if (line.length === 0) {
          // Unprefixed empty line in a unified diff is the hunk terminator.
          // Conventional context blank lines are emitted as " " (space + empty).
          break;
        }
        if (line.startsWith(" ")) {
          const content = line.slice(1);
          oldChunk.push(content);
          newChunk.push(content);
        } else if (line.startsWith("-")) {
          oldChunk.push(line.slice(1));
        } else if (line.startsWith("+")) {
          newChunk.push(line.slice(1));
        } else {
          break;
        }
        i += 1;
      }
      hunks.push({
        oldString: oldChunk.join("\n"),
        newString: newChunk.join("\n"),
      });
    }

    out.push({ path: targetPath, isNew, hunks });
  }
  return out;
}

function stripPathPrefix(path: string): string {
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

export function applyHunkToContent(
  content: string,
  hunk: FileHunk,
): { ok: true; content: string } | { ok: false; reason: string } {
  if (hunk.oldString.length === 0) {
    return { ok: false, reason: "empty hunk old-string (use new-file form)" };
  }
  const at = content.indexOf(hunk.oldString);
  if (at !== -1) {
    return {
      ok: true,
      content:
        content.slice(0, at) +
        hunk.newString +
        content.slice(at + hunk.oldString.length),
    };
  }
  const contentLines = content.split("\n");
  const oldLines = hunk.oldString.split("\n").map((l) => l.trimEnd());
  for (let i = 0; i + oldLines.length <= contentLines.length; i += 1) {
    let allMatch = true;
    for (let j = 0; j < oldLines.length; j += 1) {
      if (contentLines[i + j]!.trimEnd() !== oldLines[j]) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      const newLines = [...contentLines];
      newLines.splice(i, oldLines.length, ...hunk.newString.split("\n"));
      return { ok: true, content: newLines.join("\n") };
    }
  }
  const preview = hunk.oldString
    .split("\n")
    .slice(0, 3)
    .join(" / ")
    .slice(0, 120);
  return { ok: false, reason: `hunk did not match (looked for: ${preview})` };
}

export const applyPatchTool = defineTool({
  name: "ApplyPatch",
  description:
    "Apply a unified-diff patch covering one or more files. Supports modify-existing (--- a/path / +++ b/path) and create-new (--- /dev/null / +++ b/path). Each hunk is matched exactly first, then with line-trimmed fallback.",
  inputSchema: {
    type: "object",
    properties: { patch: { type: "string" } },
    required: ["patch"],
  },
  inputZod: APPLY_PATCH_INPUT,
  defaultPermission: "ask",
  isReadOnly: false,
  defer: true,
  preview: async (input, ctx) => {
    let parsed: FilePatch[];
    try {
      parsed = parseUnifiedDiff(input.patch);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        display: `failed to parse patch: ${msg}`,
        metadata: { mtimes: {} } as ApplyPatchMetadata,
      };
    }
    if (parsed.length === 0) {
      return {
        display: "patch contains no file sections",
        metadata: { mtimes: {} } as ApplyPatchMetadata,
      };
    }
    if (parsed.length > MAX_PATCH_FILES) {
      return {
        display: `patch covers ${parsed.length} files; exceeds ${MAX_PATCH_FILES}-file ceiling`,
        metadata: { mtimes: {} } as ApplyPatchMetadata,
      };
    }
    const mtimes: Record<string, number> = {};
    const lines: string[] = [];
    for (const file of parsed) {
      const tag = file.isNew ? " (new file)" : "";
      lines.push(
        `${file.path}${tag} — ${file.hunks.length} hunk${file.hunks.length === 1 ? "" : "s"}`,
      );
      if (!file.isNew) {
        try {
          const target = await resolveAndValidate(file.path, {
            root: ctx.cwd,
            mustExist: true,
          });
          const stats = await fs.stat(target);
          mtimes[file.path] = stats.mtimeMs;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          lines.push(`  ! ${msg}`);
        }
      }
    }
    return {
      display: lines.join("\n"),
      metadata: { mtimes } as ApplyPatchMetadata,
    };
  },
  execute: async (input, ctx, metadata) => {
    let parsed: FilePatch[];
    try {
      parsed = parseUnifiedDiff(input.patch);
    } catch (err: unknown) {
      return {
        ok: false,
        content: `patch parse failed: ${err instanceof Error ? err.message : String(err)}`,
        error: "PATCH_PARSE_ERROR",
      };
    }
    if (parsed.length === 0) {
      return {
        ok: false,
        content: "patch contained no file sections",
        error: "PATCH_EMPTY",
      };
    }
    if (parsed.length > MAX_PATCH_FILES) {
      return {
        ok: false,
        content: `patch covers ${parsed.length} files; exceeds ${MAX_PATCH_FILES}-file ceiling`,
        error: "PATCH_TOO_LARGE",
      };
    }

    const expectedMtimes =
      (metadata as ApplyPatchMetadata | undefined)?.mtimes ?? {};
    const reports: string[] = [];

    for (const file of parsed) {
      if (file.isNew) {
        const result = await applyNewFile(file, ctx.cwd);
        reports.push(result);
        if (result.startsWith("FAIL ")) {
          return { ok: false, content: reports.join("\n"), error: "PATCH_APPLY_FAILED" };
        }
        continue;
      }
      const target = await resolveAndValidate(file.path, {
        root: ctx.cwd,
        mustExist: true,
      });
      const stats = await fs.stat(target);
      if (stats.size > MAX_FILE_BYTES) {
        reports.push(
          `FAIL ${file.path}: file size ${stats.size} exceeds ${MAX_FILE_BYTES}-byte ceiling`,
        );
        return { ok: false, content: reports.join("\n"), error: "PATCH_FILE_TOO_LARGE" };
      }
      const expected = expectedMtimes[file.path];
      if (expected !== undefined && stats.mtimeMs !== expected) {
        reports.push(
          `FAIL ${file.path}: mtime moved between preview and apply; re-emit the patch`,
        );
        return { ok: false, content: reports.join("\n"), error: "PATCH_STALE_MTIME" };
      }
      const result = await withFileLock(target, async () => {
        const rawWithBom = await fs.readFile(target, "utf-8");
        const { content: rawWithEol, bom } = detectAndStripBom(rawWithBom);
        const eol = detectLineEnding(rawWithEol);
        let working = normalizeToLf(rawWithEol);
        for (let h = 0; h < file.hunks.length; h += 1) {
          const hunk = file.hunks[h]!;
          const oldNorm = normalizeToLf(hunk.oldString);
          const newNorm = normalizeToLf(hunk.newString);
          const out = applyHunkToContent(working, {
            oldString: oldNorm,
            newString: newNorm,
          });
          if (!out.ok) {
            return `FAIL ${file.path}: hunk ${h + 1} ${out.reason}`;
          }
          working = out.content;
        }
        const finalContent = restoreBom(restoreLineEnding(working, eol), bom);
        await atomicWriteText(target, finalContent);
        return `OK ${file.path}: ${file.hunks.length} hunk${file.hunks.length === 1 ? "" : "s"} applied`;
      });
      reports.push(result);
      if (result.startsWith("FAIL ")) {
        return { ok: false, content: reports.join("\n"), error: "PATCH_APPLY_FAILED" };
      }
    }

    return { ok: true, content: reports.join("\n") };
  },
  summarize: (input, result) => {
    const fileCount = (input.patch.match(/^--- /gm) ?? []).length;
    if (!result.ok) {
      return `ApplyPatch ${fileCount} file${fileCount === 1 ? "" : "s"} (failed${result.error ? `: ${result.error}` : ""})`;
    }
    return `ApplyPatch ${fileCount} file${fileCount === 1 ? "" : "s"}`;
  },
});

async function applyNewFile(file: FilePatch, cwd: string): Promise<string> {
  if (file.hunks.length !== 1) {
    return `FAIL ${file.path}: new-file patch must have exactly one hunk`;
  }
  const hunk = file.hunks[0]!;
  if (hunk.oldString.length > 0) {
    return `FAIL ${file.path}: new-file hunk must have no removed lines`;
  }
  const target = await resolveAndValidate(file.path, {
    root: cwd,
    mustExist: false,
  });
  try {
    await fs.access(target);
    return `FAIL ${file.path}: file already exists; use a modify-form patch instead`;
  } catch {
    // path does not exist yet — good
  }
  await withFileLock(target, async () => {
    await atomicWriteText(target, hunk.newString);
  });
  return `OK ${file.path}: created (${hunk.newString.split("\n").length} lines)`;
}
