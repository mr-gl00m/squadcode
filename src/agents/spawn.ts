import {
  createJobRegistry,
  type JobHandle,
  type JobRegistry,
} from "../engine/job-registry.js";
import { runAgentLoop } from "../engine/loop.js";
import { setupPostEditDiagnostics } from "../engine/post-edit-diagnostics.js";
import { makePreTurnInjector } from "../engine/pre-turn.js";
import { createTimerRegistry } from "../engine/timer-registry.js";
import { logger } from "../logger.js";
import type { PolicyConfig, RuleMap } from "../permissions/policy.js";
import type { PromptRequest } from "../permissions/prompt.js";
import { userPromptMessage } from "../prompts/boundary.js";
import {
  assembleSubagentSystemPrompt,
  isScopeRefusal,
  parseSubagentReport,
} from "../prompts/subagent.js";
import type { CanonicalMessage, LLMProvider } from "../providers/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { anguishBand, createAnguishTracker } from "./anguish.js";
import {
  currentAgentId,
  runInSubagentContext,
  type SubagentContext,
} from "./context.js";
import type { HowlBus } from "./howl.js";
import type { IdentityPool } from "./identity.js";
import { killAgent } from "./kill.js";
import type { MessageBus } from "./message-bus.js";
import { resolveAgentRuleset } from "./per-agent-rulesets.js";
import type { AgentRegistry } from "./registry.js";
import { buildSubagentRegistry } from "./registry-build.js";
import { deriveSubagentSessionPermission } from "./subagent-permissions.js";
import {
  AgentError,
  type AgentId,
  type AgentStatus,
  type SubagentDef,
  type SubagentRecord,
  type SubagentReport,
} from "./types.js";
import { type AgentWorktree, createAgentWorktree } from "./worktree.js";

// Per-subagent budget the anguish tracker normalizes time against. 30 min is a
// soft horizon, not a hard kill — it only shapes the meter. Phase 13's timer
// registry is where a real "ping if not done" deadline will live.
const DEFAULT_ANGUISH_BUDGET_MS = 30 * 60 * 1000;
const DEFAULT_SUBAGENT_MAX_TURNS = 25;

// Everything spawn needs that lives for the whole session: the slot registry,
// id pool, howl bus, the permission message-bus, the parent's tool registry to
// clone from, and a factory that turns a (provider, model) pair into an
// LLMProvider (closing over the catalog + dispatch env). controllers maps a
// live agent id to its AbortController so kill.ts can cascade.
export interface AgentRuntime {
  registry: AgentRegistry;
  identity: IdentityPool;
  howl: HowlBus;
  bus: MessageBus;
  controllers: Map<AgentId, AbortController>;
  baseRegistry: ToolRegistry;
  // cwd is the worktree path when a subagent runs isolated — external-cli
  // providers run their child there.
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
  parentSessionRules?: RuleMap;
  parentAgentRules?: RuleMap;
  userGlobalRules?: RuleMap;
  defaultAgentRuleset?: RuleMap;
  maxTurns?: number;
  yolo?: boolean;
  // The parent's job registry. When present, each subagent run is registered as
  // a job (id = the agent designation) so the TUI / JobKill / Ctrl+K can see and
  // stop a running child by its KT-4 id. The model's Agent call still blocks on
  // the result — this handle is for out-of-band observation and interrupt.
  parentJobs?: JobRegistry;
}

