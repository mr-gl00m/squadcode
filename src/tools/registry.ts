import type { CanonicalMessage, CanonicalToolSpec } from "../providers/types.js";
import { applyPatchTool } from "./apply-patch.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { readTool } from "./read.js";
import { shellTool } from "./shell.js";
import { createTodoState, createTodoTool, type TodoState } from "./todo.js";
import { createToolSearchTool, type ToolSearchRegistryView } from "./tool-search.js";
import type { Tool } from "./types.js";
import { writeTool } from "./write.js";

export interface DeferredCatalogEntry {
  name: string;
  description: string;
}

export interface ToolRegistry {
  get(name: string): Tool | undefined;
  list(): Tool[];
  toCanonicalSpecs(): CanonicalToolSpec[];
  deferredCatalog(): DeferredCatalogEntry[];
  isLoaded(name: string): boolean;
  markLoaded(name: string): boolean;
  markLoadedFromMessages(messages: CanonicalMessage[]): void;
  loadedDeferredNames(): string[];
  readonly todoState: TodoState;
}

function oneLineDescription(description: string): string {
  const newlineIdx = description.indexOf("\n");
  const head = newlineIdx >= 0 ? description.slice(0, newlineIdx) : description;
  const trimmed = head.trim();
  if (trimmed.length <= 200) return trimmed;
  return `${trimmed.slice(0, 197)}...`;
}

export function createToolRegistry(): ToolRegistry {
  const todoState = createTodoState();
  const todoTool = createTodoTool(todoState);
  const baseTools: Tool[] = [
    readTool,
    writeTool,
    editTool,
    applyPatchTool,
    shellTool,
    grepTool,
    globTool,
    todoTool,
  ];
  const loadedDeferred = new Set<string>();

  const view: ToolSearchRegistryView = {
    deferredEntries: () =>
      baseTools
        .filter((t) => t.defer)
        .map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
    isLoaded: (name) => loadedDeferred.has(name),
    markLoaded: (name) => {
      const tool = byName.get(name);
      if (!tool || !tool.defer) return false;
      loadedDeferred.add(name);
      return true;
    },
  };
  const toolSearchTool = createToolSearchTool(view);
  const tools: Tool[] = [...baseTools, toolSearchTool];
  const byName = new Map<string, Tool>(tools.map((t) => [t.name, t]));

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
        .map((t) => ({
          name: t.name,
          description: oneLineDescription(t.description),
        })),
    isLoaded: (name) => loadedDeferred.has(name),
    markLoaded: (name) => {
      const tool = byName.get(name);
      if (!tool || !tool.defer) return false;
      loadedDeferred.add(name);
      return true;
    },
    markLoadedFromMessages: (messages) => {
      for (const msg of messages) {
        if (!msg.toolCalls) continue;
        for (const call of msg.toolCalls) {
          const tool = byName.get(call.name);
          if (tool?.defer) loadedDeferred.add(call.name);
        }
      }
    },
    loadedDeferredNames: () => [...loadedDeferred],
    todoState,
  };
}
