import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson } from "../fs-io.js";
import { logger } from "../logger.js";
import type { FileSymbols } from "./types.js";

const CACHE_VERSION = 1;

interface CacheEntry {
  v: number;
  mtimeMs: number;
  size: number;
  symbols: FileSymbols;
}

export function defaultCacheRoot(cwd: string): string {
  const projectHash = createHash("sha256")
    .update(cwd)
    .digest("hex")
    .slice(0, 16);
  return join(homedir(), ".squad", "cache", "repomap", projectHash);
}

function fileKey(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

export async function readCached(
  cacheRoot: string,
  path: string,
  mtimeMs: number,
  size: number,
): Promise<FileSymbols | null> {
  const target = join(cacheRoot, `${fileKey(path)}.json`);
  let raw: string;
  try {
    raw = await fs.readFile(target, "utf-8");
  } catch {
    return null;
  }
  let entry: CacheEntry;
  try {
    entry = JSON.parse(raw) as CacheEntry;
  } catch {
    return null;
  }
  if (entry.v !== CACHE_VERSION) return null;
  if (entry.mtimeMs !== mtimeMs) return null;
  if (entry.size !== size) return null;
  return entry.symbols;
}

export async function writeCached(
  cacheRoot: string,
  path: string,
  symbols: FileSymbols,
): Promise<void> {
  const target = join(cacheRoot, `${fileKey(path)}.json`);
  const entry: CacheEntry = {
    v: CACHE_VERSION,
    mtimeMs: symbols.mtimeMs,
    size: symbols.size,
    symbols,
  };
  try {
    await atomicWriteJson(target, entry);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), target },
      "repomap: cache write failed",
    );
  }
}
