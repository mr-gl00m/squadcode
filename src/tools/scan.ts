import { promises as fs } from "node:fs";
import { join } from "node:path";
import { isProtectedPath } from "./protected.js";

const PRUNED_DIRS = new Set([
  // VCS metadata
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  // Build outputs
  "dist",
  "build",
  "target",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "coverage",
  // Python
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  // Squad's own state
  ".squad",
]);

export async function* walkFiles(root: string): AsyncIterable<string> {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    const entries = await fs
      .readdir(dir, { withFileTypes: true })
      .catch(() => null);
    if (entries === null) continue;
    for (const entry of entries) {
      if (PRUNED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isProtectedPath(full, { cwd: root })) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        yield full;
      }
    }
  }
}

export function compileGlob(pattern: string): RegExp {
  // Two sentinels so `**/` (zero-or-more path segments INCLUDING the slash)
  // collapses correctly against paths that have zero intermediate segments.
  // Without the SENT_DSS step, `src/**/*.ts` requires a literal `/` between
  // the `**` substitution and the trailing `*.ts`, which silently drops
  // every top-level file in src/.
  const SENT_DSS = "__GLOB_DSS__";
  const SENT_DS = "__GLOB_DS__";
  // Escape `[` and `]` as literals so a pattern with an unbalanced bracket
  // (`foo[bar`) doesn't produce an unterminated character class in the
  // compiled regex — `new RegExp` would otherwise throw SyntaxError out of
  // matchesGlob/Glob/Grep/IndexList. This treats bracket-class glob syntax
  // (`[abc]`, `[!a-z]`) as a literal match against those characters; squad's
  // glob surface doesn't promise POSIX bracket classes, only `*`, `**`, `?`.
  const escaped = pattern
    .replace(/\*\*\//g, SENT_DSS)
    .replace(/\*\*/g, SENT_DS)
    .replace(/[.+^$()|{}[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(new RegExp(SENT_DSS, "g"), "(?:.*/)?")
    .replace(new RegExp(SENT_DS, "g"), ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function matchesGlob(filePath: string, pattern: string): boolean {
  const re = compileGlob(pattern);
  return re.test(filePath.replace(/\\/g, "/"));
}
