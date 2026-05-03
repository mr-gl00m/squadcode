import { type ChildProcess, spawn } from "node:child_process";
import { z } from "zod";
import { resolveAndValidate } from "./path.js";
import { defineTool } from "./types.js";
import type { ToolContext, ToolResult } from "./types.js";

const SHELL_INPUT = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
});

type ShellInput = z.infer<typeof SHELL_INPUT>;

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 200_000;
const IS_WINDOWS = process.platform === "win32";

function killTree(child: ChildProcess): void {
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

  return await new Promise<ToolResult>((resolve) => {
    const child = IS_WINDOWS
      ? spawn(
          process.env["SQUAD_SHELL"] ?? "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            input.command,
          ],
          { cwd, windowsHide: true },
        )
      : spawn(input.command, [], {
          cwd,
          shell: true,
          detached: true,
          windowsHide: true,
        });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let aborted = false;

    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const text = chunk.toString("utf-8");
      if (target === "stdout") {
        if (stdout.length + text.length > MAX_OUTPUT_BYTES) {
          stdout += text.slice(0, MAX_OUTPUT_BYTES - stdout.length);
          truncated = true;
        } else {
          stdout += text;
        }
      } else {
        if (stderr.length + text.length > MAX_OUTPUT_BYTES) {
          stderr += text.slice(0, MAX_OUTPUT_BYTES - stderr.length);
          truncated = true;
        } else {
          stderr += text;
        }
      }
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
      if (timedOut) parts.push(`(timed out after ${timeout}ms; process tree killed)`);
      if (aborted) parts.push("(aborted by user; process tree killed)");
      if (stdout) parts.push(`stdout:\n${stdout}`);
      if (stderr) parts.push(`stderr:\n${stderr}`);
      if (truncated) parts.push("(output truncated)");
      const body = parts.join("\n\n");
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
    "Run a shell command via the platform default shell. Captures stdout/stderr; default timeout 120s, max 600s. Process tree is killed on timeout or abort.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      cwd: { type: "string" },
      timeoutMs: { type: "integer", minimum: 1, maximum: 600000 },
    },
    required: ["command"],
  },
  inputZod: SHELL_INPUT,
  defaultPermission: "ask",
  isReadOnly: false,
  execute: runCommand,
  summarize: (input, result) => {
    const head = input.command.length > 60 ? `${input.command.slice(0, 57)}...` : input.command;
    if (!result.ok) {
      const tag = result.error ? ` (${result.error})` : " (failed)";
      return `$ ${head}${tag}`;
    }
    const m = result.content.match(/^exit_code: (\S+)/);
    return m ? `$ ${head} (exit ${m[1]})` : `$ ${head}`;
  },
});
