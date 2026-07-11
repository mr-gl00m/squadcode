import { builtInAgentDefs } from "../agents/built-in/index.js";
import { loadAgentDefs } from "../agents/loader.js";
import { loadConfigurationStack } from "../config/stack.js";
import { createJobRegistry } from "../engine/job-registry.js";
import { runAgentLoop } from "../engine/loop.js";
import { setupPostEditDiagnostics } from "../engine/post-edit-diagnostics.js";
import { makePreTurnInjector } from "../engine/pre-turn.js";
import { createTimerRegistry } from "../engine/timer-registry.js";
import { guardianYoloAdvice, guardPermissionRequest } from "../guardian.js";
import { logger } from "../logger.js";
import { notifyTurnComplete } from "../notifications.js";
import { applyModeAddendums } from "../permissions/plan.js";
import { buildPolicyFromCli } from "../permissions/policy.js";
import { persistProjectRule } from "../permissions/project.js";
import {
  type PromptOutcome,
  type PromptRequest,
  promptForPermission,
} from "../permissions/prompt.js";
import { calculateCost, lookupPricing } from "../pricing.js";
import { userPromptMessage } from "../prompts/boundary.js";
import { makeEnvFromProcess } from "../providers/dispatch.js";
import { makeOffloadLargeOutput } from "../sessions/artifacts.js";
import { openSessionStore, type SessionStore } from "../sessions/store.js";
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
  fireUserPromptSubmit,
} from "./hook-lifecycle.js";
import { createPrintState, renderEvent } from "./print.js";
import { type PrintTurnBuffers, persistEvent } from "./print-persistence.js";
import type { RootOptions } from "./program-options.js";
import { runtimeCliConfig } from "./program-options.js";
import { ensureProjectTrust, projectDefaultMode } from "./project-trust.js";
import {
  buildAgentBundle,
  buildPermissionGuardian,
  buildProviderForModel,
  createDeferredAgentHost,
  parseMode,
  permissionModeConflict,
  resolveSession,
} from "./runtime-resolution.js";
import { createStreamJsonRenderer } from "./stream-json.js";
import {
  loadOutputSchema,
  validateStructuredOutput,
  writeLastMessage,
} from "./structured-output.js";
import { defaultSystemPrompt, prepareRepoMap } from "./system-prompt.js";

