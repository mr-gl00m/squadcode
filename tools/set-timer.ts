import { z } from "zod";
import { defineTool } from "./types.js";

const SET_TIMER_INPUT = z.object({
  label: z.string().min(1),
  ms: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60 * 1000),
});

// LLM-callable so the model can plan its own "ping me if I'm not done" checks —
// it pairs with Shell({ background: true }) and the Agent tool. The timer fires
// at the next turn boundary after it expires (the loop drains expired timers
// pre-turn and injects a synthetic message), so it's a coarse self-nudge, not a
// real-time interrupt.
export const setTimerTool = defineTool({
  name: "SetTimer",
  description:
    "Set a deadline timer that fires a reminder back to you after `ms` milliseconds. Use it to check on a backgrounded shell command or a subagent without busy-waiting — when it expires you get a synthetic notice at the start of your next turn. Returns a timerId you can pass to CancelTimer.",
  inputSchema: {
    type: "object",
    properties: {
      label: {
        type: "string",
        description: "What this timer is watching, echoed back when it fires.",
      },
      ms: { type: "integer", minimum: 1, maximum: 86400000 },
    },
    required: ["label", "ms"],
  },
  inputZod: SET_TIMER_INPUT,
  defaultPermission: "auto-allow",
  isReadOnly: false,
  defer: true,
  execute: async (input, ctx) => {
    if (!ctx.timers) {
      return {
        ok: false,
        content: "timers are not available in this run",
        error: "TIMERS_UNAVAILABLE",
      };
    }
    const id = ctx.timers.set(input.label, input.ms, Date.now());
    return {
      ok: true,
      content: `timer ${id} set: "${input.label}" fires in ${input.ms}ms`,
    };
  },
  summarize: (input) => `SetTimer "${input.label}" (${input.ms}ms)`,
});
