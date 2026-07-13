import { posix, win32 } from "node:path";
import { parseLiteralShellCommand } from "../permissions/shell-safety.js";

export interface YoloSession {
  readonly cwd: string;
  readonly archiveDir: string;
  readonly isWindows: boolean;
  readonly checklistPath: string | null;
}

export type YoloPathGuardViolation = { kind: "rejected"; reason: string };

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

// YOLO path guard: reject literal absolute paths outside cwd and
// cd/Set-Location targets that walk above cwd. This is an application-level
// command check, not process or OS isolation. Returns null when the parsed
// command is in-bounds. Delete archiving is handled separately by the always-on
// delete guard (src/tools/delete-guard.ts), which runs after this check.
export function checkYoloPathGuard(
  command: string,
  session: YoloSession,
): YoloPathGuardViolation | null {
  const platform = session.isWindows ? "win32" : "linux";
  const parsed = parseLiteralShellCommand(command, { platform });
  if (!parsed) {
    return {
      kind: "rejected",
      reason:
        "YOLO path guard: command syntax could not be parsed as literal words and approved operators",
    };
  }
  const pathApi = session.isWindows ? win32 : posix;
  for (const parsedCommand of parsed.commands) {
    const tokens = [parsedCommand.executable, ...parsedCommand.args];
    for (const { value: token } of tokens) {
      const equals = token.indexOf("=");
      const candidates = [
        token,
        ...(equals >= 0 ? [token.slice(equals + 1)] : []),
      ];
      const escaped = candidates.find((candidate) => {
        const absolute = pathApi.isAbsolute(candidate);
        // A Windows drive-relative path (`D:secrets.txt`, drive letter with no
        // separator) is not absolute per isAbsolute and has no climb, but it
        // resolves against that drive's current directory, outside cwd and not
        // deterministically knowable. Reject it like an out-of-cwd path.
        const driveRelative =
          session.isWindows && /^[a-zA-Z]:(?![\\/])/.test(candidate);
        const climbs =
          candidate === ".." ||
          candidate.startsWith("../") ||
          candidate.startsWith("..\\") ||
          candidate.includes("/../") ||
          candidate.includes("\\..\\");
        if (!absolute && !climbs && !driveRelative) return false;
        if (driveRelative) return true;
        const resolved = absolute
          ? pathApi.resolve(candidate)
          : pathApi.resolve(session.cwd, candidate);
        return !isWithinPath(session.cwd, resolved, session.isWindows);
      });
      if (escaped !== undefined) {
        return {
          kind: "rejected",
          reason: `YOLO path guard: command "${parsedCommand.executable.value}" uses path "${escaped}", which resolves outside cwd "${session.cwd}". Use a path under cwd.`,
        };
      }
    }
    const verb = parsedCommand.executable.value
      .replace(/\.(exe|cmd|bat|com|ps1)$/i, "")
      .toLowerCase();
    if (!["cd", "set-location", "sl", "chdir"].includes(verb)) continue;
    const target = parsedCommand.args[0]?.value;
    if (!target) continue;
    const absolute = pathApi.isAbsolute(target)
      ? pathApi.resolve(target)
      : pathApi.resolve(session.cwd, target);
    if (!isWithinPath(session.cwd, absolute, session.isWindows)) {
      return {
        kind: "rejected",
        reason: `YOLO path guard: "${parsedCommand.executable.value} ${target}" resolves outside cwd "${session.cwd}".`,
      };
    }
  }
  return null;
}

function isWithinPath(
  root: string,
  target: string,
  isWindows: boolean,
): boolean {
  const pathApi = isWindows ? win32 : posix;
  const rootAbsolute = pathApi.resolve(root);
  const targetAbsolute = pathApi.resolve(target);
  const rel = pathApi.relative(rootAbsolute, targetAbsolute);
  return (
    rel === "" ||
    (!pathApi.isAbsolute(rel) &&
      rel !== ".." &&
      !rel.startsWith(`..${pathApi.sep}`))
  );
}

export function yoloSystemPromptAddendum(session: YoloSession): string {
  const checklistLine = session.checklistPath
    ? `A working checklist lives at ${session.checklistPath}. Work it top-down. As you finish an item, edit the checklist to mark it done. If you find a new step, add it to the checklist before doing it.`
    : "No checklist is loaded. If the task is non-trivial, draft one in checklist.txt before acting.";
  return [
    "",
    "## YOLO mode",
    "Permission prompts are off. Tool-boundary allow/deny policy and three application-level rails still apply:",
    `1. Path guard. Keep all work under cwd (${session.cwd}). Literal absolute paths outside cwd, path climbs, and 'cd' targets that resolve outside cwd are rejected by the Shell tool; unsupported shell syntax fails closed. This is not OS isolation: it does not restrict process capabilities, syscalls, or network access.`,
    `2. Deletes are archived, not destroyed. rm / Remove-Item / del / unlink calls in the Shell tool are rewritten to move the target into ${session.archiveDir}/. The file is not gone — if you need it back, look there. Don't try to "really" delete; the rewrite is the contract.`,
    `3. Checklist. ${checklistLine}`,
    "Don't ask the user for confirmation between steps. Do the work. Stop only when the checklist is done, you hit a real blocker, or you need information you can't derive locally.",
  ].join("\n");
}
