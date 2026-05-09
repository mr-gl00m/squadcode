import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "./logger.js";
import { parseFrontmatter } from "./skills.js";

export type OutputStyleSource = "user" | "project";

export interface OutputStyle {
  name: string;
  description: string;
  body: string;
  source: OutputStyleSource;
  path: string;
}

async function loadFromDir(
  dir: string,
  source: OutputStyleSource,
): Promise<OutputStyle[]> {
  const out: OutputStyle[] = [];
  const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const item of items) {
    if (!item.isFile()) continue;
    if (!item.name.toLowerCase().endsWith(".md")) continue;
    const filePath = join(dir, item.name);
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(content);
    if (!parsed) {
      logger.debug(
        { path: filePath },
        "output style missing valid frontmatter",
      );
      continue;
    }
    out.push({
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
      source,
      path: filePath,
    });
  }
  return out;
}

export async function loadOutputStyles(
  cwd: string,
): Promise<Map<string, OutputStyle>> {
  const userDir = join(homedir(), ".squad", "output-styles");
  const projectDir = join(cwd, ".squad", "output-styles");
  const [user, project] = await Promise.all([
    loadFromDir(userDir, "user"),
    loadFromDir(projectDir, "project"),
  ]);
  const map = new Map<string, OutputStyle>();
  for (const s of user) map.set(s.name.toLowerCase(), s);
  for (const s of project) map.set(s.name.toLowerCase(), s);
  return map;
}

export function composeSystemPrompt(
  style: OutputStyle | null,
  base: string | undefined,
): string | undefined {
  const baseTrimmed = base?.trim();
  const styleBody = style?.body.trim();
  if (!styleBody) return base;
  if (!baseTrimmed) return styleBody;
  return `${styleBody}\n\n${baseTrimmed}`;
}
