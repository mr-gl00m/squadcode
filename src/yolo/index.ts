import { isAbsolute, relative, resolve } from "node:path";

export interface YoloSession {
  readonly cwd: string;
  readonly archiveDir: string;
  readonly isWindows: boolean;
  readonly checklistPath: string | null;
}

export type YoloGuardResult =
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

const WIN_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const UNIX_ABSOLUTE = /^\/[A-Za-z._-]/;

export function makeArchiveDir(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[:.]/g, "-");
  return `.archive/${iso}`;
}

export function createYoloSession(opts: {
  cwd: string;
  isWindows?: boolean;
  checklistPath?: string | null;
  now?: Date;
}): YoloSession {
  return {
    cwd: opts.cwd,
    archiveDir: makeArchiveDir(opts.now),
    isWindows: opts.isWindows ?? process.platform === "win32",
    checklistPath: opts.checklistPath ?? null,
  };
}

export function applyYoloShellGuard(
  command: string,
  session: YoloSession,
): YoloGuardResult {
  const sandbox = checkSandbox(command, session);
  if (sandbox !== null) return sandbox;
  return rewriteDeletes(command, session);
}

function checkSandbox(
  command: string,
  session: YoloSession,
): YoloGuardResult | null {
  // Whitespace-tokenize. Best-effort: ignores quoting, but absolute paths
  // outside cwd are conspicuous enough that this catches the common cases.
  const tokens = command.split(/\s+/).filter((t) => t.length > 0);
  for (const raw of tokens) {
    const token = stripWrappingQuotes(raw);
    if (!isAbsolutePathLike(token)) continue;
    if (!isUnderRoot(session.cwd, resolve(token))) {
      return {
        kind: "rejected",
        reason: `YOLO sandbox: absolute path "${token}" is outside cwd "${session.cwd}". Use a path relative to cwd.`,
      };
    }
  }
  // cd / Set-Location escapes. Resolve the target relative to cwd; reject if
  // it walks above. Doesn't try to track multi-step `cd a; cd ..; cd ..` —
  // each chunk is checked against cwd, which is the right floor anyway.
  const cdRegex = /\b(cd|Set-Location|sl|chdir)\s+([^\s;&|]+)/gi;
  for (const m of command.matchAll(cdRegex)) {
    const target = stripWrappingQuotes(m[2] ?? "");
    if (target.length === 0) continue;
    const abs = isAbsolute(target)
      ? resolve(target)
      : resolve(session.cwd, target);
    if (!isUnderRoot(session.cwd, abs)) {
      return {
        kind: "rejected",
        reason: `YOLO sandbox: "${m[1]} ${target}" resolves outside cwd "${session.cwd}".`,
      };
    }
  }
  return null;
}

function rewriteDeletes(
  command: string,
  session: YoloSession,
): YoloGuardResult {
  // Split on `;`, `&&`, `||`. Quoted separators are not respected — best-effort.
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
    const rewrite = tryRewriteChunk(piece, session);
    if (rewrite === null) {
      out.push(piece);
      continue;
    }
    changed = true;
    notes.push(rewrite.note);
    if (archiveSetup === null) {
      archiveSetup = ensureArchiveDirCommand(session);
    }
    out.push(rewrite.command);
  }

  if (!changed) return { kind: "ok", command };

  const sep = session.isWindows ? "; " : " && ";
  const rewritten = `${archiveSetup}${sep}${out.join("").trimStart()}`;
  return { kind: "rewritten", command: rewritten, notes };
}

interface ChunkRewrite {
  command: string;
  note: string;
}

function tryRewriteChunk(
  chunk: string,
  session: YoloSession,
): ChunkRewrite | null {
  const trimmed = chunk.trim();
  if (trimmed.length === 0) return null;
  const tokens = trimmed.split(/\s+/);
  const verbRaw = tokens[0];
  if (verbRaw === undefined) return null;
  const verb = verbRaw.toLowerCase();
  const verbs = session.isWindows ? DELETE_VERBS_WIN : DELETE_VERBS_POSIX;
  if (!verbs.has(verb)) return null;

  const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
  const cleaned = args
    .map((a) => stripWrappingQuotes(a))
    .filter((a) => a.length > 0);
  if (cleaned.length === 0) return null;

  if (session.isWindows) {
    const list = cleaned.map(quoteForPowerShell).join(", ");
    return {
      command: `Move-Item -Path ${list} -Destination ${quoteForPowerShell(session.archiveDir)} -Force -ErrorAction Stop`,
      note: `rewrote '${verb}' to Move-Item into ${session.archiveDir}/ (originals: ${cleaned.join(", ")})`,
    };
  }

  const list = cleaned.map(quoteForPosix).join(" ");
  return {
    command: `mv ${list} ${quoteForPosix(session.archiveDir + "/")}`,
    note: `rewrote '${verb}' to mv into ${session.archiveDir}/ (originals: ${cleaned.join(", ")})`,
  };
}

function ensureArchiveDirCommand(session: YoloSession): string {
  if (session.isWindows) {
    return `New-Item -ItemType Directory -Force -Path ${quoteForPowerShell(session.archiveDir)} | Out-Null`;
  }
  return `mkdir -p ${quoteForPosix(session.archiveDir)}`;
}

function isAbsolutePathLike(token: string): boolean {
  if (WIN_ABSOLUTE.test(token)) return true;
  if (UNIX_ABSOLUTE.test(token)) return true;
  return false;
}

function isUnderRoot(root: string, candidate: string): boolean {
  const rootAbs = resolve(root);
  const candAbs = resolve(candidate);
  if (rootAbs === candAbs) return true;
  const rel = relative(rootAbs, candAbs);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

function stripWrappingQuotes(s: string): string {
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

export function yoloSystemPromptAddendum(session: YoloSession): string {
  const checklistLine = session.checklistPath
    ? `A working checklist lives at ${session.checklistPath}. Work it top-down. As you finish an item, edit the checklist to mark it done. If you find a new step, add it to the checklist before doing it.`
    : "No checklist is loaded. If the task is non-trivial, draft one in checklist.txt before acting.";
  return [
    "",
    "## YOLO mode",
    "Permission prompts are off. You can run tools without asking. Three rails apply:",
    `1. Sandbox. All work stays under cwd (${session.cwd}). Absolute paths outside cwd, and 'cd' targets that resolve outside cwd, are rejected by the Shell tool. If you need a file from outside, copy it in first; don't reach out.`,
    `2. Deletes are archived, not destroyed. rm / Remove-Item / del / unlink calls in the Shell tool are rewritten to move the target into ${session.archiveDir}/. The file is not gone — if you need it back, look there. Don't try to "really" delete; the rewrite is the contract.`,
    `3. Checklist. ${checklistLine}`,
    "Don't ask the user for confirmation between steps. Do the work. Stop only when the checklist is done, you hit a real blocker, or you need information you can't derive locally.",
  ].join("\n");
}
