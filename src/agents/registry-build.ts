import type { CanonicalMessage } from "../providers/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { createTodoState } from "../tools/todo.js";
import {
  createToolSearchTool,
  type ToolSearchRegistryView,
} from "../tools/tool-search.js";
import type { Tool } from "../tools/types.js";
import { AGENT_TOOL_NAME, type SubagentDef } from "./types.js";

// ToolSearch is rebuilt per-subagent (bound to the child's own deferred-load
// set), so the parent's instance is excluded from the clone alongside the Agent
// tool. Name kept local — tool-search.ts doesn't export it.
const TOOL_SEARCH_NAME = "ToolSearch";

// Matches a tool name against a SubagentDef.tools allowlist. Supports "*"
// (everything), trailing-"*" prefixes ("mcp_*", "mcp_github_*"), and exact
// names. An empty/absent list is treated as ["*"] by the caller.
export function matchesToolFilter(name: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (p === "*") return true;
    if (p.endsWith("*")) {
      if (name.startsWith(p.slice(0, -1))) return true;
    } else if (p === name) {
      return true;
    }
  }
  return false;
}

// Builds a clone-bound ToolRegistry for a subagent: the parent's tools, minus
// the Agent tool (so a child can never spawn its own children — depth=1 by
// construction, not by runtime check), filtered to the def's allowlist, with a
// fresh ToolSearch + todo state of its own. Manifest and repo map are shared
// read-only from the parent — they're immutable context, not mutable state.
export function buildSubagentRegistry(
  base: ToolRegistry,
  def: SubagentDef,
): ToolRegistry {
  const patterns = def.tools && def.tools.length > 0 ? def.tools : ["*"];
  const candidates = base
    .list()
    .filter((t) => t.name !== AGENT_TOOL_NAME && t.name !== TOOL_SEARCH_NAME);
  const selected = candidates.filter((t) =>
    matchesToolFilter(t.name, patterns),
  );

  const loadedDeferred = new Set<string>();
  const selectedByName = new Map<string, Tool>(
    selected.map((t) => [t.name, t]),
  );

  const view: ToolSearchRegistryView = {
    deferredEntries: () =>
      selected
        .filter((t) => t.defer)
        .map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
    isLoaded: (name) => loadedDeferred.has(name),
    markLoaded: (name) => {
      const tool = selectedByName.get(name);
      if (!tool || !tool.defer) return false;
      loadedDeferred.add(name);
      return true;
    },
  };

  const tools: Tool[] = matchesToolFilter(TOOL_SEARCH_NAME, patterns)
    ? [...selected, createToolSearchTool(view)]
    : [...selected];
  const byName = new Map<string, Tool>(tools.map((t) => [t.name, t]));
  const todoState = createTodoState();

  return {
    get: (n) => byName.get(n),
    list: () => tools,
    toCanonicalSpecs: () =>
      tools
        .filter((t) => !t.defer || loadedDeferred.has(t.name))
        .map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
    deferredCatalog: () =>
      tools
        .filter((t) => t.defer)
        .map((t) => ({ name: t.name, description: t.description })),
    isLoaded: (name) => loadedDeferred.has(name),
    markLoaded: (name) => view.markLoaded(name),
    markLoadedFromMessages: (messages: CanonicalMessage[]) => {
      for (const msg of messages) {
        if (!msg.toolCalls) continue;
        for (const call of msg.toolCalls) {
          const tool = byName.get(call.name);
          if (tool?.defer) loadedDeferred.add(call.name);
        }
      }
    },
    loadedDeferredNames: () => [...loadedDeferred],
    getManifest: () => base.getManifest(),
    getRepoMap: () => base.getRepoMap(),
    todoState,
  };
}
