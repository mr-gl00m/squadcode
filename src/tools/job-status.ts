import { z } from "zod";
import { defineTool } from "./types.js";

const JOB_STATUS_INPUT = z.object({ jobId: z.string().min(1) });

function durationMs(startedAt: string, completedAt?: string): number {
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, end - start);
}

// Non-mutating poll of a backgrounded job (a Shell({ background: true }) command
// or a subagent run). Auto-allowed.
export const jobStatusTool = defineTool({
  name: "JobStatus",
  description:
    "Check on a backgrounded job by its jobId (from Shell with background:true, or a subagent). Returns whether it's still running, the exit code if finished, captured stdout/stderr, and how long it has run.",
  inputSchema: {
    type: "object",
    properties: { jobId: { type: "string" } },
    required: ["jobId"],
  },
  inputZod: JOB_STATUS_INPUT,
  defaultPermission: "auto-allow",
  isReadOnly: true,
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
    const running = info.status === "running";
    const parts: string[] = [
      `job: ${info.id} (${info.type})`,
      `status: ${info.status}`,
      `running: ${running}`,
      `durationMs: ${durationMs(info.startedAt, info.completedAt)}`,
    ];
    if (info.pid !== undefined) parts.push(`pid: ${info.pid}`);
    if (info.exitCode !== undefined) parts.push(`exit_code: ${info.exitCode}`);
    if (info.stdout) parts.push(`stdout:\n${info.stdout}`);
    if (info.stderr) parts.push(`stderr:\n${info.stderr}`);
    if (info.error) parts.push(`error: ${info.error}`);
    return { ok: true, content: parts.join("\n") };
  },
  summarize: (input) => `JobStatus ${input.jobId}`,
});
