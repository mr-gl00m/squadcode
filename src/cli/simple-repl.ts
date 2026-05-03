import { createInterface } from "node:readline";
import { runAgentLoop } from "../engine/loop.js";
import { logger } from "../logger.js";
import type { PolicyConfig } from "../permissions/policy.js";
import {
  loadProjectAllow,
  persistProjectAllow,
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
import type { SessionStore } from "../sessions/store.js";
import type { SessionMetadata } from "../sessions/types.js";
import { updateDefaultSelection } from "../settings.js";
import { sanitizeForTerminal } from "../terminal.js";
import type { ToolRegistry } from "../tools/registry.js";
import { BANNER, bannerSubtitle } from "./banner.js";
import { createPrintState, renderEvent } from "./print.js";
import { handleSlash, type SlashContext } from "./slash.js";

const VERSION = "1.0.0";

export interface SimpleReplOptions {
  provider: LLMProvider;
  providerName: string;
  model: string;
  registry: ToolRegistry;
  policy: PolicyConfig;
  cwd: string;
  systemPrompt: string;
  buildProvider: (name: string) => LLMProvider | string;
  store: SessionStore;
  sessionId: string;
  metadata: SessionMetadata;
  messages: CanonicalMessage[];
  resumed: boolean;
  allowProjectPersist: boolean;
}

export async function runSimpleRepl(opts: SimpleReplOptions): Promise<void> {
  const messages: CanonicalMessage[] = [...opts.messages];
  const sessionAllow = new Set<string>();
  const projectAllow = opts.allowProjectPersist
    ? await loadProjectAllow(opts.cwd)
    : new Set<string>();
  let provider = opts.provider;
  let providerName = sanitizeForTerminal(opts.providerName);
  let model = sanitizeForTerminal(opts.model);
  let turnCount = opts.metadata.turnCount;
  let totalTokens = opts.metadata.totalTokens;

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
    costSummary: () => {
      const lines = [
        `provider/model:  ${providerName}/${model}`,
        `turns:           ${turnCount}`,
        `tokens (total):  ${totalTokens.toLocaleString()}`,
        `cost:            (not tracked in fallback REPL)`,
      ];
      return lines.join("\n");
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
      sessionAllow.clear();
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
        await persistProjectAllow(opts.cwd, req.toolName);
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
      if (result.exit) break;
      writePrompt();
      continue;
    }

    messages.push({ role: "user", content: line });
    await opts.store.appendUserMessage(opts.sessionId, line);

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

    const state = createPrintState();
    try {
      for await (const ev of runAgentLoop({
        provider,
        model,
        systemPrompt: opts.systemPrompt,
        messages,
        registry: opts.registry,
        policy: opts.policy,
        cwd: opts.cwd,
        abort: abort.signal,
        sessionAllow,
        projectAllow,
        askPermission,
      })) {
        if (ev.type === "usage") totalTokens += ev.usage.totalTokens;
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
