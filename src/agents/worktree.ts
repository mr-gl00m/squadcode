import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { logger } from "../logger.js";

const exec = promisify(execFile);

// A git worktree an isolated (usually external-CLI) subagent runs in, so its
// edits land in a separate checkout the parent can diff and choose to merge —
// not on top of the user's working tree. Detached at HEAD; the parent reviews
// via `git -C <path> diff`. remove() tears it down once merged or discarded.
export interface AgentWorktree {
  path: string;
  remove(): Promise<void>;
}

export interface CreateAgentWorktreeOptions {
  required?: boolean;
  runId?: string;
}

export class WorktreeRequiredError extends Error {
  readonly code = "WORKTREE_REQUIRED";

  constructor(message: string) {
    super(message);
    this.name = "WorktreeRequiredError";
  }
}

function safePathPart(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return cleaned.length > 0 && cleaned !== "." && cleaned !== ".."
    ? cleaned
    : "run";
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}

async function copyWorktreeIncludes(
  cwd: string,
  worktree: string,
): Promise<void> {
  const includePath = join(cwd, ".worktreeinclude");
  let entries: string[];
  try {
    entries = (await readFile(includePath, "utf-8"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  const root = resolve(cwd);
  const destinationRoot = resolve(worktree);
  for (const entry of entries) {
    if (isAbsolute(entry)) {
      throw new Error(`.worktreeinclude entry must be relative: ${entry}`);
    }
    const source = resolve(root, entry);
    const destination = resolve(destinationRoot, entry);
    if (!isWithin(root, source) || !isWithin(destinationRoot, destination)) {
      throw new Error(`.worktreeinclude entry escapes the project: ${entry}`);
    }

    let sourceReal: string;
    try {
      sourceReal = await realpath(source);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (!isWithin(root, sourceReal)) {
      throw new Error(`.worktreeinclude source escapes the project: ${entry}`);
    }
    const sourceStat = await stat(sourceReal);
    if (!sourceStat.isFile()) {
      throw new Error(`.worktreeinclude supports regular files only: ${entry}`);
    }
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(sourceReal, destination);
  }
}

async function removeGitWorktree(cwd: string, dir: string): Promise<void> {
  await exec("git", ["-C", cwd, "worktree", "remove", "--force", dir]);
}

// Creates .squad/worktrees/<runId>-<label>/. Optional callers may degrade to
// in-place execution when cwd is not a usable git repo. Callers whose safety
// contract requires isolation pass required:true and receive a hard failure.
export async function createAgentWorktree(
  cwd: string,
  label: string,
  opts: CreateAgentWorktreeOptions = {},
): Promise<AgentWorktree | null> {
  const runId = safePathPart(opts.runId ?? randomUUID());
  const safeLabel = safePathPart(label);
  const dir = resolve(cwd, ".squad", "worktrees", `${runId}-${safeLabel}`);
  try {
    // HEAD must resolve — a bare or commitless repo can't host a worktree.
    await exec("git", ["-C", cwd, "rev-parse", "HEAD"]);
  } catch {
    logger.debug(
      { cwd, label, runId },
      "not a git repo with commits; skipping worktree isolation",
    );
    if (opts.required) {
      throw new WorktreeRequiredError(
        `worktree isolation is required for ${label}, but ${cwd} is not a git repository with a commit`,
      );
    }
    return null;
  }
  try {
    await mkdir(join(cwd, ".squad", "worktrees"), { recursive: true });
    await exec("git", ["-C", cwd, "worktree", "add", "--detach", dir, "HEAD"]);
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), dir },
      "git worktree add failed",
    );
    if (opts.required) {
      throw new WorktreeRequiredError(
        `worktree isolation is required for ${label}, but git worktree add failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return null;
  }
  try {
    await copyWorktreeIncludes(cwd, dir);
  } catch (err: unknown) {
    await removeGitWorktree(cwd, dir).catch(() => undefined);
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), dir },
      "worktree include copy failed",
    );
    if (opts.required) {
      throw new WorktreeRequiredError(
        `worktree isolation is required for ${label}, but .worktreeinclude copy failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return null;
  }
  return {
    path: dir,
    remove: async (): Promise<void> => {
      try {
        await removeGitWorktree(cwd, dir);
      } catch (err: unknown) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), dir },
          "git worktree remove failed",
        );
      }
    },
  };
}
