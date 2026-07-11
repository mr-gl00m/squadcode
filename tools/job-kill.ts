import { z } from "zod";
import { defineTool } from "./types.js";

const JOB_KILL_INPUT = z.object({ jobId: z.string().min(1) });

// Mutating — prompts. Cancels a backgrounded job: for a shell job it killTrees
// the child via the cancel handle the Shell tool registered; for a subagent job
// it aborts the run. Doubles as the model-facing cascade-kill for subagents.
export const jobKillTool = defineTool({
  name: "JobKill",
  description:
    "Stop a backgrounded job by its jobId — kills the process tree of a backgrounded shell command, or aborts a subagent run. No-op if the job already finished.",
  inputSchema: {
    type: "object",
    properties: { jobId: { type: "string" } },
    required: ["jobId"],
  },
  inputZod: JOB_KILL_INPUT,
  defaultPermission: "ask",
  isReadOnly: false,
  defer: true,
  execute: async (input, ctx) => {
    if (!ctx.jobs) {
      return {
        ok: false,
        content: "background jobs are not available in this run",
        error: "JOBS_UNAVAILABLE",
      };
    }
    const info = ctx.jobs.get(input.jobId);
    if (!info) {
      return {
        ok: false,
        content: `no job ${input.jobId}`,
        error: "UNKNOWN_JOB",
      };
    }
    if (info.status !== "running") {
      return {
        ok: true,
        content: `job ${input.jobId} already ${info.status}`,
      };
    }
    ctx.jobs.cancel(input.jobId);
    return { ok: true, content: `job ${input.jobId} cancelled` };
  },
  summarize: (input) => `JobKill ${input.jobId}`,
});
