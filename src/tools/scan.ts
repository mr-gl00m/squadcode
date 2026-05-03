import { promises as fs } from "node:fs";
import { join } from "node:path";

const PRUNED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".squad",
  ".venv",
  "__pycache__",
]);

export async function* walkFiles(root: string): AsyncIterable<string> {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (PRUNED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        yield full;
      }
    }
  }
}

export function compileGlob(pattern: string): RegExp {
  const SENTINEL = "GLOB_DOUBLESTAR";
  const escaped = pattern
    .replace(/[.+^$()|{}\\]/g, "\\$&")
    .replace(/\*\*/g, SENTINEL)
    .replace(/\*/g, "[^/]*")
    .replace(new RegExp(SENTINEL, "g"), ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`, "i");
}

export function matchesGlob(filePath: string, pattern: string): boolean {
  const re = compileGlob(pattern);
  return re.test(filePath.replace(/\\/g, "/"));
}
