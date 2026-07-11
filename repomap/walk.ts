import { existsSync, promises as fs } from "node:fs";
import { extname, relative, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import { walkFiles } from "../tools/scan.js";
import type { Language } from "./types.js";

const EXT_TO_LANG: Record<string, Language> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".rs": "rust",
  ".go": "go",
};

// Repo-map-specific exclusions beyond what scan.walkFiles already prunes.
// `.rnd/` is the convention for "we ripped a reference project under here for
// analysis" — never source the project map from competitor code dumps.
const EXTRA_PRUNE_PATTERNS = [
  "**/.rnd/**",
  "**/.bugs/**",
  "**/.drift/**",
  "**/.dup/**",
  "**/.red_team/**",
  "**/.essays/**",
];

export function languageFor(path: string): Language | null {
  const ext = extname(path).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

async function loadIgnore(root: string): Promise<Ignore> {
  const ig = ignore();
  ig.add(EXTRA_PRUNE_PATTERNS);
  const gitignorePath = `${root}${sep}.gitignore`;
  if (existsSync(gitignorePath)) {
    try {
      const text = await fs.readFile(gitignorePath, "utf-8");
      ig.add(text);
    } catch {
      // ignore: best-effort
    }
  }
  return ig;
}

export interface WalkEntry {
  path: string;
  lang: Language;
  size: number;
  mtimeMs: number;
}

export async function* walkRepo(
  root: string,
  maxFileBytes: number,
): AsyncIterable<WalkEntry> {
  const ig = await loadIgnore(root);
  for await (const path of walkFiles(root)) {
    const lang = languageFor(path);
    if (lang === null) continue;
    const rel = relative(root, path).replace(/\\/g, "/");
    if (rel === "" || ig.ignores(rel)) continue;
    const stat = await fs.stat(path).catch(() => null);
    if (stat === null) continue;
    if (!stat.isFile()) continue;
    if (stat.size > maxFileBytes) continue;
    yield { path, lang, size: stat.size, mtimeMs: stat.mtimeMs };
  }
}
