import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson, fileExists, readJsonFile } from "../fs-io.js";
import { redactSecrets } from "../redact.js";

const MAX_HISTORY_ENTRIES = 500;

export function defaultInputHistoryPath(): string {
  return join(homedir(), ".squad", "input-history.json");
}

export async function loadInputHistory(
  path = defaultInputHistoryPath(),
): Promise<string[]> {
  if (!(await fileExists(path))) return [];
  try {
    const value = await readJsonFile<unknown>(path);
    if (!Array.isArray(value)) return [];
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .filter((entry) => entry.trim().length > 0)
      .slice(-MAX_HISTORY_ENTRIES);
  } catch {
    return [];
  }
}

export async function appendInputHistory(
  entry: string,
  path = defaultInputHistoryPath(),
): Promise<void> {
  const cleaned = redactSecrets(entry).trim();
  if (!cleaned) return;
  const current = await loadInputHistory(path);
  if (current.at(-1) !== cleaned) current.push(cleaned);
  await atomicWriteJson(path, current.slice(-MAX_HISTORY_ENTRIES));
}

export function findHistoryMatch(
  history: readonly string[],
  query: string,
  beforeExclusive = history.length,
): number | null {
  const needle = query.toLocaleLowerCase();
  for (
    let index = Math.min(beforeExclusive, history.length) - 1;
    index >= 0;
    index--
  ) {
    if ((history[index] ?? "").toLocaleLowerCase().includes(needle)) {
      return index;
    }
  }
  return null;
}
