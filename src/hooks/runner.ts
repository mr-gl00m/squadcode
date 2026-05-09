import { spawn } from "node:child_process";
import { logger } from "../logger.js";
import type { CommandHook, HookConfig, HookEvent, HttpHook } from "./config.js";
import { matchesHook } from "./match.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface HookContext {
  event: HookEvent;
  sessionId: string;
  cwd: string;
  toolName?: string;
  args?: unknown;
  callId?: string;
  ok?: boolean;
  error?: string;
  prompt?: string;
}

export interface HookFireResult {
  id: string;
  event: HookEvent;
  ok: boolean;
  status: string;
  elapsedMs: number;
}

export type HookAuditFn = (result: HookFireResult, ctx: HookContext) => void;

export interface HookRunner {
  fire(ctx: HookContext): Promise<HookFireResult[]>;
}

export interface HookRunnerOptions {
  hooks: HookConfig[];
  audit?: HookAuditFn;
  // Override the default child_process / fetch executors. Used by tests so
  // they don't have to spawn real shells or hit real URLs.
  runCommand?: typeof runCommandHook;
  runHttp?: typeof runHttpHook;
}

export function createHookRunner(opts: HookRunnerOptions): HookRunner {
  return {
    fire: async (ctx) => {
      if (opts.hooks.length === 0) return [];
      const matched = opts.hooks.filter((h) => matchesHook(h, ctx));
      if (matched.length === 0) return [];
      const runCmd = opts.runCommand ?? runCommandHook;
      const runHttp = opts.runHttp ?? runHttpHook;
      const results = await Promise.all(
        matched.map((hook) => fireOne(hook, ctx, runCmd, runHttp)),
      );
      if (opts.audit) {
        for (const r of results) {
          try {
            opts.audit(r, ctx);
          } catch (err: unknown) {
            logger.warn(
              { err: err instanceof Error ? err.message : String(err) },
              "hook audit callback threw",
            );
          }
        }
      }
      return results;
    },
  };
}

async function fireOne(
  hook: HookConfig,
  ctx: HookContext,
  runCmd: typeof runCommandHook,
  runHttp: typeof runHttpHook,
): Promise<HookFireResult> {
  const start = Date.now();
  let outcome: { ok: boolean; status: string };
  try {
    outcome =
      hook.type === "command"
        ? await runCmd(hook, ctx)
        : await runHttp(hook, ctx);
  } catch (err: unknown) {
    outcome = {
      ok: false,
      status: `error=${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const elapsedMs = Date.now() - start;
  return {
    id: hook.id,
    event: hook.event,
    ok: outcome.ok,
    status: outcome.status,
    elapsedMs,
  };
}

function buildContextEnv(ctx: HookContext): Record<string, string> {
  const env: Record<string, string> = {
    SQUAD_HOOK_EVENT: ctx.event,
    SQUAD_HOOK_SESSION_ID: ctx.sessionId,
    SQUAD_HOOK_CWD: ctx.cwd,
  };
  if (ctx.toolName !== undefined) env.SQUAD_HOOK_TOOL = ctx.toolName;
  if (ctx.callId !== undefined) env.SQUAD_HOOK_CALL_ID = ctx.callId;
  if (ctx.ok !== undefined) env.SQUAD_HOOK_OK = ctx.ok ? "1" : "0";
  if (ctx.error !== undefined) env.SQUAD_HOOK_ERROR = ctx.error;
  return env;
}

export async function runCommandHook(
  hook: CommandHook,
  ctx: HookContext,
): Promise<{ ok: boolean; status: string }> {
  const timeoutMs = hook.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return await new Promise((resolve) => {
    let settled = false;
    const child = spawn(hook.command, [], {
      shell: true,
      cwd: ctx.cwd,
      env: { ...process.env, ...buildContextEnv(ctx) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore kill errors — child may have already exited.
      }
    }, timeoutMs);
    timer.unref?.();
    let timedOut = false;
    const onTimeout = (): void => {
      timedOut = true;
    };
    timer.unref?.();
    void onTimeout;

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, status: `error=${err.message}` });
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && code === null) {
        resolve({
          ok: false,
          status: timedOut ? `timeout=${timeoutMs}ms` : `signal=${signal}`,
        });
        return;
      }
      resolve({ ok: code === 0, status: `exit=${code ?? -1}` });
    });
    try {
      child.stdin?.end(JSON.stringify(ctx));
    } catch {
      // Stdin write race with early exit — ignored, exit handler resolves.
    }
  });
}

export async function runHttpHook(
  hook: HttpHook,
  ctx: HookContext,
): Promise<{ ok: boolean; status: string }> {
  const timeoutMs = hook.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetch(hook.url, {
      method: hook.method ?? "POST",
      headers: {
        "Content-Type": "application/json",
        ...(hook.headers ?? {}),
      },
      body: JSON.stringify(ctx),
      signal: controller.signal,
    });
    return { ok: res.ok, status: `status=${res.status}` };
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "AbortError") {
      return { ok: false, status: `timeout=${timeoutMs}ms` };
    }
    return {
      ok: false,
      status: `error=${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
