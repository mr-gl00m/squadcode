import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { logger } from "../logger.js";
import type { SubagentDef } from "./types.js";

// Reads .squad/agents/<name>.md (project) and ~/.squad/agents/<name>.md (user)
// into SubagentDefs. Frontmatter is the same --- fenced shape skills use, but
// with the agent-specific fields (tools / model / provider / whenToUse); the
// markdown body below the fence becomes the system prompt verbatim.
//
// Precedence on name collision (later wins): built-ins < user < project, so a
// project can shadow a built-in agent of the same name with its own prompt and
// model — the per-agent "for THIS task use THIS model" override surface.

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

function parseList(value: string): string[] {
  // Accept either inline comma lists ("Read, Grep") or a YAML flow array
  // ("[Read, Grep]"). Block-sequence (one item per "- " line) is not supported
  // — keep agent files terse and single-line per field.
  const trimmed = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  return trimmed
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0);
}

export function parseAgentDef(
  content: string,
  fallbackName: string,
): SubagentDef | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    logger.debug({ fallbackName }, "agent file missing frontmatter");
    return null;
  }
  const yaml = match[1] ?? "";
  const body = (match[2] ?? "").trim();

  const fields: Record<string, string> = {};
  for (const line of yaml.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv?.[1]) fields[kv[1].toLowerCase()] = (kv[2] ?? "").trim();
  }

  const name = fields["name"] ?? fallbackName;
  if (!name || !body) return null;

  const def: SubagentDef = {
    name,
    description: fields["description"] ?? "",
    systemPrompt: body,
  };
  const whenToUse = fields["whentouse"] ?? fields["when-to-use"];
  if (whenToUse) def.whenToUse = whenToUse;
  const tools = fields["tools"];
  if (tools) def.tools = parseList(tools);
  if (fields["model"]) def.model = fields["model"];
  if (fields["provider"]) def.provider = fields["provider"];
  if (fields["isolation"] === "worktree") def.isolation = "worktree";
  return def;
}

async function loadFromDir(dir: string): Promise<SubagentDef[]> {
  const defs: SubagentDef[] = [];
  const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const item of items) {
    if (!item.isFile() || !item.name.endsWith(".md")) continue;
    const path = join(dir, item.name);
    let content: string;
    try {
      content = await readFile(path, "utf-8");
    } catch {
      continue;
    }
    const def = parseAgentDef(content, basename(item.name, ".md"));
    if (def) defs.push(def);
    else logger.debug({ path }, "skipping invalid agent file");
  }
  return defs;
}

export async function loadAgentDefs(
  cwd: string,
  builtIns: SubagentDef[] = [],
): Promise<Map<string, SubagentDef>> {
  const userDir = join(homedir(), ".squad", "agents");
  const projectDir = join(cwd, ".squad", "agents");
  const [userDefs, projectDefs] = await Promise.all([
    loadFromDir(userDir),
    loadFromDir(projectDir),
  ]);
  const map = new Map<string, SubagentDef>();
  for (const def of builtIns) map.set(def.name.toLowerCase(), def);
  for (const def of userDefs) map.set(def.name.toLowerCase(), def);
  for (const def of projectDefs) map.set(def.name.toLowerCase(), def);
  return map;
}
