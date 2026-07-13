import type { ModelCatalog, ModelEntry } from "./catalog.js";
import { createExternalCliProvider } from "./external-cli.js";
import { createLlmChatProvider } from "./llm-chat.js";
import { createLlmLocalProvider } from "./llm-local.js";
import { createLlmMessageProvider } from "./llm-message.js";
import { createLlmResponseProvider } from "./llm-response.js";
import { wrapProviderWithProseRecovery } from "./prose-tool-recovery.js";
import { createRouterProvider, type ModelResolver } from "./router.js";
import type { LLMProvider } from "./types.js";

// Dispatch a resolved catalog entry to the right adapter factory. Returns
// either a working LLMProvider or a string error message naming the missing
// piece (env var unset, kind not yet implemented, SSRF-blocked URL). The
// CLI surfaces the string to the user instead of crashing.

export interface DispatchEnv {
  // Lookup an env var by name. Used to read API keys and base-URL overrides
  // declared on catalog rows. Caller passes process.env or a test double.
  get(name: string): string | undefined;
  // SSRF guard for llm-local: when false (default), reject non-localhost
  // base URLs to prevent a hostile catalog override from reaching out to a
  // remote endpoint. Mirrors the OLLAMA_ALLOW_REMOTE escape hatch from v1.0.
  allowRemoteLocal?: boolean;
}

export function makeEnvFromProcess(allowRemoteLocal: boolean): DispatchEnv {
  return {
    get: (name) => process.env[name],
    allowRemoteLocal,
  };
}

function resolvedBaseUrl(entry: ModelEntry, env: DispatchEnv): string {
  if (entry.base_url_env_var) {
    const fromEnv = env.get(entry.base_url_env_var);
    if (fromEnv && fromEnv.length > 0) return fromEnv;
  }
  return entry.base_url;
}

