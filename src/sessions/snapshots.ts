import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildSanitizedChildEnv } from "../tools/shell-env.js";

const DEFAULT_SNAPSHOT_DIR = join(homedir(), ".squad", "snapshots");
const SNAPSHOT_EXCLUDES = [
  ".git/",
  ".squad/",
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_ed25519*",
  "secrets.json",
  "secrets/",
].join("\n");

export interface WorkspaceSnapshotOptions {
  cwd: string;
  sessionId: string;
  turnId: string;
  baseDir?: string;
  advanceRef?: boolean;
}

export async function captureWorkspaceSnapshot(
  opts: WorkspaceSnapshotOptions,
): Promise<string> {
  const paths = snapshotPaths(opts.cwd, opts.sessionId, opts.baseDir);
  await ensureSnapshotRepository(paths.repository);
  await runSnapshotGit(paths.repository, opts.cwd, ["add", "-A", "--", "."]);
  const tree = await runSnapshotGit(paths.repository, opts.cwd, ["write-tree"]);
  const parent = await trySnapshotGit(paths.repository, opts.cwd, [
    "rev-parse",
    "--verify",
    paths.ref,
  ]);
  const args = ["commit-tree", tree];
  if (parent) args.push("-p", parent);
  args.push("-m", `Squad turn snapshot ${opts.turnId}`);
  const commit = await runSnapshotGit(paths.repository, opts.cwd, args);
  if (opts.advanceRef !== false) {
    await runSnapshotGit(paths.repository, opts.cwd, [
      "update-ref",
      paths.ref,
      commit,
    ]);
  }
  return commit;
}

export async function restoreWorkspaceSnapshot(input: {
  cwd: string;
  sessionId: string;
  snapshot: string;
  baseDir?: string;
}): Promise<void> {
  const paths = snapshotPaths(input.cwd, input.sessionId, input.baseDir);
  await runSnapshotGit(paths.repository, input.cwd, [
    "rev-parse",
    "--verify",
    `${input.snapshot}^{commit}`,
  ]);
  await runSnapshotGit(paths.repository, input.cwd, [
    "read-tree",
    "--reset",
    "-u",
    input.snapshot,
  ]);
  await runSnapshotGit(paths.repository, input.cwd, [
    "update-ref",
    paths.ref,
    input.snapshot,
  ]);
}

async function ensureSnapshotRepository(repository: string): Promise<void> {
  await mkdir(repository, { recursive: true });
  const head = await tryGit([
    "--git-dir",
    repository,
    "rev-parse",
    "--is-bare-repository",
  ]);
  if (head !== "true") {
    await runGit(["init", "--bare", repository], process.cwd());
  }
  await mkdir(join(repository, "info"), { recursive: true });
  await writeFile(
    join(repository, "info", "exclude"),
    `${SNAPSHOT_EXCLUDES}\n`,
    "utf8",
  );
}

function snapshotPaths(
  cwd: string,
  sessionId: string,
  baseDir?: string,
): {
  repository: string;
  ref: string;
} {
  const project = hash(resolve(cwd).toLowerCase()).slice(0, 24);
  const session = hash(sessionId).slice(0, 24);
  return {
    repository: join(baseDir ?? DEFAULT_SNAPSHOT_DIR, project, "repo.git"),
    ref: `refs/squad/sessions/${session}`,
  };
}

async function runSnapshotGit(
  repository: string,
  cwd: string,
  args: string[],
): Promise<string> {
  return await runGit(
    ["--git-dir", repository, "--work-tree", resolve(cwd), ...args],
    cwd,
  );
}

async function trySnapshotGit(
  repository: string,
  cwd: string,
  args: string[],
): Promise<string | null> {
  try {
    return await runSnapshotGit(repository, cwd, args);
  } catch {
    return null;
  }
}

async function tryGit(args: string[]): Promise<string | null> {
  try {
    return await runGit(args, process.cwd());
  } catch {
    return null;
  }
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: snapshotEnvironment(),
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `snapshot git ${args[args.length - 1] ?? "command"} failed: ${stderr.trim() || error.message}`,
            ),
          );
          return;
        }
        resolvePromise(stdout.trim());
      },
    );
  });
}

function snapshotEnvironment(): Record<string, string> {
  const env = buildSanitizedChildEnv(process.env);
  for (const name of Object.keys(env)) {
    if (name.toUpperCase().startsWith("GIT_")) delete env[name];
  }
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return {
    ...env,
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Squad Snapshot",
    GIT_AUTHOR_EMAIL: "snapshot@squad.invalid",
    GIT_COMMITTER_NAME: "Squad Snapshot",
    GIT_COMMITTER_EMAIL: "snapshot@squad.invalid",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
