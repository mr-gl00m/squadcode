import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import {
  type ContextFragment,
  createContextFragment,
} from "../context/fragment.js";
import { logger } from "../logger.js";
import { buildSanitizedChildEnv } from "../tools/shell-env.js";
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

export function hookResultsFragment(
  results: readonly HookFireResult[],
  ctx: HookContext,
): ContextFragment | null {
  const reportable = results.filter((result) => !result.ok);
  if (reportable.length === 0) return null;
  return createContextFragment({
    source: "hooks",
    type: "failures",
    key: `${ctx.event}:${ctx.callId ?? ctx.sessionId}`,
    role: "user",
    merge: "append",
    visibility: "model-and-user",
    trust: "untrusted-environment",
    maxBytes: 4_096,
    maxTokens: 1_024,
    content: reportable
      .map(
        (result) =>
          `${result.event} hook ${JSON.stringify(result.id)} failed: ${result.status} (${result.elapsedMs}ms)`,
      )
      .join("\n"),
  });
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
      env: buildSanitizedChildEnv(process.env, {
        ...(hook.passEnv !== undefined && { passEnv: hook.passEnv }),
        extraEnv: buildContextEnv(ctx),
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore kill errors — child may have already exited.
      }
    }, timeoutMs);
    timer.unref?.();

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

function normalizeIpLiteral(hostname: string): string {
  const host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

function isLoopbackHost(hostname: string): boolean {
  const host = normalizeIpLiteral(hostname);
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

const NON_PUBLIC_IPV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC_IPV4.addSubnet(network, prefix, "ipv4");
}
const NON_PUBLIC_IPV6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  NON_PUBLIC_IPV6.addSubnet(network, prefix, "ipv6");
}

function isPrivateNetworkHost(hostname: string): boolean {
  const host = normalizeIpLiteral(hostname);
  if (host === "localhost") return true;
  const family = isIP(host);
  if (family === 4) return NON_PUBLIC_IPV4.check(host, "ipv4");
  if (family === 6) return NON_PUBLIC_IPV6.check(host, "ipv6");
  return false;
}

type LookupAddress = { address: string; family: number };
type LookupAll = (hostname: string) => Promise<readonly LookupAddress[]>;

async function lookupAll(hostname: string): Promise<readonly LookupAddress[]> {
  return await lookup(hostname, { all: true, verbatim: true });
}

export async function validateHttpHookDestination(
  hook: HttpHook,
  resolveHost: LookupAll = lookupAll,
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(hook.url);
  } catch {
    return "invalid hook URL";
  }
  const hostname = parsed.hostname.toLowerCase();
  if (isLoopbackHost(hostname)) {
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "local hook URL must use http or https";
    }
    return null;
  }
  if (parsed.protocol !== "https:") {
    return "non-local hook URL must use https";
  }
  if (isPrivateNetworkHost(hostname) && !hook.allowLocalNetwork) {
    return "private-network hook URL requires allowLocalNetwork=true";
  }
  const exact = parsed.toString();
  const exactAllowed = (hook.allowedUrls ?? []).some(
    (u) => new URL(u).toString() === exact,
  );
  const allowedHosts = new Set(
    (hook.allowedHosts ?? []).map((h) => h.toLowerCase()),
  );
  if (!exactAllowed && !allowedHosts.has(hostname)) {
    return "non-local hook host must be listed in allowedHosts or allowedUrls";
  }
  if (isIP(normalizeIpLiteral(hostname)) === 0) {
    let addresses: readonly LookupAddress[];
    try {
      addresses = await resolveHost(hostname);
    } catch {
      return "hook host could not be resolved";
    }
    if (addresses.length === 0) return "hook host resolved to no addresses";
    if (
      !hook.allowLocalNetwork &&
      addresses.some((entry) => isPrivateNetworkHost(entry.address))
    ) {
      return "hook host resolves to a private-network address; allowLocalNetwork=true is required";
    }
  }
  return null;
}

export async function runHttpHook(
  hook: HttpHook,
  ctx: HookContext,
): Promise<{ ok: boolean; status: string }> {
  const blocked = await validateHttpHookDestination(hook);
  if (blocked) return { ok: false, status: `blocked=${blocked}` };
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
      // Redirect targets have not passed the destination policy. Refuse them
      // instead of letting fetch follow an allowlisted URL into a private host.
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      return {
        ok: false,
        status: `blocked=hook redirect status ${res.status}`,
      };
    }
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
