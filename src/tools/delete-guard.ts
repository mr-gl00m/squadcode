// Always-on delete failsafe. The Shell tool runs every command through this
// before spawning it: simple deletes (`rm x`, `Remove-Item x`, `del x`) are
// rewritten to MOVE the target into a recovery folder instead of destroying
// it, and deletes that can't be safely rewritten (pipelines, .NET delete
// methods, `git clean`, `rimraf`, shell-outs) are rejected outright. The
// guarantee: a delete is either archived or blocked — it never silently
// destroys. Lifted out of YOLO mode (src/yolo) so it applies in every mode,
// including --dangerously-skip-permissions. The user can opt out per-run with
// --dangerously-allow-deletes; the model never can.

import { isAbsolute, relative, resolve } from "node:path";

export type DeleteGuardResult =
  | { kind: "ok"; command: string }
  | { kind: "rewritten"; command: string; notes: string[] }
  | { kind: "rejected"; reason: string };

const DELETE_VERBS_POSIX = new Set(["rm", "unlink"]);
const DELETE_VERBS_WIN = new Set([
  "rm",
  "del",
  "erase",
  "unlink",
  "remove-item",
  "ri",
]);

// Interpreters a delete can hide behind (`cmd /c del x`, `bash -c "rm x"`).
const SHELL_OUT_VERBS = new Set([
  "cmd",
  "powershell",
  "pwsh",
  "sh",
  "bash",
  "zsh",
  "wsl",
]);

// .NET / object delete methods that destroy without a recognizable verb:
// [System.IO.File]::Delete(...), [IO.Directory]::Delete(...), (Get-Item x).Delete()
const NET_DELETE = /::\s*delete\b|\.delete\s*\(/i;
// Tools whose entire job is recursive deletion and that can't be rewritten.
const RIMRAF = /(?:^|[\\/\s])rimraf(?:\s|$)/i;
const GIT_CLEAN = /\bgit\s+clean\b/i;

export function makeDeletedDir(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[:.]/g, "-");
  return `.deleted/${iso}`;
}

export function rewriteDeleteCommand(
  command: string,
  opts: { archiveDir: string; isWindows: boolean; cwd: string },
): DeleteGuardResult {
  // Split on `;`, `&&`, `||` (separators kept so the command can be rebuilt).
  const SEP = /(\s*(?:&&|\|\||;)\s*)/g;
  const parts = command.split(SEP);
  const out: string[] = [];
  const notes: string[] = [];
  let changed = false;
  let archiveSetup: string | null = null;

  for (const piece of parts) {
    if (/^\s*(?:&&|\|\||;)\s*$/.test(piece)) {
      out.push(piece);
      continue;
    }
    const verdict = classifyChunk(piece, opts);
    if (verdict.kind === "reject") {
      return { kind: "rejected", reason: verdict.reason };
    }
    if (verdict.kind === "rewrite") {
      changed = true;
      notes.push(verdict.note);
      if (archiveSetup === null) {
        archiveSetup = ensureArchiveDirCommand(opts.archiveDir, opts.isWindows);
      }
      out.push(verdict.command);
      continue;
    }
    out.push(piece);
  }

  if (!changed) return { kind: "ok", command };
  const sep = opts.isWindows ? "; " : " && ";
  const rewritten = `${archiveSetup}${sep}${out.join("").trimStart()}`;
  return { kind: "rewritten", command: rewritten, notes };
}

type ChunkVerdict =
  | { kind: "passthrough" }
  | { kind: "rewrite"; command: string; note: string }
  | { kind: "reject"; reason: string };

