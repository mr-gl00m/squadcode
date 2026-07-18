import { createInterface } from "node:readline";
import type { JobRegistry } from "../engine/job-registry.js";
import { runAgentLoop } from "../engine/loop.js";
import type { DiagnosticsSetup } from "../engine/post-edit-diagnostics.js";
import { makePreTurnInjector } from "../engine/pre-turn.js";
import type { TimerRegistry } from "../engine/timer-registry.js";
import {
  guardianYoloAdvice,
  guardPermissionRequest,
  type PermissionGuardian,
} from "../guardian.js";
import type { HookRunner } from "../hooks/runner.js";
import { logger } from "../logger.js";
import type { NotificationConfig } from "../notifications.js";
import { loadUserGlobalRules, persistUserRule } from "../permissions/global.js";
import { applyModeAddendums, type Mode } from "../permissions/plan.js";
import type { PolicyConfig, RuleMap } from "../permissions/policy.js";
import {
  loadProjectRules,
  persistProjectRule,
} from "../permissions/project.js";
import {
  type PromptOutcome,
  type PromptRequest,
  promptForPermission,
} from "../permissions/prompt.js";
import { calculateCost, lookupPricing } from "../pricing.js";
import { userPromptMessage } from "../prompts/boundary.js";
import type {
  CanonicalMessage,
  CanonicalToolCall,
  LLMProvider,
} from "../providers/types.js";
import { makeOffloadLargeOutput } from "../sessions/artifacts.js";
import { formatRecapFromMessages } from "../sessions/recap.js";
import type { SessionStore } from "../sessions/store.js";
import type { SessionMetadata } from "../sessions/types.js";
import { sanitizeForTerminal } from "../terminal.js";
import type { ToolRegistry } from "../tools/registry.js";
import { checklistMissingMessage, findChecklist } from "../yolo/checklist.js";
import {
  createYoloSession,
  type YoloSession,
  yoloSystemPromptAddendum,
} from "../yolo/index.js";
import { BANNER, bannerSubtitle } from "./banner.js";
import { persistEventToStore } from "./persist-event.js";
import { createPrintState, renderEvent } from "./print.js";
import { parseUsageArgs } from "./repl.js";
import { formatReplay, parseReplayLimit } from "./replay.js";
import { pickResumeTarget } from "./resume-target.js";
import {
  persistDefaultSelection,
  persistPermissionSound,
} from "./runtime-resolution.js";
import { handleSlash, type SlashContext } from "./slash.js";
import { formatUsageReport } from "./usage-format.js";

const VERSION = "1.9.1";

export interface SimpleReplOptions {
  provider: LLMProvider;
  providerName: string;
  model: string;
  registry: ToolRegistry;
  policy: PolicyConfig;
  cwd: string;
  systemPrompt: string;
  baseSystemPrompt: string;
  buildProvider: (name: string) => LLMProvider | string;
  store: SessionStore;
  sessionId: string;
  metadata: SessionMetadata;
  messages: CanonicalMessage[];
  guardian?: PermissionGuardian;
  resumed: boolean;
  allowProjectPersist: boolean;
  hookRunner: HookRunner;
  yolo: YoloSession | null;
  allowDeletes: boolean;
  notifications: NotificationConfig;
  jobs?: JobRegistry;
  timers?: TimerRegistry;
  diagnostics?: DiagnosticsSetup;
}

