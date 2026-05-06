import { createInterface } from "node:readline";
import { runAgentLoop } from "../engine/loop.js";
import type { HookRunner } from "../hooks/runner.js";
import { logger } from "../logger.js";
import type { PolicyConfig, RuleMap } from "../permissions/policy.js";
import {
  loadProjectRules,
  persistProjectRule,
} from "../permissions/project.js";
import {
  promptForPermission,
  type PromptOutcome,
  type PromptRequest,
} from "../permissions/prompt.js";
import type {
  CanonicalEvent,
  CanonicalMessage,
  CanonicalToolCall,
  LLMProvider,
} from "../providers/types.js";
import { makeOffloadLargeOutput } from "../sessions/artifacts.js";
import type { SessionStore } from "../sessions/store.js";
import type { SessionMetadata } from "../sessions/types.js";
import { updateDefaultSelection } from "../settings.js";
import { sanitizeForTerminal } from "../terminal.js";
import { calculateCost, lookupPricing } from "../pricing.js";
import type { ToolRegistry } from "../tools/registry.js";
import { findChecklist, checklistMissingMessage } from "../yolo/checklist.js";
import {
  createYoloSession,
  yoloSystemPromptAddendum,
  type YoloSession,
} from "../yolo/index.js";
import { BANNER, bannerSubtitle } from "./banner.js";
import { createPrintState, renderEvent } from "./print.js";
import { handleSlash, type SlashContext } from "./slash.js";
import { formatUsageReport } from "./usage-format.js";
import { parseUsageArgs } from "./repl.js";

const VERSION = "1.1.0";

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
  resumed: boolean;
  allowProjectPersist: boolean;
  hookRunner: HookRunner;
  yolo: YoloSession | null;
}

export async function runSimpleRepl(opts: SimpleReplOptions): Promise<void> {
  const messages: CanonicalMessage[] = [...opts.messages];
  const sessionRules: RuleMap = new Map();
  const projectRules: RuleMap = opts.allowProjectPersist
    ? await loadProjectRules(opts.cwd)
    : new Map();
  let provider = opts.provider;
  let providerName = sanitizeForTerminal(opts.providerName);
  let model = sanitizeForTerminal(opts.model);
  let turnCount = opts.metadata.turnCount;
  let totalTokens = opts.metadata.totalTokens;
  let yolo: YoloSession | null = opts.yolo;
  let systemPrompt = opts.systemPrompt;
  let policy = opts.policy;
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
      const filter: { sessionId?: string; cwd?: string; sinceIso?: string } = {};
      let scopeLabel: string;
      if (parsed.scope === "session") {
        filter.sessionId = opts.sessionId;
        scopeLabel = `current session (${opts.sessionId.slice(0, 8)})`;
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
          t.description.length > 80 ? `${t.description.slice(0, 77)}...` : t.description;
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
        const here = s.sessionId === opts.sessionId ? " (current)" : "";
        return `  ${id}  ${when}  ${s.provider}/${s.model}  ${s.turnCount} turn${s.turnCount === 1 ? "" : "s"}${here}`;
      });
      return `recent sessions in ${opts.cwd}:\n${lines.join("\n")}`;
    },
    clear: () => {
      messages.length = 0;
      sessionRules.clear();
    },
    yoloStatus: () => {
      if (yolo) {
        return `YOLO is ON. Sandbox=${opts.cwd}. Archive=${yolo.archiveDir}. Checklist=${yolo.checklistPath ?? "(none)"}.`;
      }
      return "YOLO is OFF.";
    },
    toggleYolo: async () => {
      if (yolo) {
        yolo = null;
        systemPrompt = opts.baseSystemPrompt;
        policy = basePolicy;
        return "YOLO disarmed. Permission prompts are back on.";
      }
      const checklist = await findChecklist(opts.cwd);
      if (!checklist) {
        return checklistMissingMessage();
      }
      yolo = createYoloSession({ cwd: opts.cwd, checklistPath: checklist.path });
      const addendum = `${yoloSystemPromptAddendum(yolo)}\n\n## Loaded checklist (${checklist.path})\n${checklist.contents}`;
      systemPrompt = `${opts.baseSystemPrompt}\n\n${addendum}`;
      policy = { ...basePolicy, dangerouslySkipPermissions: true };
      return `YOLO armed. Sandbox=${opts.cwd}. Archive=${yolo.archiveDir}. Checklist=${checklist.path}.`;
    },
  };

  process.stdout.write(`${BANNER}\n${bannerSubtitle(VERSION, providerName, model)}\n`);
  if (opts.resumed) {
    process.stdout.write(
      `(resumed session ${opts.sessionId.slice(0, 8)} with ${messages.length} prior messages)\n`,
    );
  }
  writePrompt();

  const askPermission = async (req: PromptRequest): Promise<PromptOutcome> => {
    const outcome = await promptForPermission(req, {
      allowProjectPersist: opts.allowProjectPersist,
    });
    opts.store.recordPermissionDecision(opts.sessionId, {
      tool: req.toolName,
      callId: req.callId,
      outcome,
    });
    if (outcome === "always-project" && opts.allowProjectPersist) {
      try {
        await persistProjectRule(opts.cwd, req.toolName, req.scopePattern, "allow");
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "failed to persist project permission",
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
      if (result.exit) break;
      writePrompt();
      continue;
    }

    messages.push({ role: "user", content: line });
    await opts.store.appendUserMessage(opts.sessionId, line);
    try {
      await opts.hookRunner.fire({
        event: "UserPromptSubmit",
        sessionId: opts.sessionId,
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
        askPermission,
        offloadLargeOutput: makeOffloadLargeOutput({ sessionId: opts.sessionId }),
        hookRunner: opts.hookRunner,
        sessionId: opts.sessionId,
        ...(yolo && { yolo }),
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
            sessionId: opts.sessionId,
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
        await persistEventToStore(opts.store, opts.sessionId, ev, buffers);
      }
      opts.store.bumpUsage(opts.sessionId, 1, buffers.turnTokens);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "repl turn failed");
      process.stderr.write(`turn failed: ${sanitizeForTerminal(msg)}\n`);
    } finally {
      process.off("SIGINT", onSigint);
      await opts.store.flush(opts.sessionId);
    }
    turnCount += 1;
    writePrompt();
  }

  rl.close();
}

