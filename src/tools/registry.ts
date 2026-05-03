import type { CanonicalToolSpec } from "../providers/types.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { readTool } from "./read.js";
import { shellTool } from "./shell.js";
import { createTodoState, createTodoTool, type TodoState } from "./todo.js";
import type { Tool } from "./types.js";
import { writeTool } from "./write.js";

export interface ToolRegistry {
  get(name: string): Tool | undefined;
  list(): Tool[];
  toCanonicalSpecs(): CanonicalToolSpec[];
  readonly todoState: TodoState;
}

export function createToolRegistry(): ToolRegistry {
  const todoState = createTodoState();
  const todoTool = createTodoTool(todoState);
  const tools: Tool[] = [
    readTool,
    writeTool,
    editTool,
    shellTool,
    grepTool,
    globTool,
    todoTool,
  ];
  const byName = new Map<string, Tool>(tools.map((t) => [t.name, t]));
  return {
    get: (n) => byName.get(n),
    list: () => tools,
    toCanonicalSpecs: () =>
      tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    todoState,
  };
}
