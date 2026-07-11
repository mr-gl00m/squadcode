import { promises as fs } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  createContextFragment,
  renderContextFragment,
} from "../context/fragment.js";

const MENTION_PATTERN = /(^|\s)@([\w./\\-]+)/g;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;

export function fileMentionSuggestion(
  value: string,
  cursor: number,
  candidates: readonly string[],
): string {
  if (cursor !== [...value].length) return "";
  const match = value.match(/(?:^|\s)@([\w./\\-]*)$/);
  if (!match) return "";
  const prefix = (match[1] ?? "").replace(/\\/g, "/").toLowerCase();
  const candidate = candidates.find(
    (path) =>
      path.toLowerCase().startsWith(prefix) && path.length > prefix.length,
  );
  return candidate ? candidate.slice(prefix.length) : "";
}

export async function expandFileMentions(
  value: string,
  cwd: string,
  candidates: readonly string[],
): Promise<string> {
  const allowed = new Map(
    candidates.map((path) => [path.replace(/\\/g, "/").toLowerCase(), path]),
  );
  const rootReal = await fs.realpath(cwd);
  let totalBytes = 0;
  const replacements = new Map<string, string>();
  for (const match of value.matchAll(MENTION_PATTERN)) {
    const requested = (match[2] ?? "").replace(/\\/g, "/");
    const relativePath = allowed.get(requested.toLowerCase());
    if (!relativePath || replacements.has(requested)) continue;
    const absolute = resolve(cwd, relativePath);
    const lexicalRelative = relative(cwd, absolute);
    if (lexicalRelative.startsWith("..") || isAbsolute(lexicalRelative))
      continue;
    const real = await fs.realpath(absolute).catch(() => null);
    if (!real) continue;
    const realRelative = relative(rootReal, real);
    if (realRelative.startsWith("..") || isAbsolute(realRelative)) continue;
    const stat = await fs.stat(real).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) continue;
    if (totalBytes + stat.size > MAX_TOTAL_BYTES) continue;
    const content = await fs.readFile(real, "utf8").catch(() => null);
    if (content === null) continue;
    totalBytes += Buffer.byteLength(content, "utf8");
    replacements.set(
      requested,
      renderContextFragment(
        createContextFragment({
          source: "composer",
          type: "file_mention",
          key: relativePath,
          role: "user",
          merge: "append",
          visibility: "model",
          trust: "untrusted-environment",
          content,
          maxBytes: MAX_FILE_BYTES,
          maxTokens: 64 * 1024,
          attributes: { path: relativePath },
        }),
      ).content,
    );
  }
  return value.replace(
    MENTION_PATTERN,
    (_whole, leading: string, requested: string) =>
      `${leading}${replacements.get(requested) ?? `@${requested}`}`,
  );
}
