import { type ChildProcess, spawn } from "node:child_process";
import { z } from "zod";
import { checkYoloPathGuard } from "../yolo/index.js";
import { makeDeletedDir, rewriteDeleteCommand } from "./delete-guard.js";
import { HeadTailBuffer } from "./output-buffer.js";
import { resolveAndValidate } from "./path.js";
import { sanitizeChildEnv } from "./shell-env.js";
import type { ToolContext, ToolResult } from "./types.js";
import { defineTool } from "./types.js";

const SHELL_INPUT = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  // When true, return a jobId immediately and let the command run in the
  // background, buffering output into the job registry. Poll with JobStatus,
  // stop with JobKill.
  background: z.boolean().optional(),
});

type ShellInput = z.infer<typeof SHELL_INPUT>;

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 200_000;
export const FORCE_KILL_GRACE_MS = 3_000;
const IS_WINDOWS = process.platform === "win32";

function sendGracefulSignal(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (IS_WINDOWS) {
    spawn("taskkill", ["/T", "/PID", String(child.pid)], {
      stdio: "ignore",
      windowsHide: true,
    }).on("error", () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* swallow */
      }
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* swallow */
    }
  }
}

function sendForceSignal(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (IS_WINDOWS) {
    spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
      stdio: "ignore",
      windowsHide: true,
    }).on("error", () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* swallow */
      }
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* swallow */
    }
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  sendGracefulSignal(child);
  setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    sendForceSignal(child);
  }, FORCE_KILL_GRACE_MS).unref();
}

// The platform spawn — shared by the foreground and background paths so they
// can't drift on shell flags / env / detach behavior. Return type is inferred
// (ChildProcessWithoutNullStreams) so stdout/stderr stay non-null; annotating it
// ChildProcess would widen them to nullable.
function spawnShellChild(
  command: string,
  cwd: string,
  childEnv: NodeJS.ProcessEnv,
) {
  return IS_WINDOWS
    ? spawn(
        process.env["SQUAD_SHELL"] ?? "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          command,
        ],
        { cwd, windowsHide: true, env: childEnv },
      )
    : spawn(command, [], {
        cwd,
        shell: true,
        detached: true,
        windowsHide: true,
        env: childEnv,
      });
}

// Background path: register a job, pipe output into it, return a handle now.
// The job's onCancel killTrees the child, so JobKill and an aborted run both
// tear down the process tree. timeoutMs is honored only when explicitly given —
// a backgrounded command is meant to outlive the turn, so there's no default.
function runInBackground(
  command: string,
  cwd: string,
  childEnv: NodeJS.ProcessEnv,
  guardPreamble: string,
  input: ShellInput,
  ctx: ToolContext,
): ToolResult {
  if (!ctx.jobs) {
    return {
      ok: false,
      content: "background jobs are not available in this run",
      error: "BACKGROUND_UNAVAILABLE",
    };
  }
  const child = spawnShellChild(command, cwd, childEnv);
  const title =
    input.command.length > 60
      ? `${input.command.slice(0, 57)}...`
      : input.command;
  const job = ctx.jobs.create({
    type: "shell",
    title,
    onCancel: () => killTree(child),
  });
  if (child.pid !== undefined) job.setPid(child.pid);

  let timer: NodeJS.Timeout | null = null;
  if (input.timeoutMs !== undefined) {
    timer = setTimeout(() => killTree(child), input.timeoutMs);
    timer.unref();
  }
  const onAbort = (): void => job.cancel();
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  const cleanup = (): void => {
    if (timer) clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);
  };

  child.stdout.on("data", (b: Buffer) => job.appendStdout(b.toString("utf-8")));
  child.stderr.on("data", (b: Buffer) => job.appendStderr(b.toString("utf-8")));
  child.on("error", (err: Error) => {
    cleanup();
    job.settle("error", { error: `failed to spawn: ${err.message}` });
  });
  child.on("close", (code: number | null) => {
    cleanup();
    job.settle(code === 0 ? "completed" : "error", { exitCode: code ?? -1 });
  });

  const startedAt = job.info().startedAt;
  const pidNote = child.pid !== undefined ? `pid ${child.pid}, ` : "";
  return {
    ok: true,
    content:
      `${guardPreamble}started background job ${job.id} (${pidNote}at ${startedAt}).\n` +
      "Poll it with JobStatus, stop it with JobKill (load both via ToolSearch if not yet available).",
  };
}

