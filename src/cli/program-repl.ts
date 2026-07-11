import { builtInAgentDefs } from "../agents/built-in/index.js";
import { loadAgentDefs } from "../agents/loader.js";
import type { PermissionResponder } from "../agents/message-bus.js";
import type { AgentRuntimeBundle } from "../agents/runtime.js";
import { loadConfigurationStack } from "../config/stack.js";
import { createJobRegistry } from "../engine/job-registry.js";
import { setupPostEditDiagnostics } from "../engine/post-edit-diagnostics.js";
import { createTimerRegistry } from "../engine/timer-registry.js";
import { guardianYoloAdvice } from "../guardian.js";
import type { HookRunner } from "../hooks/runner.js";
import { logger } from "../logger.js";
import { applyModeAddendums } from "../permissions/plan.js";
import { buildPolicyFromCli } from "../permissions/policy.js";
import { makeEnvFromProcess } from "../providers/dispatch.js";
import type { LLMProvider } from "../providers/types.js";
import { openSessionStore, recordsToMessages } from "../sessions/store.js";
import { sanitizeForTerminal } from "../terminal.js";
import { loadManifest } from "../tools/manifest.js";
import { createToolRegistry } from "../tools/registry.js";
import { checklistMissingMessage, findChecklist } from "../yolo/checklist.js";
import {
  createYoloSession,
  type YoloSession,
  yoloSystemPromptAddendum,
} from "../yolo/index.js";
import {
  buildHookRunner,
  fireSessionEnd,
  fireSessionStart,
} from "./hook-lifecycle.js";
import type { RootOptions } from "./program-options.js";
import { runtimeCliConfig } from "./program-options.js";
import { ensureProjectTrust, projectDefaultMode } from "./project-trust.js";
import type { ReplOptions } from "./repl.js";
import { DEFAULT_REPLAY_LIMIT, formatReplay } from "./replay.js";
import {
  buildAgentBundle,
  buildPermissionGuardian,
  buildProviderForModel,
  buildProviderForName,
  createDeferredAgentHost,
  parseMode,
  permissionModeConflict,
  persistDefaultSelection,
  resolveSession,
} from "./runtime-resolution.js";
import { runSimpleRepl } from "./simple-repl.js";
import { defaultSystemPrompt, prepareRepoMap } from "./system-prompt.js";

