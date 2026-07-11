import { relative } from "node:path";
import {
  type ContextFragment,
  createContextFragment,
} from "../context/fragment.js";
import { fitToBudget } from "./budget.js";
import { defaultCacheRoot, readCached, writeCached } from "./cache.js";
import { buildGraph } from "./graph.js";
import { pagerank, personalizationFor } from "./pagerank.js";
import { type Candidate, clearSourceCache } from "./render.js";
import { extractSymbols } from "./symbols.js";
import type { FileSymbols, RepoMapOptions, RepoMapResult } from "./types.js";
import { walkRepo } from "./walk.js";

const DEFAULT_MAX_FILE_BYTES = 1_000_000;

export function repoMapFragment(text: string, cwd: string): ContextFragment {
  return createContextFragment({
    source: "repomap",
    type: "repository_map",
    key: cwd,
    role: "system",
    merge: "replace",
    visibility: "model",
    trust: "untrusted-environment",
    content: text,
    maxBytes: 16 * 1024,
    maxTokens: 4_096,
    attributes: { cwd },
  });
}

export async function buildRepoMap(
  opts: RepoMapOptions,
): Promise<RepoMapResult> {
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const cacheRoot = opts.cacheDir ?? defaultCacheRoot(opts.cwd);

  const symbols: FileSymbols[] = [];
  let considered = 0;
  for await (const entry of walkRepo(opts.cwd, maxFileBytes)) {
    considered++;
    let fs: FileSymbols | null = await readCached(
      cacheRoot,
      entry.path,
      entry.mtimeMs,
      entry.size,
    );
    if (!fs) {
      fs = await extractSymbols(
        entry.path,
        entry.lang,
        entry.mtimeMs,
        entry.size,
      );
      if (fs) {
        await writeCached(cacheRoot, entry.path, fs);
      }
    }
    if (fs && (fs.defs.length > 0 || fs.refs.length > 0)) {
      symbols.push(fs);
    }
  }

  if (symbols.length === 0) {
    clearSourceCache();
    return {
      text: "",
      fileMentions: [],
      filesConsidered: considered,
      filesIncluded: 0,
      estimatedTokens: 0,
    };
  }

  const graph = buildGraph(symbols);
  const personalization = personalizationFor(
    graph,
    opts.chatFiles,
    opts.mentionedIdentifiers,
    opts.cwd,
  );
  const scores = pagerank(graph, { personalization });

  // Score each definition by its file's pagerank, then by definition kind
  // (classes/interfaces/modules outrank methods because they anchor the
  // structure). Aider's tag queries weight similarly.
  const kindWeight: Record<string, number> = {
    class: 1.5,
    interface: 1.5,
    module: 1.4,
    type: 1.2,
    enum: 1.2,
    function: 1.0,
    method: 0.8,
    variable: 0.6,
  };
  const candidates: Candidate[] = [];
  for (let i = 0; i < graph.files.length; i++) {
    const file = graph.defsByFile.get(graph.files[i]!);
    if (!file) continue;
    for (const def of file.defs) {
      const kw = kindWeight[def.kind] ?? 0.5;
      candidates.push({ file, def, score: scores[i]! * kw });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const { text, included, estimatedTokens } = await fitToBudget(
    candidates,
    opts.tokenBudget,
    opts.cwd,
  );
  clearSourceCache();

  return {
    text,
    fileMentions: symbols
      .map((file) => relative(opts.cwd, file.path).replace(/\\/g, "/"))
      .sort((a, b) => a.localeCompare(b)),
    filesConsidered: considered,
    filesIncluded: includedFiles(candidates.slice(0, included)),
    estimatedTokens,
  };
}

function includedFiles(candidates: Candidate[]): number {
  const set = new Set<string>();
  for (const c of candidates) set.add(c.file.path);
  return set.size;
}

export type { RepoMapOptions, RepoMapResult } from "./types.js";
