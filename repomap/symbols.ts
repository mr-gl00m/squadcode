import { promises as fs } from "node:fs";
import { Query, type QueryMatch } from "web-tree-sitter";
import { logger } from "../logger.js";
import { createParser, loadLanguage } from "./parser.js";
import { queryForLanguage } from "./queries/index.js";
import type { FileSymbols, Language, SymbolDef, SymbolRef } from "./types.js";

const queryCache = new Map<Language, Query | null>();

async function getQuery(lang: Language): Promise<Query | null> {
  if (queryCache.has(lang)) return queryCache.get(lang) ?? null;
  const tsLang = await loadLanguage(lang);
  if (!tsLang) {
    queryCache.set(lang, null);
    return null;
  }
  try {
    const q = new Query(tsLang, queryForLanguage(lang));
    queryCache.set(lang, q);
    return q;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), lang },
      "repomap: failed to compile query",
    );
    queryCache.set(lang, null);
    return null;
  }
}

function classify(
  captureName: string,
): { side: "def" | "ref"; kind: string } | null {
  // capture names look like `name.definition.function`, `name.reference.call`.
  // We only care about the name.* captures (carrying the identifier); the
  // outer @definition.X / @reference.X captures wrap the whole node.
  const parts = captureName.split(".");
  if (parts[0] !== "name") return null;
  if (parts[1] === "definition")
    return { side: "def", kind: parts[2] ?? "symbol" };
  if (parts[1] === "reference")
    return { side: "ref", kind: parts[2] ?? "symbol" };
  return null;
}

export async function extractSymbols(
  path: string,
  lang: Language,
  mtimeMs: number,
  size: number,
): Promise<FileSymbols | null> {
  const parser = await createParser(lang);
  const query = await getQuery(lang);
  if (!parser || !query) return null;

  let source: string;
  try {
    source = await fs.readFile(path, "utf-8");
  } catch {
    return null;
  }

  const tree = parser.parse(source);
  if (!tree) return null;
  const matches: QueryMatch[] = query.matches(tree.rootNode);
  const defs: SymbolDef[] = [];
  const refs: SymbolRef[] = [];

  for (const m of matches) {
    for (const c of m.captures) {
      const cls = classify(c.name);
      if (!cls) continue;
      const text = c.node.text;
      if (!text) continue;
      if (cls.side === "def") {
        defs.push({
          name: text,
          kind: cls.kind,
          line: c.node.startPosition.row,
          endLine: c.node.endPosition.row,
        });
      } else {
        refs.push({ name: text, line: c.node.startPosition.row });
      }
    }
  }

  tree.delete();
  return { path, lang, mtimeMs, size, defs, refs };
}