async function runCommand(
  input: ShellInput,
  ctx: ToolContext,
): Promise<ToolResult> {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = input.cwd
    ? await resolveAndValidate(input.cwd, {
        root: ctx.cwd,
        mustExist: true,
      })
    : ctx.cwd;

  let command = input.command;
  let guardPreamble = "";

  // YOLO path guard (when armed): reject literal paths / cd that escape cwd.
  if (ctx.yolo) {
    const pathViolation = checkYoloPathGuard(input.command, ctx.yolo);
    if (pathViolation) {
      return {
        ok: false,
        content: pathViolation.reason,
        error: "YOLO_PATH_GUARD_VIOLATION",
      };
    }
  }

  // Delete guard — always on unless the user launched --dangerously-allow-deletes.
  // Simple deletes are rewritten to move the target into a recovery folder;
  // deletes too complex to rewrite are blocked. YOLO archives into its session
  // dir; otherwise into .deleted/<timestamp>/.
  if (!ctx.allowDeletes) {
    const archiveDir = ctx.yolo ? ctx.yolo.archiveDir : makeDeletedDir();
    const guard = rewriteDeleteCommand(input.command, {
      archiveDir,
      isWindows: IS_WINDOWS,
      cwd,
    });
    if (guard.kind === "rejected") {
      return {
        ok: false,
        content: guard.reason,
        error: "DELETE_GUARD_BLOCKED",
      };
    }
    if (guard.kind === "rewritten") {
      command = guard.command;
      guardPreamble = `(delete guard) ${guard.notes.join("; ")}\n\n`;
    }
  }

  // Spawn children with a sanitized environment so the model's commands can't
  // read the user's provider API keys (or any secret-shaped var). Strict mode
  // (baseline allowlist only) auto-engages under CI.
  const childEnv = sanitizeChildEnv(process.env);

  if (input.background) {
    return runInBackground(command, cwd, childEnv, guardPreamble, input, ctx);
  }

  return await new Promise<ToolResult>((resolve) => {
    const child = spawnShellChild(command, cwd, childEnv);
    const stdout = new HeadTailBuffer(MAX_OUTPUT_BYTES);
    const stderr = new HeadTailBuffer(MAX_OUTPUT_BYTES);
    let timedOut = false;
    let aborted = false;

    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      (target === "stdout" ? stdout : stderr).append(chunk);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeout);

    const onAbort = (): void => {
      aborted = true;
      killTree(child);
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (b: Buffer) => append("stdout", b));
    child.stderr.on("data", (b: Buffer) => append("stderr", b));

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      resolve({
        ok: false,
        content: `failed to spawn: ${err.message}`,
        error: "SHELL_SPAWN_ERROR",
      });
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      const parts: string[] = [`exit_code: ${code ?? "null"}`];
      if (signal) parts.push(`signal: ${signal}`);
      if (timedOut) {
        const killNote =
          signal === "SIGKILL"
            ? `(timed out after ${timeout}ms; force-killed after ${FORCE_KILL_GRACE_MS}ms grace)`
            : `(timed out after ${timeout}ms; process tree terminated)`;
        parts.push(killNote);
      }
      if (aborted) {
        const killNote =
          signal === "SIGKILL"
            ? `(aborted by user; force-killed after ${FORCE_KILL_GRACE_MS}ms grace)`
            : "(aborted by user; process tree terminated)";
        parts.push(killNote);
      }
      const stdoutOutput = stdout.render();
      const stderrOutput = stderr.render();
      if (!stdout.isEmpty) parts.push(`stdout:\n${stdoutOutput.text}`);
      if (!stderr.isEmpty) parts.push(`stderr:\n${stderrOutput.text}`);
      if (stdoutOutput.truncated || stderrOutput.truncated) {
        parts.push("(output truncated; head and tail retained)");
      }
      const body = `${guardPreamble}${parts.join("\n\n")}`;
      const ok = code === 0 && !timedOut && !aborted;
      const errorCode = aborted
        ? "ABORTED"
        : timedOut
          ? "SHELL_TIMEOUT"
          : undefined;
      const out: ToolResult = { ok, content: body };
      if (errorCode) out.error = errorCode;
      resolve(out);
    });
  });
}

export const shellTool = defineTool({
  name: "Shell",
  description:
    "Run a shell command via the platform default shell. Captures stdout/stderr; default timeout 120s, max 600s. Process tree gets SIGTERM first; SIGKILL after a 3s grace if still running. Set background:true to run a long task without blocking — it returns a jobId immediately; poll with JobStatus, stop with JobKill.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      cwd: { type: "string" },
      timeoutMs: { type: "integer", minimum: 1, maximum: 600000 },
      background: { type: "boolean" },
    },
    required: ["command"],
  },
  inputZod: SHELL_INPUT,
  defaultPermission: "ask",
  isReadOnly: false,
  execute: runCommand,
  summarize: (input, result) => {
    const head =
      input.command.length > 60
        ? `${input.command.slice(0, 57)}...`
        : input.command;
    if (!result.ok) {
      const tag = result.error ? ` (${result.error})` : " (failed)";
      return `$ ${head}${tag}`;
    }
    const m = result.content.match(/^exit_code: (\S+)/);
    return m ? `$ ${head} (exit ${m[1]})` : `$ ${head}`;
  },
});