export async function runSimpleRepl(opts: SimpleReplOptions): Promise<void> {
  const messages: CanonicalMessage[] = [...opts.messages];
  const sessionRules: RuleMap = new Map();
  const projectRules: RuleMap = opts.allowProjectPersist
    ? await loadProjectRules(opts.cwd)
    : new Map();
  const userGlobalRules: RuleMap = await loadUserGlobalRules();
  let provider = opts.provider;
  let providerName = sanitizeForTerminal(opts.providerName);
  let model = sanitizeForTerminal(opts.model);
  let sessionId = opts.sessionId;
  let turnCount = opts.metadata.turnCount;
  let totalTokens = opts.metadata.totalTokens;
  let yolo: YoloSession | null = opts.yolo;
  let systemPrompt = opts.systemPrompt;
  let policy = opts.policy;
  let notificationSound = opts.notifications.permissionSound;
  const basePolicy = { ...opts.policy, dangerouslySkipPermissions: false };

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  const writePrompt = (): void => {
    process.stdout.write(
      `\n[${providerName}/${model} | turns:${turnCount} tokens:${totalTokens}]\n› `,
    );
  };

  const slashCtx: SlashContext = {
    get providerName() {
      return providerName;
    },
    get model() {
      return model;
    },
    setProvider: (name) => {
      const next = opts.buildProvider(name);
      if (typeof next === "string") return next;
      provider = next;
      providerName = sanitizeForTerminal(name);
      persistDefaultSelection(providerName, model);
      return null;
    },
    setModel: (name) => {
      model = sanitizeForTerminal(name);
      persistDefaultSelection(providerName, model);
    },
    messageCount: () => messages.length,
    skills: () => new Map(),
    outputStyles: () => new Map(),
    activeStyleName: () => null,
    setStyle: () => "output styles are only available in the interactive REPL",
    clearStyle: () => undefined,
    notificationSoundEnabled: () => notificationSound,
    setNotificationSound: (enabled) => {
      notificationSound = enabled;
      persistPermissionSound(enabled);
    },
    costSummary: () => {
      const lines = [
        `provider/model:  ${providerName}/${model}`,
        `turns:           ${turnCount}`,
        `tokens (total):  ${totalTokens.toLocaleString()}`,
        `cost:            (not tracked in fallback REPL)`,
      ];
      return lines.join("\n");
    },
    usageReport: (arg: string) => {
      const parsed = parseUsageArgs(arg);
      const filter: { sessionId?: string; cwd?: string; sinceIso?: string } =
        {};
      let scopeLabel: string;
      if (parsed.scope === "session") {
        filter.sessionId = sessionId;
        scopeLabel = `current session (${sessionId.slice(0, 8)})`;
      } else if (parsed.scope === "all") {
        scopeLabel = "all sessions";
      } else {
        filter.cwd = opts.cwd;
        scopeLabel = `cwd ${opts.cwd}`;
      }
      if (parsed.daysBack !== undefined) {
        const since = new Date(Date.now() - parsed.daysBack * 86_400_000);
        filter.sinceIso = since.toISOString();
        scopeLabel += `, last ${parsed.daysBack} day${parsed.daysBack === 1 ? "" : "s"}`;
      }
      const totals = opts.store.usageTotals(filter);
      const byDay = opts.store.usageByDay(filter, parsed.daysBack ?? 14);
      const byModel = opts.store.usageByModel(filter);
      const bySession = opts.store.usageBySession(filter, 10);
      return formatUsageReport(
        { totals, byDay, byModel, bySession },
        {
          scopeLabel,
          ...(parsed.daysBack !== undefined && { daysBack: parsed.daysBack }),
        },
      );
    },
    toolList: () => {
      const tools = opts.registry.list();
      const lines = tools.map((t) => {
        const tag = t.isReadOnly ? "ro" : "rw";
        const desc =
          t.description.length > 80
            ? `${t.description.slice(0, 77)}...`
            : t.description;
        return `  ${t.name.padEnd(12)} [${tag}, ${t.defaultPermission}] — ${desc}`;
      });
      return `${tools.length} tool${tools.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
    },
    sessionList: () => {
      const recent = opts.store.list({ cwd: opts.cwd, limit: 10 });
      if (recent.length === 0) return `no sessions yet for ${opts.cwd}`;
      const lines = recent.map((s) => {
        const id = s.sessionId.slice(0, 8);
        const when = s.updatedAt.replace("T", " ").slice(0, 19);
        const here = s.sessionId === sessionId ? " (current)" : "";
        return `  ${id}  ${when}  ${s.provider}/${s.model}  ${s.turnCount} turn${s.turnCount === 1 ? "" : "s"}${here}`;
      });
      return `recent sessions in ${opts.cwd}:\n${lines.join("\n")}`;
    },
    resolveResume: (arg) =>
      pickResumeTarget(opts.store.list({ cwd: opts.cwd }), sessionId, arg),
    replay: (arg) =>
      formatReplay(messages, sessionId.slice(0, 8), parseReplayLimit(arg)),
    clear: () => {
      messages.length = 0;
      sessionRules.clear();
    },
    recap: () => {
      const usage = opts.store.usageTotals({ sessionId: sessionId });
      return formatRecapFromMessages({
        metadata: {
          ...opts.metadata,
          turnCount,
          totalTokens,
          provider: providerName,
          model,
        },
        messages,
        usage,
      });
    },
    yoloStatus: () => {
      if (yolo) {
        return `YOLO is ON. PathGuard=${opts.cwd}. Archive=${yolo.archiveDir}. Checklist=${yolo.checklistPath ?? "(none)"}.`;
      }
      return "YOLO is OFF.";
    },
    toggleYolo: async () => {
      if (yolo) {
        yolo = null;
        systemPrompt = applyModeAddendums(opts.baseSystemPrompt, {
          plan: policy.mode === "plan",
        });
        policy = { ...basePolicy, mode: policy.mode };
        return "YOLO disarmed. Permission prompts are back on.";
      }
      const checklist = await findChecklist(opts.cwd);
      if (!checklist) {
        return checklistMissingMessage();
      }
      const guardianAdvice = await guardianYoloAdvice(
        opts.guardian,
        opts.cwd,
        checklist.path,
      );
      yolo = createYoloSession({
        cwd: opts.cwd,
        checklistPath: checklist.path,
      });
      const addendum = `${yoloSystemPromptAddendum(yolo)}\n\n## Loaded checklist (${checklist.path})\n${checklist.contents}`;
      systemPrompt = applyModeAddendums(opts.baseSystemPrompt, {
        yolo: addendum,
        plan: policy.mode === "plan",
      });
      policy = {
        ...basePolicy,
        dangerouslySkipPermissions: true,
        mode: policy.mode,
      };
      const armed = `YOLO armed. PathGuard=${opts.cwd}. Archive=${yolo.archiveDir}. Checklist=${checklist.path}.`;
      return guardianAdvice ? `[advisory] ${guardianAdvice}\n${armed}` : armed;
    },
    getMode: () => policy.mode,
    setMode: (next: Mode) => {
      policy.mode = next;
      const yoloAddendum = yolo
        ? `${yoloSystemPromptAddendum(yolo)}${
            yolo.checklistPath
              ? `\n\n## Loaded checklist (${yolo.checklistPath})`
              : ""
          }`
        : null;
      systemPrompt = applyModeAddendums(opts.baseSystemPrompt, {
        yolo: yoloAddendum,
        plan: next === "plan",
      });
      return next === "plan"
        ? "mode → plan. Edit/Write/ApplyPatch will be denied; Shell will ask. /mode act to resume."
        : "mode → act. Default permissions restored.";
    },
  };

  process.stdout.write(
    `${BANNER}\n${bannerSubtitle(VERSION, providerName, model)}\n`,
  );
  if (opts.resumed) {
    process.stdout.write(
      `(resumed session ${sessionId.slice(0, 8)} with ${messages.length} prior messages)\n`,
    );
  }
  writePrompt();

  const askPermission = async (req: PromptRequest): Promise<PromptOutcome> => {
    const guardedReq = await guardPermissionRequest(opts.guardian, req);
    const outcome = await promptForPermission(guardedReq, {
      allowProjectPersist: opts.allowProjectPersist,
      allowUserPersist: true,
    });
    opts.store.recordPermissionDecision(sessionId, {
      tool: req.toolName,
      callId: req.callId,
      outcome,
    });
    if (outcome === "always-project" && opts.allowProjectPersist) {
      try {
        for (const pattern of req.scopePatterns) {
          await persistProjectRule(opts.cwd, req.toolName, pattern, "allow");
        }
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "failed to persist project permission",
        );
      }
    }
    if (outcome === "always-user") {
      try {
        for (const pattern of req.scopePatterns) {
          await persistUserRule(req.toolName, pattern, "allow");
        }
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "failed to persist user-global permission",
        );
      }
    }
    return outcome;
  };

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) {
      writePrompt();
      continue;
    }

    if (line.startsWith("/")) {
      const result = handleSlash(line, slashCtx);
      process.stdout.write(`${sanitizeForTerminal(result.message)}\n`);
      if (result.followup?.kind === "compact") {
        process.stdout.write("(compact not supported in fallback REPL)\n");
      }
      if (result.followup?.kind === "skill") {
        process.stdout.write("(skills not supported in fallback REPL)\n");
      }
      if (result.followup?.kind === "yolo-toggle" && slashCtx.toggleYolo) {
        const msg = await slashCtx.toggleYolo();
        process.stdout.write(`${sanitizeForTerminal(msg)}\n`);
      }
      if (result.followup?.kind === "resume") {
        const resumed = await opts.store.resume(result.followup.sessionId);
        messages.length = 0;
        messages.push(...resumed.messages);
        sessionRules.clear();
        sessionId = resumed.metadata.sessionId;
        turnCount = resumed.metadata.turnCount;
        totalTokens = resumed.metadata.totalTokens;
        process.stdout.write(
          `(resumed session ${sessionId.slice(0, 8)} with ${messages.length} prior messages)\n`,
        );
      }
      if (result.exit) break;
      writePrompt();
      continue;
    }

    messages.push(userPromptMessage(line));
    await opts.store.appendUserMessage(sessionId, line);
    try {
      await opts.hookRunner.fire({
        event: "UserPromptSubmit",
        sessionId: sessionId,
        cwd: opts.cwd,
        prompt: line,
      });
    } catch (err: unknown) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "UserPromptSubmit hook fire failed",
      );
    }

    const abort = new AbortController();
    const onSigint = (): void => {
      process.stderr.write("\nreceived SIGINT, aborting turn...\n");
      abort.abort();
    };
    process.on("SIGINT", onSigint);

    const buffers = {
      text: "",
      reasoning: "",
      pendingToolCalls: [] as CanonicalToolCall[],
      turnTokens: 0,
    };
    let turnToolCalls = 0;

    const state = createPrintState();
    try {
      for await (const ev of runAgentLoop({
        provider,
        model,
        systemPrompt,
        messages,
        registry: opts.registry,
        policy,
        cwd: opts.cwd,
        abort: abort.signal,
        sessionRules,
        projectRules,
        userGlobalRules,
        askPermission,
        offloadLargeOutput: makeOffloadLargeOutput({
          sessionId: sessionId,
        }),
        hookRunner: opts.hookRunner,
        sessionId: sessionId,
        ...(opts.jobs && { jobs: opts.jobs }),
        ...(opts.timers && { timers: opts.timers }),
        ...(opts.diagnostics && { diagnostics: opts.diagnostics.tracker }),
        ...((opts.jobs || opts.timers || opts.diagnostics) && {
          injectPreTurn: makePreTurnInjector({
            instructionsCwd: opts.cwd,
            ...(opts.timers && { timers: opts.timers }),
            ...(opts.jobs && { jobs: opts.jobs }),
            ...(opts.diagnostics && { diagnostics: opts.diagnostics }),
          }),
        }),
        ...(yolo && { yolo }),
        ...(opts.allowDeletes && { allowDeletes: true }),
      })) {
        if (ev.type === "usage") {
          totalTokens += ev.usage.totalTokens;
          const pricing = lookupPricing(providerName, model);
          const cost = pricing
            ? calculateCost(
                pricing,
                ev.usage.inputTokens,
                ev.usage.outputTokens,
                ev.usage.cachedInputTokens,
              )
            : 0;
          opts.store.recordUsage({
            ts: new Date().toISOString(),
            sessionId: sessionId,
            cwd: opts.cwd,
            provider: providerName,
            model,
            inputTokens: ev.usage.inputTokens,
            cachedInputTokens: ev.usage.cachedInputTokens ?? 0,
            outputTokens: ev.usage.outputTokens,
            totalTokens: ev.usage.totalTokens,
            costUsd: cost,
            toolCalls: turnToolCalls,
            source: "turn",
          });
        }
        if (ev.type === "tool_call_done") turnToolCalls += 1;
        renderEvent(ev, state);
        await persistEventToStore(opts.store, sessionId, ev, buffers);
      }
      opts.store.bumpUsage(sessionId, 1, buffers.turnTokens);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "repl turn failed");
      process.stderr.write(`turn failed: ${sanitizeForTerminal(msg)}\n`);
    } finally {
      process.off("SIGINT", onSigint);
      await opts.store.flush(sessionId);
    }
    turnCount += 1;
    writePrompt();
  }

  rl.close();
}
