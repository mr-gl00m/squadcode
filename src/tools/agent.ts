import { z } from "zod";
import type { SpawnResult } from "../agents/spawn.js";
import { AGENT_TOOL_NAME, type SubagentDef } from "../agents/types.js";
import { formatSubagentReport } from "../prompts/subagent.js";
import { defineTool, type Tool } from "./types.js";

// The host the Agent tool calls into. Kept as a narrow interface so the tool
// module doesn't import the spawn runtime directly (which would pull the whole
// agents subsystem into every registry build). program.ts wires a concrete
// host that closes over the session's AgentRuntime.
export interface AgentToolHost {
  defs(): Map<string, SubagentDef>;
  spawn(def: SubagentDef, prompt: string): Promise<SpawnResult>;
}

const AGENT_INPUT = z.object({
  description: z.string().min(1),
  prompt: z.string().min(1),
  subagent_type: z.string().min(1),
});

function describeTypes(defs: Map<string, SubagentDef>): string {
  const lines = [...defs.values()].map((d) => {
    const when = d.whenToUse ? ` — ${d.whenToUse}` : "";
    return `- ${d.name}: ${d.description}${when}`;
  });
  return lines.join("\n");
}

export function createAgentTool(host: AgentToolHost): Tool {
  const defs = host.defs();
  const names = [...defs.values()].map((d) => d.name);
  return defineTool({
    name: AGENT_TOOL_NAME,
    description:
      "Launch a subagent to handle a self-contained task on its own model and tool allowlist, then return one structured report. The subagent runs in isolation: it cannot see this conversation beyond the prompt you give it, its working messages are discarded when it finishes, and it cannot spawn further subagents (depth is capped at 1). Use it to fan a task out to a specific model, or to keep a noisy sub-task out of this context. Available subagent types:\n" +
      describeTypes(defs),
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "A short (3-5 word) label for the task.",
        },
        prompt: {
          type: "string",
          description:
            "The full task for the subagent. It is the only context the subagent gets, so be self-contained and state exactly what to return.",
        },
        subagent_type: {
          type: "string",
          description: "Which subagent to launch.",
          ...(names.length > 0 && { enum: names }),
        },
      },
      required: ["description", "prompt", "subagent_type"],
    },
    inputZod: AGENT_INPUT,
    defaultPermission: "ask",
    isReadOnly: false,
    execute: async (input) => {
      const def = host.defs().get(input.subagent_type.toLowerCase());
      if (!def) {
        const available = names.join(", ") || "(none configured)";
        return {
          ok: false,
          content: `unknown subagent_type "${input.subagent_type}". Available: ${available}`,
          error: "UNKNOWN_SUBAGENT",
        };
      }
      const { record, report } = await host.spawn(def, input.prompt);
      const wt = record.worktree ? `; worktree ${record.worktree}` : "";
      const header = `[subagent ${record.id} (${record.type}) → ${record.status}; model ${record.provider}/${record.model}${wt}]`;
      const ok = record.status === "completed";
      const result = {
        ok,
        content: `${header}\n\n${formatSubagentReport(report)}`,
      };
      if (!ok) {
        return {
          ...result,
          error: `SUBAGENT_${record.status.toUpperCase()}`,
        };
      }
      return result;
    },
    summarize: (input, res) =>
      `Agent ${input.subagent_type}: ${input.description}${res.ok ? "" : " (failed)"}`,
  });
}