export async function runReplMode(opts: RootOptions): Promise<void> {
  const cwd = process.cwd();
  const config = await loadConfigurationStack({
    cwd,
    cli: runtimeCliConfig(opts),
  });
  const profileError = config.stack.explain("runtime.profile")?.disabledReason;
  if (profileError) {
    process.stderr.write(`${profileError}\n`);
    process.exitCode = 2;
    return;
  }
  const projectTrusted = await ensureProjectTrust(cwd, config.settings);
  const { env, catalog, provider: providerName, model } = config;
  const dispatchEnv = makeEnvFromProcess(env.OLLAMA_ALLOW_REMOTE);
  const guardianResult = buildPermissionGuardian(config, dispatchEnv, cwd);
  const guardian = typeof guardianResult === "string" ? null : guardianResult;
  if (typeof guardianResult === "string") {
    process.stderr.write(
      `guardian disabled: ${sanitizeForTerminal(guardianResult)}\n`,
    );
  }

  const built = buildProviderForModel(
    catalog,
    providerName,
    model,
    dispatchEnv,
  );
  if (typeof built === "string") {
    process.stderr.write(`${sanitizeForTerminal(built)}\n`);
    process.exitCode = 2;
    return;
  }
  const provider = built;
  persistDefaultSelection(providerName, model);
  const manifest = loadManifest(cwd);
  const preparedRepoMap = await prepareRepoMap(cwd, manifest !== null, true);
  const repoMap = preparedRepoMap.fragment;
  const agentDefs = await loadAgentDefs(cwd, builtInAgentDefs());
  const deferredHost =
    agentDefs.size > 0 ? createDeferredAgentHost(agentDefs) : null;
  const registry = createToolRegistry({
    manifest,
    repoMap,
    ...(deferredHost && { agentHost: deferredHost.host }),
  });

  let yolo: YoloSession | null = null;
  let yoloPromptAddendum = "";
  if (opts.yolo) {
    const checklist = await findChecklist(cwd);
    if (!checklist) {
      process.stderr.write(`${checklistMissingMessage()}\n`);
      process.exitCode = 2;
      return;
    }
    yolo = createYoloSession({ cwd, checklistPath: checklist.path });
    yoloPromptAddendum = `${yoloSystemPromptAddendum(yolo)}\n\n## Loaded checklist (${checklist.path})\n${checklist.contents}`;
    const guardianAdvice = await guardianYoloAdvice(
      guardian ?? undefined,
      cwd,
      checklist.path,
    );
    process.stdout.write(
      guardianAdvice ? `[advisory] ${guardianAdvice}\n` : "",
    );
    process.stdout.write(
      `YOLO mode armed. PathGuard=${cwd}. Archive=${yolo.archiveDir}. Checklist=${checklist.path}.\n`,
    );
  }

  const mode = parseMode(
    projectDefaultMode(opts.mode, projectTrusted, config.profileMode),
  );
  if (mode === "invalid") {
    process.stderr.write(
      `--mode must be "plan" or "act" (got "${opts.mode}")\n`,
    );
    process.exitCode = 2;
    return;
  }
  const permissionConflict = permissionModeConflict(opts, mode);
  if (permissionConflict) {
    process.stderr.write(`${permissionConflict}\n`);
    process.exitCode = 2;
    return;
  }
  const policy = buildPolicyFromCli({
    defaultMode: env.CLI_PERMISSION_MODE,
    allowedTools: opts.allowedTools,
    disallowedTools: opts.disallowedTools,
    dangerouslySkipPermissions: opts.dangerouslySkipPermissions || opts.yolo,
    dangerouslySkipReadPermissions: opts.dangerouslySkipReadPermissions,
    cwd,
    mode,
  });
  const buildProvider = (name: string): LLMProvider | string =>
    buildProviderForName(catalog, name, dispatchEnv);

  const jobs = createJobRegistry();
  const timers = createTimerRegistry();
  const diagnostics = await setupPostEditDiagnostics(cwd);
  const userGlobalRules = config.userGlobalRules;

  let agentResponder: PermissionResponder | null = null;
  const sessionAbort = new AbortController();
  let agentBundle: AgentRuntimeBundle | null = null;
  if (deferredHost) {
    agentBundle = buildAgentBundle({
      agentDefs,
      catalog,
      dispatchEnv,
      cwd,
      parentAbort: sessionAbort.signal,
      providerName,
      model,
      policy,
      responder: (envelope) =>
        agentResponder
          ? agentResponder(envelope)
          : Promise.resolve("deny" as const),
      ...(userGlobalRules.size > 0 && { userGlobalRules }),
      parentJobs: jobs,
      ...(opts.yolo && { yolo: true }),
    });
    agentBundle.setBaseRegistry(registry);
    deferredHost.install(agentBundle.host.spawn);
  }

  const store = openSessionStore();
  const session = await resolveSession(
    store,
    opts,
    cwd,
    providerName,
    model,
    defaultSystemPrompt(registry),
  );
  registry.markLoadedFromMessages(session.messages);

  const hookRunner = await buildHookRunner(
    store,
    session.sessionId,
    config.hooks.hooks,
  );
  await fireSessionStart(hookRunner, session.sessionId, cwd, session.resumed);
  const useSimple = opts.simple === true || !process.stdout.isTTY;

  logger.info(
    {
      provider: provider.name,
      model,
      sessionId: session.sessionId,
      resumed: session.resumed,
      mode: useSimple ? "simple" : "ink",
    },
    "repl starting",
  );

  const baseSystemPrompt = defaultSystemPrompt(registry);
  const systemPrompt = applyModeAddendums(baseSystemPrompt, {
    yolo: yolo ? yoloPromptAddendum : null,
    plan: policy.mode === "plan",
  });

  const recapIdleMinutes = config.recapIdleMinutes;
  const replOpts: ReplOptions = {
    store,
    sessionId: session.sessionId,
    metadata: session.metadata,
    messages: session.messages,
    resumed: session.resumed,
    provider,
    providerName,
    model,
    registry,
    policy,
    cwd,
    systemPrompt,
    baseSystemPrompt,
    buildProvider,
    allowProjectPersist: env.SQUAD_PROJECT_PERMS,
    hookRunner: hookRunner as HookRunner,
    yolo,
    allowDeletes: opts.dangerouslyAllowDeletes ?? false,
    recapIdleMinutes,
    notifications: config.notifications,
    fileMentions: preparedRepoMap.fileMentions,
    ...(guardian && { guardian }),
    jobs,
    timers,
    ...(diagnostics && { diagnostics }),
    ...(agentBundle && {
      howl: agentBundle.howl,
      slotRegistry: agentBundle.slotRegistry,
      controllers: agentBundle.controllers,
      setAgentResponder: (responder: PermissionResponder) => {
        agentResponder = responder;
      },
    }),
  };

  if (opts.replay !== undefined) {
    const limit =
      typeof opts.replayLimit === "number" && opts.replayLimit > 0
        ? Math.min(opts.replayLimit, 50)
        : DEFAULT_REPLAY_LIMIT;
    if (typeof opts.replay === "string") {
      const replayId = opts.replay;
      const match = store
        .list({ cwd })
        .find(
          (candidate) =>
            candidate.sessionId === replayId ||
            candidate.sessionId.startsWith(replayId),
        );
      if (!match) {
        process.stderr.write(`no session matching "${replayId}" in ${cwd}\n`);
      } else {
        const { records } = await store.read(match.sessionId);
        process.stdout.write(
          `${formatReplay(recordsToMessages(records), match.sessionId.slice(0, 8), limit)}\n\n`,
        );
      }
    } else {
      process.stdout.write(
        `${formatReplay(session.messages, session.sessionId.slice(0, 8), limit)}\n\n`,
      );
    }
  }

  try {
    if (useSimple) {
      await runSimpleRepl(replOpts);
      return;
    }
    const { runInkRepl } = await import("./repl.js");
    await runInkRepl(replOpts);
  } finally {
    await fireSessionEnd(hookRunner, session.sessionId, cwd);
    await store.shutdown();
  }
}