function isLocalUrl(value: string): boolean {
  const hostname = new URL(value).hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

export interface DispatchOptions {
  // Working directory for an external-cli provider's child process. Set by the
  // subagent spawn path to a fresh git worktree when the def requests
  // isolation; ignored by the API-backed kinds.
  cwd?: string;
  // Resolves a (provider_id, model_id) to a provider — required for kind=router,
  // which delegates to the model the external router picks. The CLI layer
  // supplies it (closing over the catalog + env); omitting it makes a router row
  // a clean error rather than a crash.
  resolveModel?: ModelResolver;
}

export function dispatchProvider(
  entry: ModelEntry,
  env: DispatchEnv,
  opts: DispatchOptions = {},
): LLMProvider | string {
  const provider = dispatchProviderRaw(entry, env, opts);
  if (typeof provider === "string") return provider;
  // Prose tool-call recovery is a local-model compatibility layer applied to
  // the API-backed adapters. A router delegates to a model that is itself
  // dispatched (and so already wrapped); external-cli does its own parsing.
  if (entry.kind === "router" || entry.kind === "external-cli") return provider;
  return wrapProviderWithProseRecovery(provider);
}

function dispatchProviderRaw(
  entry: ModelEntry,
  env: DispatchEnv,
  opts: DispatchOptions,
): LLMProvider | string {
  const baseUrl = resolvedBaseUrl(entry, env);

  switch (entry.kind) {
    case "llm-chat": {
      if (!entry.env_key_var) {
        return `model "${entry.id}": kind=llm-chat requires env_key_var on the catalog entry`;
      }
      const apiKey = env.get(entry.env_key_var);
      if (!apiKey || apiKey.length === 0) {
        return `${entry.env_key_var} is not set`;
      }
      return createLlmChatProvider({
        apiKey,
        baseUrl,
        providerId: entry.provider_id,
        ...(entry.capabilities && { capabilities: entry.capabilities }),
      });
    }
    case "llm-local": {
      if (!env.allowRemoteLocal && !isLocalUrl(baseUrl)) {
        return `${entry.base_url_env_var ?? "base_url"} must be localhost unless OLLAMA_ALLOW_REMOTE=1`;
      }
      return createLlmLocalProvider({
        baseUrl,
        providerId: entry.provider_id,
        ...(entry.capabilities && { capabilities: entry.capabilities }),
      });
    }
    case "llm-message": {
      if (!entry.env_key_var) {
        return `model "${entry.id}": kind=llm-message requires env_key_var on the catalog entry`;
      }
      const apiKey = env.get(entry.env_key_var);
      if (!apiKey || apiKey.length === 0) {
        return `${entry.env_key_var} is not set`;
      }
      return createLlmMessageProvider({
        apiKey,
        baseUrl,
        providerId: entry.provider_id,
        ...(entry.capabilities && { capabilities: entry.capabilities }),
      });
    }
    case "llm-response": {
      if (!entry.env_key_var) {
        return `model "${entry.id}": kind=llm-response requires env_key_var on the catalog entry`;
      }
      const apiKey = env.get(entry.env_key_var);
      if (!apiKey || apiKey.length === 0) {
        return `${entry.env_key_var} is not set`;
      }
      return createLlmResponseProvider({
        apiKey,
        baseUrl,
        providerId: entry.provider_id,
        ...(entry.capabilities && { capabilities: entry.capabilities }),
      });
    }
    case "external-cli": {
      const cfg = entry.external_cli;
      if (!cfg) {
        return `model "${entry.id}": kind=external-cli requires an external_cli config on the catalog entry`;
      }
      return createExternalCliProvider({
        providerId: entry.provider_id,
        command: cfg.command,
        ...(cfg.prompt_via && { promptVia: cfg.prompt_via }),
        ...(cfg.parse && {
          parse: {
            mode: cfg.parse.mode,
            ...(cfg.parse.json_path && { jsonPath: cfg.parse.json_path }),
          },
        }),
        ...(cfg.timeout_ms !== undefined && { timeoutMs: cfg.timeout_ms }),
        ...(cfg.pass_env !== undefined && { passEnv: cfg.pass_env }),
        ...(opts.cwd !== undefined && { cwd: opts.cwd }),
      });
    }
    case "router": {
      const cfg = entry.router;
      if (!cfg) {
        return `model "${entry.id}": kind=router requires a router config on the catalog entry`;
      }
      if (!opts.resolveModel) {
        return `model "${entry.id}": kind=router needs a model resolver (use the CLI's buildProviderForModel, not dispatchProvider directly)`;
      }
      return createRouterProvider({
        config: {
          providerId: entry.provider_id,
          command: cfg.command,
          ...(cfg.timeout_ms !== undefined && { timeoutMs: cfg.timeout_ms }),
          ...(cfg.pass_env !== undefined && { passEnv: cfg.pass_env }),
        },
        resolveModel: opts.resolveModel,
      });
    }
  }
}

// Which mechanism matched (or was tried) when resolving a (provider, model)
// pair to a catalog entry.
export type ResolveStage = "model_id" | "alias" | "provider_default";

export interface ResolveStep {
  stage: ResolveStage;
  query: string;
  outcome: "hit" | "miss" | "provider_mismatch";
  matchedId?: string;
}

export interface ResolveTrace {
  entry?: ModelEntry;
  chain: ResolveStep[];
  reason: string;
}

// Resolve a (provider, model) pair the same way catalog.resolveEntry does, but
// record the lookup chain so the caller can see WHY an entry was chosen — or,
// on a miss/mismatch, exactly what was tried and why it failed. Resolution
// behavior is unchanged: an explicit-but-unknown model id is still strict (no
// silent fallback to the provider default), so a typo surfaces instead of
// quietly running a different model. This only adds the telemetry.
export function resolveEntryTraced(
  catalog: ModelCatalog,
  providerId: string | undefined,
  modelId: string | undefined,
): ResolveTrace {
  const chain: ResolveStep[] = [];

  if (modelId !== undefined) {
    const got = catalog.get(modelId);
    if (!got) {
      chain.push({ stage: "model_id", query: modelId, outcome: "miss" });
      return { chain, reason: `model "${modelId}" is not in the catalog` };
    }
    // catalog.get() resolves both primary ids and aliases; post-classify which.
    const stage: ResolveStage = got.id === modelId ? "model_id" : "alias";
    if (providerId !== undefined && got.provider_id !== providerId) {
      chain.push({
        stage,
        query: modelId,
        outcome: "provider_mismatch",
        matchedId: got.id,
      });
      return {
        chain,
        reason: `model "${modelId}" belongs to provider "${got.provider_id}", not "${providerId}"`,
      };
    }
    chain.push({ stage, query: modelId, outcome: "hit", matchedId: got.id });
    const via = stage === "alias" ? ` (alias of ${got.id})` : "";
    return { entry: got, chain, reason: `resolved model "${modelId}"${via}` };
  }

  if (providerId !== undefined) {
    const candidates = catalog.byProvider(providerId);
    const first = candidates[0];
    if (first) {
      chain.push({
        stage: "provider_default",
        query: providerId,
        outcome: "hit",
        matchedId: first.id,
      });
      return {
        entry: first,
        chain,
        reason: `provider "${providerId}" default model ${first.id}`,
      };
    }
    chain.push({
      stage: "provider_default",
      query: providerId,
      outcome: "miss",
    });
    return { chain, reason: `no catalog entry for provider "${providerId}"` };
  }

  return { chain, reason: "neither provider nor model specified" };
}

// Compact one-line rendering of a resolve chain for logs.
export function formatResolveChain(trace: ResolveTrace): string {
  if (trace.chain.length === 0) return "(no lookup performed)";
  return trace.chain
    .map((s) => {
      const tail = s.matchedId ? `->${s.matchedId}` : "";
      return `${s.stage}(${s.query}):${s.outcome}${tail}`;
    })
    .join(" | ");
}
