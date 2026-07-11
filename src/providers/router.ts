import { spawn } from "node:child_process";
import { logger } from "../logger.js";
import { buildSanitizedChildEnv } from "../tools/shell-env.js";
import type {
  CanonicalEvent,
  CanonicalRequest,
  CanonicalResponse,
  LLMProvider,
  ProviderCallOptions,
} from "./types.js";

// The `router` provider kind (Phase 18 / v1.4, Direction B): a provider that
// doesn't generate. It hands the prompt + tool catalog to a configured external
// router (default use case: CrabMeat) which answers WHICH model to use, then
// Squad drives that model through the normal canonical loop. Squad stays the
// vetting harness; the router stays the routing brain.
//
// The decision is cached per provider instance: route once for the task, then
// stick to the chosen model for the rest of the loop rather than re-routing
// every turn (which could bounce a single task across models mid-conversation).
export interface RouterConfig {
  providerId: string;
  // argv of the router command; the routing payload is written to its stdin as
  // JSON, and it prints a RouterDecision as JSON to stdout.
  command: string[];
  timeoutMs?: number;
  passEnv?: string[];
}

export interface RouterDecision {
  provider_id: string;
  model_id: string;
  rationale?: string;
}

// Turns the router's chosen (provider_id, model_id) into a real provider, or an
// error string. Closes over the catalog + dispatch env at the CLI layer.
export type ModelResolver = (
  providerId: string,
  modelId: string,
) => LLMProvider | string;

const DEFAULT_TIMEOUT_MS = 30_000;

function routingPayload(req: CanonicalRequest): string {
  const prompt = req.messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n\n");
  return JSON.stringify({
    prompt,
    ...(req.system !== undefined && { system: req.system }),
    tools: (req.tools ?? []).map((t) => t.name),
  });
}

function runRouter(
  config: RouterConfig,
  payload: string,
  signal?: AbortSignal,
): Promise<RouterDecision | string> {
  const cmd = config.command[0];
  if (!cmd) return Promise.resolve("router command is empty");
  const args = config.command.slice(1);
  return new Promise<RouterDecision | string>((resolve) => {
    const child = spawn(cmd, args, {
      windowsHide: true,
      env: buildSanitizedChildEnv(process.env, {
        ...(config.passEnv !== undefined && { passEnv: config.passEnv }),
      }),
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(
      () => child.kill("SIGTERM"),
      config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    timer.unref();
    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf-8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf-8");
    });
    child.on("error", (err: Error) => {
      cleanup();
      resolve(`router ${cmd} failed: ${err.message}`);
    });
    child.on("close", (code: number | null) => {
      cleanup();
      if (code !== 0) {
        resolve(
          `router ${cmd} exited ${code ?? "null"}${stderr ? `: ${stderr.slice(0, 300)}` : ""}`,
        );
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as RouterDecision;
        if (!parsed.provider_id || !parsed.model_id) {
          resolve(
            `router returned no provider_id/model_id: ${stdout.slice(0, 200)}`,
          );
          return;
        }
        resolve(parsed);
      } catch {
        resolve(`router returned non-JSON: ${stdout.slice(0, 200)}`);
      }
    });
    if (child.stdin) {
      child.stdin.write(payload);
      child.stdin.end();
    }
  });
}

export function createRouterProvider(opts: {
  config: RouterConfig;
  resolveModel: ModelResolver;
}): LLMProvider {
  let cached: RouterDecision | null = null;

  async function resolveDelegate(
    req: CanonicalRequest,
    signal?: AbortSignal,
  ): Promise<{ provider: LLMProvider; modelId: string } | string> {
    if (!cached) {
      const decision = await runRouter(
        opts.config,
        routingPayload(req),
        signal,
      );
      if (typeof decision === "string") return decision;
      cached = decision;
      logger.info(
        {
          router: opts.config.providerId,
          chose: `${decision.provider_id}/${decision.model_id}`,
          rationale: decision.rationale,
        },
        "router chose a model",
      );
    }
    const resolved = opts.resolveModel(cached.provider_id, cached.model_id);
    if (typeof resolved === "string") return resolved;
    return { provider: resolved, modelId: cached.model_id };
  }

  async function* stream(
    req: CanonicalRequest,
    callOpts?: ProviderCallOptions,
  ): AsyncIterable<CanonicalEvent> {
    const delegate = await resolveDelegate(req, callOpts?.signal);
    if (typeof delegate === "string") {
      yield {
        type: "error",
        code: "ROUTER_FAILED",
        message: delegate,
        retryable: false,
      };
      return;
    }
    // The request reaching this provider still carries the router row's own id
    // as req.model (that's what the user asked for on the CLI). The delegate is
    // a concrete adapter that sends req.model on the wire, so it must see the
    // ROUTED model id, not "crabmeat-router".
    yield* delegate.provider.stream(
      { ...req, model: delegate.modelId },
      callOpts,
    );
  }

  async function complete(
    req: CanonicalRequest,
    callOpts?: ProviderCallOptions,
  ): Promise<CanonicalResponse> {
    const delegate = await resolveDelegate(req, callOpts?.signal);
    if (typeof delegate === "string") {
      return {
        text: delegate,
        toolCalls: [],
        finishReason: "error",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    }
    return delegate.provider.complete(
      { ...req, model: delegate.modelId },
      callOpts,
    );
  }

  return { name: opts.config.providerId, stream, complete };
}
