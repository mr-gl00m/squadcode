import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "./env.js";
import { logger } from "./logger.js";

export type SkillSource = "user" | "project";

export interface SkillEntry {
  name: string;
  description: string;
  body: string;
  source: SkillSource;
  path: string;
}

export interface Frontmatter {
  name: string;
  description: string;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

export function parseFrontmatter(content: string): Frontmatter | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;
  const yaml = match[1];
  const body = match[2];
  if (yaml === undefined || body === undefined) return null;

  const fields: Record<string, string> = {};
  let currentKey: string | null = null;
  let buffer = "";
  for (const line of yaml.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) {
      if (currentKey) fields[currentKey] = buffer.trim();
      currentKey = kv[1] ?? null;
      buffer = kv[2] ?? "";
    } else if (currentKey && /^\s+\S/.test(line)) {
      buffer += " " + line.trim();
    }
  }
  if (currentKey) fields[currentKey] = buffer.trim();

  const name = fields["name"];
  if (!name) return null;
  return {
    name,
    description: fields["description"] ?? "",
    body: body.trim(),
  };
}

async function loadFromDir(
  dir: string,
  source: SkillSource,
): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = [];
  const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const item of items) {
    if (!item.isDirectory()) continue;
    const skillPath = join(dir, item.name, "SKILL.md");
    let content: string;
    try {
      content = await readFile(skillPath, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(content);
    if (!parsed) {
      logger.debug({ path: skillPath }, "skill file missing valid frontmatter");
      continue;
    }
    entries.push({
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
      source,
      path: skillPath,
    });
  }
  return entries;
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

function getUserSkillDirs(): string[] {
  const env = loadEnv();
  const raw = env.SQUAD_USER_SKILL_DIRS?.trim();
  if (!raw) {
    return [join(homedir(), ".squad", "skills")];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(expandHome);
}

export async function loadSkills(
  cwd: string,
): Promise<Map<string, SkillEntry>> {
  const userDirs = getUserSkillDirs();
  const projectDir = join(cwd, ".squad", "skills");
  const userResults = await Promise.all(
    userDirs.map((d) => loadFromDir(d, "user")),
  );
  const projectSkills = await loadFromDir(projectDir, "project");
  // Precedence (later wins): user dirs in order < project. Project skills
  // override user skills on name conflict; later user dirs override earlier.
  const map = new Map<string, SkillEntry>();
  for (const skills of userResults) {
    for (const s of skills) map.set(s.name.toLowerCase(), s);
  }
  for (const s of projectSkills) map.set(s.name.toLowerCase(), s);
  return map;
}

export function formatSkillForLLM(skill: SkillEntry, args: string): string {
  const trimmedArgs = args.trim();
  const tail =
    trimmedArgs.length > 0
      ? trimmedArgs
      : "(No arguments provided — apply to the current working directory.)";
  return `[Skill activated: ${skill.name}]\n\n${skill.body}\n\n---\n\n${tail}`;
}
