import { access, open, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  type ContextFragment,
  createContextFragment,
} from "./context/fragment.js";

const ROOT_MARKERS = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"];
const MAX_INSTRUCTION_BYTES = 64 * 1024;

export async function loadProjectInstructions(
  cwd: string,
): Promise<ContextFragment> {
  const canonicalCwd = await realpath(cwd).catch(() => resolve(cwd));
  const root = await findProjectRoot(canonicalCwd);
  const directories = directoriesFromRoot(root, canonicalCwd);
  const sections: Array<{ path: string; content: string }> = [];
  let remaining = MAX_INSTRUCTION_BYTES;
  for (const directory of directories) {
    const path = await instructionPath(directory);
    if (!path || remaining <= 0) continue;
    const content = await readBoundedInstruction(path, root, remaining);
    if (content === null) continue;
    remaining -= Buffer.byteLength(content, "utf8");
    sections.push({
      path: relative(root, path) || basename(path),
      content,
    });
  }
  const body =
    sections.length > 0
      ? "Project instructions are ordered root-to-cwd; later sections are more specific. Follow them unless they conflict with higher-priority safety or user instructions.\n\n" +
        sections
          .map((section) => `## ${section.path}\n${section.content}`)
          .join("\n\n")
      : "No AGENTS.md or .squad/instructions.md file is active for this project.";
  return createContextFragment({
    source: "project",
    type: "instructions",
    key: "active",
    role: "user",
    merge: "replace",
    visibility: "model",
    trust: "untrusted-environment",
    maxBytes: MAX_INSTRUCTION_BYTES,
    maxTokens: MAX_INSTRUCTION_BYTES / 4,
    attributes: { root, files: sections.length },
    content: body,
  });
}

async function readBoundedInstruction(
  path: string,
  root: string,
  remaining: number,
): Promise<string | null> {
  const target = await realpath(path).catch(() => null);
  if (!target || !isWithin(root, target)) return null;
  const info = await stat(target);
  if (!info.isFile()) return null;
  const length = Math.min(info.size, remaining);
  const buffer = Buffer.alloc(length);
  const handle = await open(target, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function findProjectRoot(cwd: string): Promise<string> {
  let current = resolve(cwd);
  let fallback: string | null = null;
  for (;;) {
    if (await exists(join(current, ".git"))) return current;
    if (!fallback) {
      for (const marker of ROOT_MARKERS) {
        if (await exists(join(current, marker))) {
          fallback = current;
          break;
        }
      }
    }
    const parent = dirname(current);
    if (parent === current) return fallback ?? resolve(cwd);
    current = parent;
  }
}

function directoriesFromRoot(root: string, cwd: string): string[] {
  const directories: string[] = [];
  let current = cwd;
  for (;;) {
    directories.push(current);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) return [cwd];
    current = parent;
  }
  return directories.reverse();
}

async function instructionPath(directory: string): Promise<string | null> {
  const squad = join(directory, ".squad", "instructions.md");
  if (await exists(squad)) return squad;
  const agents = join(directory, "AGENTS.md");
  return (await exists(agents)) ? agents : null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}