function classifyChunk(
  chunk: string,
  opts: { archiveDir: string; isWindows: boolean; cwd: string },
): ChunkVerdict {
  const trimmed = chunk.trim();
  if (trimmed.length === 0) return { kind: "passthrough" };

  const verbs = opts.isWindows ? DELETE_VERBS_WIN : DELETE_VERBS_POSIX;
  const graveyard = topLevelDir(opts.archiveDir);

  // Unrewritable delete shapes — block rather than let them destroy silently.
  if (NET_DELETE.test(trimmed)) {
    return reject(
      "a .NET or object delete method (e.g. [IO.File]::Delete, .Delete())",
      graveyard,
    );
  }
  if (GIT_CLEAN.test(trimmed)) {
    return reject(
      "`git clean`, which permanently removes untracked files",
      graveyard,
    );
  }
  if (RIMRAF.test(trimmed)) {
    return reject("`rimraf`", graveyard);
  }

  // A delete at any pipeline-segment boundary: its targets stream from stdin
  // (`Get-ChildItem *.log | Remove-Item`) so there's nothing to move. Also
  // catches `rm x | tee` and `find . | xargs rm`.
  const segments = trimmed
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length > 1 && segments.some((s) => segmentDeletes(s, verbs))) {
    return reject(
      "a delete inside a pipeline (its targets come from stdin and can't be archived)",
      graveyard,
    );
  }

  const tokens = trimmed.split(/\s+/);
  const firstVerb = normalizeVerb(tokens[0] ?? "");

  // `find ... -delete` / `find ... -exec rm` — find does its own deletion,
  // bypassing the delete verbs above.
  if (firstVerb === "find") {
    const hasDelete = tokens.includes("-delete");
    const hasExecDelete =
      (tokens.includes("-exec") || tokens.includes("-execdir")) &&
      tokens.some((t) => verbs.has(normalizeVerb(stripWrappingQuotes(t))));
    if (hasDelete || hasExecDelete) {
      return reject("a `find` that deletes (-delete or -exec rm)", graveyard);
    }
  }

  // A delete handed to another shell/interpreter (`cmd /c del x`).
  if (
    SHELL_OUT_VERBS.has(firstVerb) &&
    tokens
      .slice(1)
      .some((t) => verbs.has(normalizeVerb(stripWrappingQuotes(t))))
  ) {
    return reject(
      "a delete run through another shell or interpreter",
      graveyard,
    );
  }

  // Simple delete: a recognized delete verb at the start of the chunk.
  if (!verbs.has(firstVerb)) return { kind: "passthrough" };

  const positional = tokens
    .slice(1)
    .filter((t) => !t.startsWith("-"))
    .map(stripWrappingQuotes)
    .filter((t) => t.length > 0);
  if (positional.length === 0) {
    return reject("a delete with no explicit path to archive", graveyard);
  }

  // Targets already inside the recovery folder get a real delete — otherwise
  // the folder could never be emptied. If every target is in there, leave the
  // command untouched.
  const graveyardRoot = resolve(opts.cwd, graveyard);
  const allInGraveyard = positional.every((p) =>
    isUnderRoot(graveyardRoot, resolve(opts.cwd, p)),
  );
  if (allInGraveyard) return { kind: "passthrough" };

  if (opts.isWindows) {
    const list = positional.map(quoteForPowerShell).join(", ");
    return {
      kind: "rewrite",
      command: `Move-Item -Path ${list} -Destination ${quoteForPowerShell(opts.archiveDir)} -Force -ErrorAction Stop`,
      note: `moved ${positional.join(", ")} into ${opts.archiveDir}/ instead of deleting`,
    };
  }
  const list = positional.map(quoteForPosix).join(" ");
  return {
    kind: "rewrite",
    command: `mv ${list} ${quoteForPosix(`${opts.archiveDir}/`)}`,
    note: `moved ${positional.join(", ")} into ${opts.archiveDir}/ instead of deleting`,
  };
}

function reject(what: string, graveyard: string): ChunkVerdict {
  return {
    kind: "reject",
    reason: `Delete guard blocked this command: it contains ${what}, which can't be rewritten to a recoverable move. Delete a specific path with \`Remove-Item <path>\` (Windows) or \`rm <path>\` (POSIX) — the target is moved into ${graveyard}/ where you can recover it. If a permanent delete is genuinely required, the user can relaunch with --dangerously-allow-deletes.`,
  };
}

function ensureArchiveDirCommand(
  archiveDir: string,
  isWindows: boolean,
): string {
  if (isWindows) {
    return `New-Item -ItemType Directory -Force -Path ${quoteForPowerShell(archiveDir)} | Out-Null`;
  }
  return `mkdir -p ${quoteForPosix(archiveDir)}`;
}

// True when a single pipeline segment is, or drives, a delete: it starts with
// a delete verb, or it's an xargs wrapper carrying one (`... | xargs rm`).
function segmentDeletes(segment: string, verbs: Set<string>): boolean {
  const tokens = segment.split(/\s+/).filter((t) => t.length > 0);
  const head = normalizeVerb(tokens[0] ?? "");
  if (verbs.has(head)) return true;
  if (head === "xargs") {
    return tokens
      .slice(1)
      .some((t) => verbs.has(normalizeVerb(stripWrappingQuotes(t))));
  }
  return false;
}

function normalizeVerb(token: string): string {
  const noPath = token.split(/[\\/]/).pop() ?? token;
  return noPath.replace(/\.(exe|cmd|bat|ps1|com)$/i, "").toLowerCase();
}

// First path segment of a (possibly nested) dir: `.deleted/<ts>` -> `.deleted`.
function topLevelDir(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const slash = norm.indexOf("/");
  return slash === -1 ? norm : norm.slice(0, slash);
}

// Shared with the YOLO path guard in src/yolo/index.ts.
export function isUnderRoot(root: string, candidate: string): boolean {
  const rootAbs = resolve(root);
  const candAbs = resolve(candidate);
  if (rootAbs === candAbs) return true;
  const rel = relative(rootAbs, candAbs);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

export function stripWrappingQuotes(s: string): string {
  if (s.length < 2) return s;
  const first = s[0];
  const last = s[s.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return s.slice(1, -1);
  }
  return s;
}

function quoteForPowerShell(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function quoteForPosix(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
