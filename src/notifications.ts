import { spawn } from "node:child_process";
import { logger } from "./logger.js";
import { buildSanitizedChildEnv } from "./tools/shell-env.js";

export type TerminalNotificationMode = "off" | "unfocused" | "always";
export type TerminalNotificationMethod = "osc9" | "bell";

export interface NotificationConfig {
  program?: string;
  terminalMode: TerminalNotificationMode;
  terminalMethod: TerminalNotificationMethod;
  permissionSound: boolean;
}

export interface TurnCompletionPayload {
  event: "turn_complete";
  sessionId: string;
  cwd: string;
  provider: string;
  model: string;
  ok: boolean;
  durationMs: number;
  turn: number;
}

export interface NotificationDependencies {
  focused: boolean;
  writeTerminal?: (value: string) => void;
  runProgram?: (
    program: string,
    payload: TurnCompletionPayload,
  ) => Promise<void>;
}

export async function notifyTurnComplete(
  config: NotificationConfig,
  payload: TurnCompletionPayload,
  deps: NotificationDependencies,
): Promise<void> {
  if (config.program) {
    try {
      await (deps.runProgram ?? runNotificationProgram)(
        config.program,
        payload,
      );
    } catch (err: unknown) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "turn notification program failed",
      );
    }
  }

  const shouldWrite =
    config.terminalMode === "always" ||
    (config.terminalMode === "unfocused" && !deps.focused);
  if (!shouldWrite || !deps.writeTerminal) return;
  deps.writeTerminal(
    config.terminalMethod === "osc9"
      ? "\x1b]9;Squad turn complete\x07"
      : "\x07",
  );
}

export async function runNotificationProgram(
  program: string,
  payload: TurnCompletionPayload,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, [], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: buildSanitizedChildEnv(process.env),
    });
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("notification program timed out after 5000ms"));
    }, 5_000);
    child.once("error", finish);
    child.once("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`notification program exited ${code ?? "null"}`));
    });
    child.stdin.on("error", () => {
      // The child-level error/close handlers own the outcome (for example,
      // ENOENT can also surface as EPIPE on stdin).
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}
