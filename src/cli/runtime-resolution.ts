import { randomUUID } from "node:crypto";
import type { PermissionResponder } from "../agents/message-bus.js";
import {
  type AgentRuntimeBundle,
  createAgentRuntime,
} from "../agents/runtime.js";
import { AgentError, type SubagentDef } from "../agents/types.js";
import type { LoadedConfiguration } from "../config/stack.js";
import type { JobRegistry } from "../engine/job-registry.js";
import {
  LocalPermissionGuardian,
  type PermissionGuardian,
} from "../guardian.js";
import { logger } from "../logger.js";
import type { Mode } from "../permissions/plan.js";
import type { PolicyConfig, RuleMap } from "../permissions/policy.js";
import type { ModelCatalog } from "../providers/catalog.js";
import {
  type DispatchEnv,
  dispatchProvider,
  formatResolveChain,
  resolveEntryTraced,
} from "../providers/dispatch.js";
import type { CanonicalMessage, LLMProvider } from "../providers/types.js";
import type { SessionStore } from "../sessions/store.js";
import type { SessionMetadata } from "../sessions/types.js";
import { updateDefaultSelection, updatePermissionSound } from "../settings.js";
import { sanitizeForTerminal } from "../terminal.js";
import type { AgentToolHost } from "../tools/agent.js";
import type { RootOptions } from "./program-options.js";

export function parseMode(raw: string | undefined): Mode | "invalid" {
  if (raw === undefined) return "act";
  const value = raw.toLowerCase();
  if (value === "plan" || value === "act") return value;
  return "invalid";
}

export function permissionModeConflict(
  opts: Pick<RootOptions, "dangerouslySkipPermissions" | "yolo">,
  mode: Mode,
): string | null {
  if (mode !== "plan") return null;
  if (opts.dangerouslySkipPermissions) {
    return "--mode plan cannot be combined with --dangerously-skip-permissions";
  }
  if (opts.yolo) return "--mode plan cannot be combined with --yolo";
  return null;
}

export function buildProviderForModel(
  catalog: ModelCatalog,
  providerName: string,
  modelId: string,
  dispatchEnv: DispatchEnv,
  cwd?: string,
): LLMProvider | string {
  const trace = resolveEntryTraced(catalog, providerName, modelId);
  logger.debug(
    { chain: formatResolveChain(trace), reason: trace.reason },
    "model resolve",
  );
  if (!trace.entry) {
    return `${trace.reason} — add one to ~/.squad/models.json or pick a known model`;
  }
  return dispatchProvider(trace.entry, dispatchEnv, {
    ...(cwd !== undefined && { cwd }),
    resolveModel: (provider, model) =>
      buildProviderForModel(catalog, provider, model, dispatchEnv),
  });
}

export function buildProviderForName(
  catalog: ModelCatalog,
  providerName: string,
  dispatchEnv: DispatchEnv,
): LLMProvider | string {
  const candidates = catalog.byProvider(providerName);
  const entry = candidates[0];
  if (!entry) {
    return `unknown provider "${providerName}" — no catalog entry. Edit ~/.squad/models.json to add one.`;
  }
  return dispatchProvider(entry, dispatchEnv);
}

export function buildPermissionGuardian(
  config: LoadedConfiguration,
  dispatchEnv: DispatchEnv,
  cwd: string,
): PermissionGuardian | null | string {
  if (!config.guardian.enabled) return null;
  const entry = config.catalog.get(config.guardian.model);
  if (!entry) {
    return `guardian model ${config.guardian.model} is not in the model catalog`;
  }
  if (entry.provider_id !== "ollama" || entry.kind !== "llm-local") {
    return `guardian model ${config.guardian.model} must be a local Ollama catalog row`;
  }
  const provider = buildProviderForModel(
    config.catalog,
    entry.provider_id,
    config.guardian.model,
    dispatchEnv,
    cwd,
  );
  if (typeof provider === "string") return provider;
  return new LocalPermissionGuardian(provider, config.guardian.model);
}

export interface DeferredAgentHost extends AgentToolHost {
  host: AgentToolHost;
  install(spawn: AgentToolHost["spawn"]): void;
}

export function createDeferredAgentHost(
  agentDefs: Map<string, SubagentDef>,
): DeferredAgentHost {
  let spawnImpl: AgentToolHost["spawn"] | null = null;
  const host: AgentToolHost = {
    defs: () => agentDefs,
    spawn: (def, prompt) => {
      if (!spawnImpl) {
        throw new AgentError(
          "AGENT_HOST_UNINITIALIZED",
          "agent spawn called before the runtime was wired",
        );
      }
      return spawnImpl(def, prompt);
    },
  };
  return {
    ...host,
    host,
    install: (spawn) => {
      spawnImpl = spawn;
    },
  };
}

export function buildAgentBundle(args: {
  agentDefs: Map<string, SubagentDef>;
  catalog: ModelCatalog;
  dispatchEnv: DispatchEnv;
  cwd: string;
  parentAbort: AbortSignal;
  providerName: string;
  model: string;
  policy: PolicyConfig;
  responder: PermissionResponder;
  userGlobalRules?: RuleMap;
  parentJobs?: JobRegistry;
  yolo?: boolean;
}): AgentRuntimeBundle {
  return createAgentRuntime({
    agentDefs: args.agentDefs,
    makeProvider: (provider, model, cwd) =>
      buildProviderForModel(
        args.catalog,
        provider,
        model,
        args.dispatchEnv,
        cwd,
      ),
    cwd: args.cwd,
    parentAbort: args.parentAbort,
    defaultProvider: args.providerName,
    defaultModel: args.model,
    basePolicy: args.policy,
    responder: args.responder,
    ...(args.userGlobalRules && { userGlobalRules: args.userGlobalRules }),
    ...(args.parentJobs && { parentJobs: args.parentJobs }),
    ...(args.yolo !== undefined && { yolo: args.yolo }),
  });
}

export function persistDefaultSelection(
  providerName: string,
  model: string,
): void {
  updateDefaultSelection(providerName, model).catch((err: unknown) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "default model selection persist failed",
    );
  });
}

export function persistPermissionSound(enabled: boolean): void {
  updatePermissionSound(enabled).catch((err: unknown) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "permission sound setting persist failed",
    );
  });
}

export async function resolveSession(
  store: SessionStore,
  opts: RootOptions,
  cwd: string,
  providerName: string,
  model: string,
  systemPrompt: string,
): Promise<{
  sessionId: string;
  metadata: SessionMetadata;
  messages: CanonicalMessage[];
  resumed: boolean;
}> {
  if (typeof opts.resume === "string") {
    const resumed = await store.resume(opts.resume);
    return {
      sessionId: resumed.metadata.sessionId,
      metadata: resumed.metadata,
      messages: resumed.messages,
      resumed: true,
    };
  }
  if (opts.resume === true || opts.continue === true) {
    const resumed = await store.resumeMostRecent(cwd);
    if (resumed) {
      return {
        sessionId: resumed.metadata.sessionId,
        metadata: resumed.metadata,
        messages: resumed.messages,
        resumed: true,
      };
    }
    process.stderr.write(
      `no prior session found for cwd ${sanitizeForTerminal(cwd)}; starting a new one\n`,
    );
  }
  const sessionId = randomUUID();
  const metadata = await store.create({
    sessionId,
    cwd,
    provider: providerName,
    model,
    systemPrompt,
  });
  return { sessionId, metadata, messages: [], resumed: false };
}
