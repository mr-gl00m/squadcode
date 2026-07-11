// Tree-sitter language registry. Uses web-tree-sitter (WASM) so installs
// don't require node-gyp + MSVC on Windows. WASM grammars are vendored
// under assets/repomap/wasm/ — see scripts/copy-repomap-wasm.mjs to refresh.

import { existsSync, promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language as TSLanguage } from "web-tree-sitter";
import { logger } from "../logger.js";
import type { Language } from "./types.js";

export type ParserLanguage = Language | "bash";

const WASM_FILES: Record<ParserLanguage, string> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  rust: "tree-sitter-rust.wasm",
  go: "tree-sitter-go.wasm",
  bash: "tree-sitter-bash.wasm",
};

let parserInitPromise: Promise<void> | null = null;
const langCache = new Map<ParserLanguage, TSLanguage | null>();
let cachedWasmDir: string | null = null;

function wasmDir(): string {
  if (cachedWasmDir) return cachedWasmDir;
  // Walk up from the compiled module location looking for assets/repomap/wasm/.
  // In dev (tsx) this module is src/repomap/parser.ts; in dist it's
  // dist/src/repomap/parser.js. The assets dir lives at the package root in
  // both layouts, but the walk-up distance differs, so we search rather than
  // hard-code a level count.
  let here = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(here, "assets", "repomap", "wasm");
    if (existsSync(candidate)) {
      cachedWasmDir = candidate;
      return candidate;
    }
    const parent = dirname(here);
    if (parent === here) break;
    here = parent;
  }
  // Fall back to the most likely production layout; loadLanguage will warn
  // when the read fails.
  cachedWasmDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "assets",
    "repomap",
    "wasm",
  );
  return cachedWasmDir;
}

async function ensureParserReady(): Promise<void> {
  if (parserInitPromise) {
    await parserInitPromise;
    return;
  }
  parserInitPromise = Parser.init();
  await parserInitPromise;
}

export async function loadLanguage(
  lang: ParserLanguage,
): Promise<TSLanguage | null> {
  if (langCache.has(lang)) return langCache.get(lang) ?? null;
  await ensureParserReady();
  const wasmPath = join(wasmDir(), WASM_FILES[lang]);
  try {
    const buf = await fs.readFile(wasmPath);
    // Wrap in a fresh Uint8Array — web-tree-sitter's Language.load is picky
    // about Buffer vs Uint8Array; Buffer extends Uint8Array but the loader
    // duck-types and rejects raw Buffers from fs.readFile.
    const tsLang = await TSLanguage.load(new Uint8Array(buf));
    langCache.set(lang, tsLang);
    return tsLang;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), lang, wasmPath },
      "repomap: failed to load language wasm",
    );
    langCache.set(lang, null);
    return null;
  }
}

export async function createParser(
  lang: ParserLanguage,
): Promise<Parser | null> {
  const tsLang = await loadLanguage(lang);
  if (!tsLang) return null;
  const parser = new Parser();
  parser.setLanguage(tsLang);
  return parser;
}