export interface SpawnResult {
  record: SubagentRecord;
  report: SubagentReport;
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function spawnSubagent(
  rt: AgentRuntime,
  def: SubagentDef,
  task: string,
): Promise<SpawnResult> {
  const slotKey = rt.registry.claimSlot();
  if (slotKey === null) {
    // Fail fast rather than queue — the 4-slot ceiling is a real limit, and a
    // silently-queued spawn would deadlock a parent that's blocking on it.
    throw new AgentError(
      "AGENT_SLOTS_FULL",
      `all ${rt.registry.maxSlots} subagent slots are occupied`,
    );
  }

  const id = rt.identity.allocate();
  const model = def.model ?? rt.defaultModel;
  const provider = def.provider ?? rt.defaultProvider;
  const parentAgentId = currentAgentId();

  // Explicit worktree isolation fails closed: this subagent never falls back
  // to the parent checkout when git cannot create the requested worktree.
  let worktree: AgentWorktree | null = null;
  if (def.isolation === "worktree") {
    try {
      worktree = await createAgentWorktree(rt.cwd, id, { required: true });
    } catch (err: unknown) {
      rt.identity.release(id);
      rt.registry.releaseSlot(slotKey);
      throw new AgentError(
        "WORKTREE_REQUIRED",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  const effectiveCwd = worktree?.path ?? rt.cwd;

  const record: SubagentRecord = {
    id,
    type: def.name,
    slotKey,
    model,
    provider,
    task,
    status: "running",
    anguish: 0,
    startedAt: nowIso(),
    ...(parentAgentId !== undefined && { parentAgentId }),
    ...(worktree && { worktree: worktree.path }),
  };
  rt.registry.register(record);
  rt.howl.emit({
    kind: "spawned",
    agentId: id,
    type: def.name,
    slotKey,
    model,
    provider,
    at: record.startedAt,
  });
  rt.howl.emit({
    kind: "roster",
    living: rt.registry.living().map((r) => r.id),
  });

  // Register the run as a job in the parent's registry (id = the agent
  // designation). onCancel routes through killAgent so JobKill / Ctrl+K stamp
  // the terminal status and abort the controller, same as a direct kill.
  const subagentJob: JobHandle | undefined = rt.parentJobs?.create({
    type: "subagent",
    id,
    title: def.name,
    onCancel: () => killAgent(rt.registry, rt.controllers, id, "user killed"),
  });

  const finish = (
    status: AgentStatus,
    report: SubagentReport,
    extra: {
      error?: string;
      terminationReason?: string;
      anguish?: number;
    } = {},
  ): SpawnResult => {
    rt.identity.release(id);
    rt.controllers.delete(id);
    if (subagentJob) {
      const jobStatus =
        status === "completed"
          ? "completed"
          : status === "user_killed"
            ? "cancelled"
            : "error";
      subagentJob.settle(jobStatus, {
        ...(extra.error !== undefined && { error: extra.error }),
      });
    }
    const patch: Partial<SubagentRecord> = {
      status,
      report,
      completedAt: nowIso(),
      anguish: extra.anguish ?? record.anguish,
    };
    if (extra.error !== undefined) patch.error = extra.error;
    if (extra.terminationReason !== undefined)
      patch.terminationReason = extra.terminationReason;
    rt.registry.update(id, patch);
    rt.howl.emit({ kind: "status", agentId: id, status });
    rt.howl.emit({
      kind: "terminated",
      agentId: id,
      status,
      ...(extra.terminationReason !== undefined && {
        reason: extra.terminationReason,
      }),
      at: patch.completedAt ?? nowIso(),
    });
    rt.howl.emit({
      kind: "roster",
      living: rt.registry.living().map((r) => r.id),
    });
    const finalRecord = rt.registry.get(id) ?? { ...record, ...patch };
    return { record: finalRecord, report };
  };

  const built = rt.makeProvider(provider, model, effectiveCwd);
  if (typeof built === "string") {
    const report: SubagentReport = {
      summary: `subagent ${id} could not start: ${built}`,
      evidence: [],
      changes: [],
      risks: [],
      blockers: [built],
      raw: built,
    };
    logger.warn(
      { agentId: id, provider, model, reason: built },
      "subagent provider build failed",
    );
    // Nothing ran — tear down the (empty) worktree rather than leave litter.
    if (worktree) await worktree.remove();
    return finish("failed_unfulfilled", report, { error: built });
  }

  const childRegistry = buildSubagentRegistry(rt.baseRegistry, def);
  const agentRuleset = resolveAgentRuleset({
    ...(rt.defaultAgentRuleset && { defaults: rt.defaultAgentRuleset }),
    ...(def.permissions && { agentRules: def.permissions }),
  });
  const sessionRules = deriveSubagentSessionPermission({
    ...(rt.parentSessionRules && { parentSessionRules: rt.parentSessionRules }),
    ...(rt.parentAgentRules && { parentAgentRules: rt.parentAgentRules }),
    subagentRules: agentRuleset,
  });

  const ac = new AbortController();
  const onParentAbort = (): void => ac.abort();
  if (rt.parentAbort.aborted) ac.abort();
  else rt.parentAbort.addEventListener("abort", onParentAbort, { once: true });
  rt.controllers.set(id, ac);

  const ctx: SubagentContext = {
    agentId: id,
    slotKey,
    model,
    provider,
    abortController: ac,
    ...(parentAgentId !== undefined && { parentAgentId }),
  };

  const childBus = rt.bus.derive(id, def.name);
  const withAgentMeta = (req: PromptRequest): PromptRequest => ({
    ...req,
    agentId: id,
    agentType: def.name,
    agentCwd: effectiveCwd,
    agentProvider: provider,
    agentModel: model,
    ...(rt.yolo !== undefined && { agentYolo: rt.yolo }),
  });

  const tracker = createAnguishTracker({
    startedAtMs: Date.now(),
    deadlineMs: DEFAULT_ANGUISH_BUDGET_MS,
  });

  const childMessages: CanonicalMessage[] = [userPromptMessage(task)];
  const policy: PolicyConfig = { ...rt.basePolicy, cwd: effectiveCwd };
  // Each subagent gets its own job + timer registries for its own backgrounded
  // shells and self-set timers — no cross-registry visibility with the parent
  // or sibling subagents (the isolation contract from Phase 12). Post-edit
  // diagnostics likewise: own tracker, tier-1 syntax checks only (a
  // project-wide typecheck command per subagent turn would be too heavy).
  const childJobs = createJobRegistry();
  const childTimers = createTimerRegistry();
  const childDiagnostics = await setupPostEditDiagnostics(effectiveCwd, {
    withCommand: false,
  });
  let sawFatalError = false;
  let lastAnguish = 0;

  try {
    await runInSubagentContext(ctx, async () => {
      for await (const ev of runAgentLoop({
        provider: built,
        model,
        systemPrompt: assembleSubagentSystemPrompt(def),
        messages: childMessages,
        registry: childRegistry,
        policy,
        cwd: effectiveCwd,
        abort: ac.signal,
        maxTurns: rt.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS,
        sessionRules,
        projectRules: agentRuleset,
        ...(rt.userGlobalRules && { userGlobalRules: rt.userGlobalRules }),
        jobs: childJobs,
        timers: childTimers,
        ...(childDiagnostics && { diagnostics: childDiagnostics.tracker }),
        injectPreTurn: makePreTurnInjector({
          instructionsCwd: effectiveCwd,
          timers: childTimers,
          jobs: childJobs,
          ...(childDiagnostics && { diagnostics: childDiagnostics }),
        }),
        askPermission: (req) => childBus.requestPermission(withAgentMeta(req)),
      })) {
        if (ev.type === "tool_call_start") {
          rt.howl.publish({ kind: "action", agentId: id, action: ev.name });
        } else if (ev.type === "tool_result") {
          if (ev.ok || ev.reason === "denied") tracker.recordToolSuccess();
          else if (ev.reason === "executed" || ev.reason === "unknown_tool")
            tracker.recordToolFailure();
          lastAnguish = tracker.value(Date.now());
          rt.howl.publish({
            kind: "anguish",
            agentId: id,
            value: lastAnguish,
            band: anguishBand(lastAnguish),
          });
          rt.howl.commit();
        } else if (ev.type === "error") {
          sawFatalError = true;
        }
      }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ agentId: id, err: message }, "subagent loop threw");
    sawFatalError = true;
  } finally {
    rt.parentAbort.removeEventListener("abort", onParentAbort);
  }

  // Memory ephemerality (FETCH §8): everything the run learned lives in
  // childMessages, and it is about to go out of scope. The parent receives the
  // structured report and nothing else — no working messages, no tool log.
  let finalText = "";
  for (let i = childMessages.length - 1; i >= 0; i -= 1) {
    const m = childMessages[i];
    if (m && m.role === "assistant" && m.content.trim().length > 0) {
      finalText = m.content;
      break;
    }
  }
  const report = parseSubagentReport(finalText);
  lastAnguish = tracker.value(Date.now());

  // A kill mid-run already stamped a terminal status; don't overwrite it.
  const current = rt.registry.get(id);
  if (current && current.status !== "running") {
    return finish(current.status, report, {
      anguish: lastAnguish,
      ...(current.terminationReason !== undefined && {
        terminationReason: current.terminationReason,
      }),
    });
  }

  const anguishTerminal = anguishBand(lastAnguish) === "terminal";
  let status: AgentStatus;
  if (isScopeRefusal(report)) status = "scope_refused";
  else if (sawFatalError)
    status = anguishTerminal ? "anguish_terminal" : "failed_unfulfilled";
  else status = "completed";

  return finish(status, report, { anguish: lastAnguish });
}
