import { promises as fs } from "node:fs";
import { relative } from "node:path";
import type { FileSymbols, SymbolDef } from "./types.js";

export interface Candidate {
  file: FileSymbols;
  def: SymbolDef;
  score: number;
}

const sourceCache = new Map<string, string[]>();

// Lines longer than this are almost always minified bundles or generated
// blobs. Truncate them so a single capture into such a file doesn't dump
// the entire payload into the prompt.
const MAX_RENDERED_LINE_CHARS = 200;

async function readLines(path: string): Promise<string[]> {
  const cached = sourceCache.get(path);
  if (cached) return cached;
  let text: string;
  try {
    text = await fs.readFile(path, "utf-8");
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/);
  sourceCache.set(path, lines);
  return lines;
}

function truncateLine(s: string): string {
  if (s.length <= MAX_RENDERED_LINE_CHARS) return s;
  return `${s.slice(0, MAX_RENDERED_LINE_CHARS)}… [+${s.length - MAX_RENDERED_LINE_CHARS} chars]`;
}

export function clearSourceCache(): void {
  sourceCache.clear();
}

// Coarse token estimate: ~4 chars/token. Matches aider's repomap budget heuristic.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function renderCandidates(
  candidates: Candidate[],
  cwd: string,
): Promise<string> {
  // Group by file, keep file order by best-scoring candidate
  const byFile = new Map<string, Candidate[]>();
  for (const c of candidates) {
    let list = byFile.get(c.file.path);
    if (!list) {
      list = [];
      byFile.set(c.file.path, list);
    }
    list.push(c);
  }

  const fileEntries = [...byFile.entries()].sort((a, b) => {
    const aBest = Math.max(...a[1].map((c) => c.score));
    const bBest = Math.max(...b[1].map((c) => c.score));
    return bBest - aBest;
  });

  const out: string[] = [];
  for (const [path, defs] of fileEntries) {
    const rel = relative(cwd, path).replace(/\\/g, "/");
    out.push(`${rel}:`);
    defs.sort((a, b) => a.def.line - b.def.line);
    const lines = await readLines(path);
    let lastEnd = -1;
    for (const c of defs) {
      const start = c.def.line;
      // Show only the def signature line. Multi-line definitions (classes,
      // long function sigs) get their endLine too, capped at 3 lines to keep
      // the map tight.
      const end = Math.min(c.def.endLine, start + 2);
      if (start <= lastEnd) continue;
      if (lastEnd >= 0 && start > lastEnd + 1) {
        out.push("  ...");
      }
      for (let l = start; l <= end && l < lines.length; l++) {
        const lineText = truncateLine(lines[l] ?? "");
        out.push(`${String(l + 1).padStart(4, " ")}│ ${lineText}`);
      }
      lastEnd = end;
    }
    out.push("");
  }
  return out.join("\n");
}
