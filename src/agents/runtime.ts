import type { JobRegistry } from "../engine/job-registry.js";
import type { PolicyConfig, RuleMap } from "../permissions/policy.js";
import type { LLMProvider } from "../providers/types.js";
import type { AgentToolHost } from "../tools/agent.js";
import type { ToolRegistry } from "../tools/registry.js";
import { createHowlBus, type HowlBus } from "./howl.js";
import { createIdentityPool, type IdentityPool } from "./identity.js";
import {
  createMessageBus,
  type MessageBus,
  type PermissionResponder,
} from "./message-bus.js";
import { type AgentRegistry, createAgentRegistry } from "./registry.js";
import { type AgentRuntime, spawnSubagent } from "./spawn.js";
import { AgentError, type AgentId, type SubagentDef } from "./types.js";

// Wires the session's subagent runtime and resolves the one chicken-and-egg in
// the design: the AgentRuntime needs the tool registry to clone from, but that
// registry needs the Agent tool, which needs a host backed by the runtime.
// setBaseRegistry breaks the cycle — build the bundle, create the registry with
// bundle.host, then hand the registry back via setBaseRegistry before any spawn
// can run. baseRegistry is a getter that throws until that happens.
export interface CreateAgentRuntimeOptions {
  agentDefs: Map<string, SubagentDef>;
  makeProvider: (
    provider: string,
    model: string,
    cwd?: string,
  ) => LLMProvider | string;
  cwd: string;
  parentAbort: AbortSignal;
  defaultProvider: string;
  defaultModel: string;
  basePolicy: PolicyConfig;
  responder: PermissionResponder;
  parentSessionRules?: RuleMap;
  parentAgentRules?: RuleMap;
  userGlobalRules?: RuleMap;
  defaultAgentRuleset?: RuleMap;
  parentJobs?: JobRegistry;
  maxSlots?: number;
  maxTurns?: number;
  yolo?: boolean;
}

export interface AgentRuntimeBundle {
  runtime: AgentRuntime;
  host: AgentToolHost;
  slotRegistry: AgentRegistry;
  howl: HowlBus;
  identity: IdentityPool;
  bus: MessageBus;
  controllers: Map<AgentId, AbortController>;
  setBaseRegistry(reg: ToolRegistry): void;
}

export function createAgentRuntime(
  opts: CreateAgentRuntimeOptions,
): AgentRuntimeBundle {
  const slotRegistry = createAgentRegistry(
    opts.maxSlots !== undefined ? { maxSlots: opts.maxSlots } : {},
  );
  const identity = createIdentityPool();
  const howl = createHowlBus();
  const bus = createMessageBus(opts.responder);
  const controllers = new Map<AgentId, AbortController>();
  let baseRegistry: ToolRegistry | null = null;

  const runtime: AgentRuntime = {
    registry: slotRegistry,
    identity,
    howl,
    bus,
    controllers,
    get baseRegistry(): ToolRegistry {
      if (!baseRegistry) {
        throw new AgentError(
          "AGENT_RUNTIME_UNINITIALIZED",
          "agent runtime base registry not set — call setBaseRegistry first",
        );
      }
      return baseRegistry;
    },
    makeProvider: opts.makeProvider,
    cwd: opts.cwd,
    parentAbort: opts.parentAbort,
    defaultProvider: opts.defaultProvider,
    defaultModel: opts.defaultModel,
    basePolicy: opts.basePolicy,
    ...(opts.parentSessionRules && {
      parentSessionRules: opts.parentSessionRules,
    }),
    ...(opts.parentAgentRules && { parentAgentRules: opts.parentAgentRules }),
    ...(opts.userGlobalRules && { userGlobalRules: opts.userGlobalRules }),
    ...(opts.defaultAgentRuleset && {
      defaultAgentRuleset: opts.defaultAgentRuleset,
    }),
    ...(opts.parentJobs && { parentJobs: opts.parentJobs }),
    ...(opts.maxTurns !== undefined && { maxTurns: opts.maxTurns }),
    ...(opts.yolo !== undefined && { yolo: opts.yolo }),
  };

  const host: AgentToolHost = {
    defs: () => opts.agentDefs,
    spawn: (def, prompt) => spawnSubagent(runtime, def, prompt),
  };

  return {
    runtime,
    host,
    slotRegistry,
    howl,
    identity,
    bus,
    controllers,
    setBaseRegistry(reg: ToolRegistry): void {
      baseRegistry = reg;
    },
  };
}