function persistDefaultSelection(providerName: string, model: string): void {
  updateDefaultSelection(providerName, model).catch((err: unknown) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "default model selection persist failed",
    );
  });
}

async function persistEventToStore(
  store: SessionStore,
  sessionId: string,
  ev: CanonicalEvent,
  buffers: {
    text: string;
    reasoning: string;
    pendingToolCalls: CanonicalToolCall[];
    turnTokens: number;
  },
): Promise<void> {
  switch (ev.type) {
    case "text_delta":
      buffers.text += ev.text;
      return;
    case "reasoning_delta":
      buffers.reasoning += ev.text;
      return;
    case "tool_call_done":
      buffers.pendingToolCalls.push({
        id: ev.id,
        name: ev.name,
        args: ev.args,
      });
      await store.appendToolCall(sessionId, {
        callId: ev.id,
        toolName: ev.name,
        args: ev.args,
      });
      return;
    case "done": {
      if (
        buffers.text.length > 0 ||
        buffers.reasoning.length > 0 ||
        buffers.pendingToolCalls.length > 0
      ) {
        const payload: Parameters<SessionStore["appendAssistantMessage"]>[1] = {
          content: buffers.text,
        };
        if (buffers.pendingToolCalls.length > 0) {
          payload.toolCalls = buffers.pendingToolCalls;
        }
        if (buffers.reasoning.length > 0) {
          payload.reasoningContent = buffers.reasoning;
        }
        await store.appendAssistantMessage(sessionId, payload);
      }
      buffers.text = "";
      buffers.reasoning = "";
      buffers.pendingToolCalls = [];
      return;
    }
    case "tool_result": {
      await store.appendToolResult(sessionId, {
        callId: ev.id,
        toolName: ev.name,
        ok: ev.ok,
        reason: ev.reason ?? "executed",
        content: ev.content,
        contentTruncated: false,
        ...(ev.error !== undefined && { error: ev.error }),
        ...(ev.artifact && { artifact: ev.artifact }),
      });
      return;
    }
    case "usage":
      buffers.turnTokens += ev.usage.totalTokens;
      return;
    case "tool_call_start":
    case "tool_call_delta":
    case "error":
      return;
  }
}