export async function runPrintMode(opts: RootOptions): Promise<void> {
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
  const projectTrusted = await ensureProjectTrust(cwd, config.settings, {
    interactive: false,
  });
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
  const prompt = opts.print ?? "";
  const manifest = loadManifest(cwd);
  const { fragment: repoMap } = await prepareRepoMap(cwd, manifest !== null);
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
    if (guardianAdvice) process.stderr.write(`[advisory] ${guardianAdvice}\n`);
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
  const outputFormat = opts.outputFormat ?? "text";
  if (outputFormat !== "text" && outputFormat !== "stream-json") {
    process.stderr.write(
      `--output-format must be "text" or "stream-json" (got "${opts.outputFormat}")\n`,
    );
    process.exitCode = 2;
    return;
  }
  const streamJson =
    outputFormat === "stream-json"
      ? createStreamJsonRenderer((line) => process.stdout.write(line))
      : null;
  let outputSchema: Awaited<ReturnType<typeof loadOutputSchema>> | null = null;
  if (opts.outputSchema) {
    try {
      outputSchema = await loadOutputSchema(opts.outputSchema, cwd);
    } catch (err: unknown) {
      process.stderr.write(
        `--output-schema: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 2;
      return;
    }
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

  const abort = new AbortController();
  const onSigint = (): void => {
    process.stderr.write("\nreceived SIGINT, aborting...\n");
    abort.abort();
  };
  process.on("SIGINT", onSigint);

  logger.info(
    {
      provider: provider.name,
      model,
      sessionId: session.sessionId,
      resumed: session.resumed,
      promptChars: prompt.length,
    },
    "print-mode turn",
  );

  const projectRules = env.SQUAD_PROJECT_PERMS
    ? config.projectRules
    : new Map();
  const userGlobalRules = config.userGlobalRules;
  const askPermission = async (req: PromptRequest): Promise<PromptOutcome> => {
    const guardedReq = await guardPermissionRequest(guardian ?? undefined, req);
    return await onAskPermission(store, session.sessionId, guardedReq, {
      cwd,
      allowProjectPersist: env.SQUAD_PROJECT_PERMS,
    });
  };

  const jobs = createJobRegistry();
  const timers = createTimerRegistry();
  const diagnostics = await setupPostEditDiagnostics(cwd);

  if (deferredHost) {
    const bundle = buildAgentBundle({
      agentDefs,
      catalog,
      dispatchEnv,
      cwd,
      parentAbort: abort.signal,
      providerName,
      model,
      policy,
      responder: (envelope) => askPermission(envelope.request),
      ...(userGlobalRules.size > 0 && { userGlobalRules }),
      parentJobs: jobs,
      ...(opts.yolo && { yolo: true }),
    });
    bundle.setBaseRegistry(registry);
    deferredHost.install(bundle.host.spawn);
  }

  const state = createPrintState();
  streamJson?.init({
    sessionId: session.sessionId,
    provider: providerName,
    model,
    cwd,
    mode,
    resumed: session.resumed,
  });
  const messages = [...session.messages, userPromptMessage(prompt)];
  await store.appendUserMessage(session.sessionId, prompt);
  await fireUserPromptSubmit(hookRunner, session.sessionId, cwd, prompt);

  const buffers: PrintTurnBuffers = {
    text: "",
    reasoning: "",
    pendingToolCalls: [],
    turnTokens: 0,
    toolCalls: 0,
  };
  const basePrintSystemPrompt = applyModeAddendums(
    defaultSystemPrompt(registry),
    {
      yolo: yolo ? yoloPromptAddendum : null,
      plan: policy.mode === "plan",
    },
  );
  const printSystemPrompt = outputSchema
    ? `${basePrintSystemPrompt}\n\n${outputSchema.instruction}`
    : basePrintSystemPrompt;

  const turnStartedAt = Date.now();
  let turnOk = true;
  try {
    for await (const ev of runAgentLoop({
      provider,
      model,
      systemPrompt: printSystemPrompt,
      messages,
      registry,
      policy,
      cwd,
      abort: abort.signal,
      projectRules,
      userGlobalRules,
      askPermission,
      offloadLargeOutput: makeOffloadLargeOutput({
        sessionId: session.sessionId,
      }),
      hookRunner,
      sessionId: session.sessionId,
      jobs,
      timers,
      ...(diagnostics && { diagnostics: diagnostics.tracker }),
      injectPreTurn: makePreTurnInjector({
        instructionsCwd: cwd,
        timers,
        jobs,
        ...(diagnostics && { diagnostics }),
      }),
      ...(yolo && { yolo }),
      ...(opts.dangerouslyAllowDeletes && { allowDeletes: true }),
    })) {
      if (ev.type === "error") turnOk = false;
      if (streamJson) streamJson.event(ev);
      else renderEvent(ev, state);
      await persistEvent({ store, sessionId: session.sessionId, ev, buffers });
    }
    store.bumpUsage(session.sessionId, 1, buffers.turnTokens);
    let turnCost = 0;
    if (buffers.lastUsage) {
      const pricing = lookupPricing(providerName, model);
      turnCost = pricing
        ? calculateCost(
            pricing,
            buffers.lastUsage.inputTokens,
            buffers.lastUsage.outputTokens,
            buffers.lastUsage.cachedInputTokens,
          )
        : 0;
      store.recordUsage({
        ts: new Date().toISOString(),
        sessionId: session.sessionId,
        cwd,
        provider: providerName,
        model,
        inputTokens: buffers.lastUsage.inputTokens,
        cachedInputTokens: buffers.lastUsage.cachedInputTokens ?? 0,
        outputTokens: buffers.lastUsage.outputTokens,
        totalTokens: buffers.lastUsage.totalTokens,
        costUsd: turnCost,
        toolCalls: buffers.toolCalls,
        source: "turn",
      });
    }
    const lastMessage = buffers.lastAssistantText ?? "";
    if (opts.outputLastMessage) {
      await writeLastMessage(opts.outputLastMessage, cwd, lastMessage);
    }
    if (outputSchema) {
      try {
        validateStructuredOutput(lastMessage, outputSchema);
      } catch (err: unknown) {
        turnOk = false;
        state.exitCode = 1;
        if (streamJson) streamJson.state.exitCode = 1;
        process.stderr.write(
          `structured output error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    streamJson?.result({
      sessionId: session.sessionId,
      provider: providerName,
      model,
      usage: buffers.lastUsage ?? {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      costUsd: turnCost,
      toolCalls: buffers.toolCalls,
      exitCode: streamJson.state.exitCode,
    });
  } catch (err: unknown) {
    turnOk = false;
    throw err;
  } finally {
    await notifyTurnComplete(
      config.notifications,
      {
        event: "turn_complete",
        sessionId: session.sessionId,
        cwd,
        provider: providerName,
        model,
        ok: turnOk,
        durationMs: Date.now() - turnStartedAt,
        turn: session.metadata.turnCount + 1,
      },
      {
        focused: process.stdout.isTTY === true,
        ...(process.stdout.isTTY === true && {
          writeTerminal: (value: string) => process.stdout.write(value),
        }),
      },
    );
    await fireSessionEnd(hookRunner, session.sessionId, cwd);
    process.off("SIGINT", onSigint);
    await store.flush(session.sessionId);
    await store.shutdown();
  }

  const exitCode = streamJson ? streamJson.state.exitCode : state.exitCode;
  if (exitCode !== 0) process.exitCode = exitCode;
}

async function onAskPermission(
  store: SessionStore,
  sessionId: string,
  req: PromptRequest,
  ctx: { cwd: string; allowProjectPersist: boolean },
): Promise<PromptOutcome> {
  const outcome = await promptForPermission(req, {
    allowProjectPersist: ctx.allowProjectPersist,
  });
  store.recordPermissionDecision(sessionId, {
    tool: req.toolName,
    callId: req.callId,
    outcome,
  });
  if (outcome === "always-project" && ctx.allowProjectPersist) {
    try {
      for (const pattern of req.scopePatterns) {
        await persistProjectRule(ctx.cwd, req.toolName, pattern, "allow");
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "failed to persist project permission",
      );
    }
  }
  return outcome;
}
