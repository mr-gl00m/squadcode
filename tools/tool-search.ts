import { z } from "zod";
import { defineTool } from "./types.js";

export interface DeferredToolEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Minimal view of the registry that ToolSearch needs. Defined as an interface
// rather than importing ToolRegistry so the registry module can construct
// ToolSearch without a circular type import.
export interface ToolSearchRegistryView {
  deferredEntries(): DeferredToolEntry[];
  isLoaded(name: string): boolean;
  markLoaded(name: string): boolean;
}

const TOOL_SEARCH_INPUT = z.object({
  query: z.string().min(1),
  max_results: z.number().int().positive().max(20).optional(),
});

const SELECT_PREFIX = "select:";
const DEFAULT_MAX_RESULTS = 5;

interface ScoredEntry {
  entry: DeferredToolEntry;
  score: number;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

export function scoreMatch(
  entry: DeferredToolEntry,
  queryTokens: string[],
): number {
  if (queryTokens.length === 0) return 0;
  const nameTokens = new Set(tokenize(entry.name));
  const descTokens = new Set(tokenize(entry.description));
  let score = 0;
  for (const qt of queryTokens) {
    if (nameTokens.has(qt)) score += 3;
    else if ([...nameTokens].some((nt) => nt.includes(qt))) score += 2;
    if (descTokens.has(qt)) score += 1;
  }
  return score;
}

export function parseSelectQuery(query: string): string[] | null {
  const trimmed = query.trim();
  if (!trimmed.toLowerCase().startsWith(SELECT_PREFIX)) return null;
  const rest = trimmed.slice(SELECT_PREFIX.length);
  return rest
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function formatLoadedTools(entries: DeferredToolEntry[]): string {
  if (entries.length === 0) {
    return "No matching deferred tools.";
  }
  const blocks = entries.map((e) => {
    const schemaJson = JSON.stringify(e.inputSchema, null, 2);
    return [
      `<tool name="${e.name}">`,
      `description: ${e.description}`,
      `inputSchema:\n${schemaJson}`,
      `</tool>`,
    ].join("\n");
  });
  return [
    `Loaded ${entries.length} deferred tool${entries.length === 1 ? "" : "s"}. ` +
      `Their schemas are now callable on subsequent turns.`,
    "",
    blocks.join("\n\n"),
  ].join("\n");
}

export function createToolSearchTool(view: ToolSearchRegistryView) {
  return defineTool({
    name: "ToolSearch",
    description:
      'Look up the full JSON Schema for deferred tools so they become callable on the next turn. Two query forms: "select:Name1,Name2" loads exact tool names; a keyword string scores deferred tools by name and description match. Use "select:" when you already know the tool names; use keywords to discover by topic.',
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        max_results: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
    },
    inputZod: TOOL_SEARCH_INPUT,
    defaultPermission: "auto-allow",
    isReadOnly: true,
    execute: async (input) => {
      const all = view.deferredEntries();
      if (all.length === 0) {
        return {
          ok: true,
          content:
            "No deferred tools are registered in this build. All available tools are already eager.",
        };
      }

      const selectNames = parseSelectQuery(input.query);
      if (selectNames !== null) {
        const known = new Map(all.map((e) => [e.name, e]));
        const loaded: DeferredToolEntry[] = [];
        const unknown: string[] = [];
        for (const name of selectNames) {
          const entry = known.get(name);
          if (!entry) {
            unknown.push(name);
            continue;
          }
          view.markLoaded(name);
          loaded.push(entry);
        }
        const lines = [formatLoadedTools(loaded)];
        if (unknown.length > 0) {
          lines.push(
            `Unknown tool names: ${unknown.join(", ")}. ` +
              `Known deferred tools: ${all.map((e) => e.name).join(", ")}.`,
          );
        }
        return { ok: true, content: lines.join("\n\n") };
      }

      const max = input.max_results ?? DEFAULT_MAX_RESULTS;
      const tokens = tokenize(input.query);
      const scored: ScoredEntry[] = all
        .map((entry) => ({ entry, score: scoreMatch(entry, tokens) }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, max);

      if (scored.length === 0) {
        return {
          ok: true,
          content:
            `No deferred tools matched "${input.query}". ` +
            `Available deferred tools: ${all.map((e) => `${e.name} — ${e.description}`).join("; ")}.`,
        };
      }
      for (const s of scored) view.markLoaded(s.entry.name);
      return {
        ok: true,
        content: formatLoadedTools(scored.map((s) => s.entry)),
      };
    },
    summarize: (input, result) => {
      if (!result.ok) return `ToolSearch ${input.query} (failed)`;
      return `ToolSearch ${input.query}`;
    },
  });
}
