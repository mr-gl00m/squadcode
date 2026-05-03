import { z } from "zod";
import { defineTool } from "./types.js";
import type { Tool } from "./types.js";

const TODO_STATUS = z.enum(["pending", "in_progress", "completed"]);
type TodoStatus = z.infer<typeof TODO_STATUS>;

const TODO_INPUT = z.object({
  todos: z
    .array(
      z.object({
        id: z.string().optional(),
        content: z.string().min(1),
        status: TODO_STATUS,
      }),
    )
    .min(1),
});

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

export interface TodoState {
  next: number;
  items: TodoItem[];
}

export function createTodoState(): TodoState {
  return { next: 1, items: [] };
}

export function createTodoTool(state: TodoState): Tool {
  return defineTool({
    name: "TodoWrite",
    description:
      "Replace the agent's working todo list. Each item has content and status (pending/in_progress/completed).",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["content", "status"],
          },
          minItems: 1,
        },
      },
      required: ["todos"],
    },
    inputZod: TODO_INPUT,
    defaultPermission: "auto-allow",
    isReadOnly: false,
    execute: async (input) => {
      state.items = input.todos.map((t) => ({
        id: t.id ?? `todo_${state.next++}`,
        content: t.content,
        status: t.status,
      }));
      const lines = state.items.map(
        (t) => `[${t.status}] ${t.id}: ${t.content}`,
      );
      return { ok: true, content: lines.join("\n") || "(empty list)" };
    },
    summarize: (input) => {
      const counts = { pending: 0, in_progress: 0, completed: 0 };
      for (const t of input.todos) counts[t.status] += 1;
      return `Updated todos (${input.todos.length} items: ${counts.completed} done, ${counts.in_progress} active, ${counts.pending} pending)`;
    },
  });
}
