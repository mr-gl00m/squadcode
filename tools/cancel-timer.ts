import { z } from "zod";
import { defineTool } from "./types.js";

const CANCEL_TIMER_INPUT = z.object({ timerId: z.string().min(1) });

export const cancelTimerTool = defineTool({
  name: "CancelTimer",
  description:
    "Cancel a timer set with SetTimer (e.g. the work you were watching finished before the timer fired). No-op if the timer already fired or never existed.",
  inputSchema: {
    type: "object",
    properties: { timerId: { type: "string" } },
    required: ["timerId"],
  },
  inputZod: CANCEL_TIMER_INPUT,
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
    const cancelled = ctx.timers.cancel(input.timerId);
    return {
      ok: true,
      content: cancelled
        ? `timer ${input.timerId} cancelled`
        : `timer ${input.timerId} not found (already fired or never set)`,
    };
  },
  summarize: (input) => `CancelTimer ${input.timerId}`,
});
