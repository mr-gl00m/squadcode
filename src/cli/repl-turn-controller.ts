import { randomUUID } from "node:crypto";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import {
  createContextFragment,
  fragmentToMessage,
} from "../context/fragment.js";
import {
  DEFAULT_TAIL_TURNS,
  findTailStart,
  STRUCTURED_SUMMARIZER_PROMPT,
  shouldAutoCompact,
} from "../engine/auto-compact.js";
import type { JobRegistry } from "../engine/job-registry.js";
import { runAgentLoop } from "../engine/loop.js";
import type { DiagnosticsSetup } from "../engine/post-edit-diagnostics.js";
import { makePreTurnInjector } from "../engine/pre-turn.js";
import {
  type SteeringQueue,
  steeringMessageFragment,
} from "../engine/steering-queue.js";
import type { TimerRegistry } from "../engine/timer-registry.js";
import type { HookRunner } from "../hooks/runner.js";
import { logger } from "../logger.js";
import {
  type NotificationConfig,
  notifyTurnComplete,
} from "../notifications.js";
import { composeSystemPrompt, type OutputStyle } from "../output-styles.js";
import type { PolicyConfig, RuleMap } from "../permissions/policy.js";
import type { PromptOutcome, PromptRequest } from "../permissions/prompt.js";
import {
  calculateCost,
  lookupContextWindow,
  lookupPricing,
  type ModelPricing,
} from "../pricing.js";
import { userPromptMessage } from "../prompts/boundary.js";
import type {
  CanonicalMessage,
  CanonicalToolCall,
  LLMProvider,
} from "../providers/types.js";
import { makeOffloadLargeOutput } from "../sessions/artifacts.js";
import type { SessionStore } from "../sessions/store.js";
import type { TurnDiffTracker } from "../sessions/trajectory-diff.js";
import { sanitizeForTerminal } from "../terminal.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { YoloSession } from "../yolo/index.js";
import { persistEventToStore } from "./persist-event.js";
import { formatElapsed, formatTokenCount } from "./repl-composer.js";
import { formatBytes, formatToolPreview } from "./repl-presentation.js";
import type { ActivityState, HistoryEntry } from "./repl-types.js";
import { AssistantTextReflow } from "./text-reflow.js";

export interface ReplTurnControllerOptions {
  activeStyle: OutputStyle | null;
  allowDeletes: boolean;
  append: (kind: HistoryEntry["kind"], text: string) => void;
  appendAssistantBlock: (block: string) => void;
  askPermission: (req: PromptRequest) => Promise<PromptOutcome>;
  bumpIdle: () => void;
  cwd: string;
  diagnostics?: DiagnosticsSetup;
  hookRunner: HookRunner;
  jobs?: JobRegistry;
  model: string;
  notifications: NotificationConfig;
  providerName: string;
  registry: ToolRegistry;
  sessionId: string;
  store: SessionStore;
  steeringQueue: SteeringQueue;
  timers?: TimerRegistry;
  turnDiff: TurnDiffTracker;
  turnNumber: number;
  updateTodos: () => void;
  isTerminalFocused: () => boolean;
  writeTerminal?: (value: string) => void;
  abortRef: MutableRefObject<AbortController | null>;
  argBytesRef: MutableRefObject<{ id: string; bytes: number } | null>;
  messagesRef: MutableRefObject<CanonicalMessage[]>;
  policyRef: MutableRefObject<PolicyConfig>;
  projectRulesRef: MutableRefObject<RuleMap>;
  providerRef: MutableRefObject<LLMProvider>;
  sessionRulesRef: MutableRefObject<RuleMap>;
  systemPromptRef: MutableRefObject<string>;
  userGlobalRulesRef: MutableRefObject<RuleMap>;
  yoloRef: MutableRefObject<YoloSession | null>;
  setActivity: Dispatch<SetStateAction<ActivityState>>;
  setIsStreaming: Dispatch<SetStateAction<boolean>>;
  setLastTurnCachedTokens: Dispatch<SetStateAction<number>>;
  setLastTurnCost: Dispatch<SetStateAction<number>>;
  setLastTurnInputTokens: Dispatch<SetStateAction<number>>;
  setLastTurnOutputTokens: Dispatch<SetStateAction<number>>;
  setLastTurnTokens: Dispatch<SetStateAction<number>>;
  setStreamingText: Dispatch<SetStateAction<string>>;
  setTotalCachedTokens: Dispatch<SetStateAction<number>>;
  setTotalCost: Dispatch<SetStateAction<number>>;
  setTotalInputTokens: Dispatch<SetStateAction<number>>;
  setTotalOutputTokens: Dispatch<SetStateAction<number>>;
  setTotalTokens: Dispatch<SetStateAction<number>>;
  setTurnCount: Dispatch<SetStateAction<number>>;
}

export function createReplTurnController(opts: ReplTurnControllerOptions): {
  runCompact: () => Promise<void>;
  runUserTurn: (content: string, displayLabel: string) => Promise<void>;
} {
  const runCompact = async (): Promise<void> => {
    const before = opts.messagesRef.current.length;
    if (before === 0) return;
    const tailStart = findTailStart(
      opts.messagesRef.current,
      DEFAULT_TAIL_TURNS,
    );
    const toSummarize = opts.messagesRef.current.slice(0, tailStart);
    const tail = opts.messagesRef.current.slice(tailStart);
    if (toSummarize.length === 0) {
      opts.append(
        "system",
        `nothing to compact (only ${tail.length} message${tail.length === 1 ? "" : "s"} in protected tail)`,
      );
      return;
    }
    opts.setIsStreaming(true);
    opts.setActivity({ kind: "thinking", label: "Compacting" });
    try {
      const response = await opts.providerRef.current.complete({
        model: opts.model,
        system: STRUCTURED_SUMMARIZER_PROMPT,
        messages: [
          ...toSummarize,
          fragmentToMessage(
            createContextFragment({
              source: "repl",
              type: "compaction_request",
              role: "user",
              merge: "append",
              visibility: "model",
              trust: "trusted-system",
              maxBytes: 1_024,
              maxTokens: 256,
              content:
                "Summarize the conversation above using the prescribed structure. Preserve every decision, file path, name, and current state.",
            }),
          ),
        ],
      });
      const summary = response.text.trim() || "(empty summary)";
      opts.messagesRef.current.length = 0;
      opts.messagesRef.current.push({
        role: "assistant",
        content: `[Compacted summary of ${toSummarize.length} earlier message${toSummarize.length === 1 ? "" : "s"}; ${tail.length} recent message${tail.length === 1 ? "" : "s"} preserved]\n\n${summary}`,
      });
      opts.messagesRef.current.push(...tail);
      opts.setTotalTokens((total) => total + response.usage.totalTokens);
      opts.setTotalInputTokens((total) => total + response.usage.inputTokens);
      opts.setTotalOutputTokens((total) => total + response.usage.outputTokens);
      const compactCached = response.usage.cachedInputTokens ?? 0;
      if (compactCached > 0) {
        opts.setTotalCachedTokens((total) => total + compactCached);
      }
      const compactPricing = lookupPricing(opts.providerName, opts.model);
      let compactCost = 0;
      if (compactPricing) {
        compactCost = calculateCost(
          compactPricing,
          response.usage.inputTokens,
          response.usage.outputTokens,
          response.usage.cachedInputTokens,
        );
        opts.setTotalCost((total) => total + compactCost);
      }
      opts.store.recordUsage({
        ts: new Date().toISOString(),
        sessionId: opts.sessionId,
        cwd: opts.cwd,
        provider: opts.providerName,
        model: opts.model,
        inputTokens: response.usage.inputTokens,
        cachedInputTokens: compactCached,
        outputTokens: response.usage.outputTokens,
        totalTokens: response.usage.totalTokens,
        costUsd: compactCost,
        toolCalls: 0,
        slashCommand: "compact",
        source: "compact",
      });
      opts.append(
        "system",
        `compacted ${toSummarize.length} → 1 (+ ${tail.length} preserved; cost: ${formatTokenCount(response.usage.totalTokens)} tokens)`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, "compact failed");
      opts.append("error", `compact failed: ${message}`);
    } finally {
      opts.setIsStreaming(false);
      opts.setActivity({ kind: "idle", label: "" });
    }
  };

  const runUserTurn = async (
    llmContent: string,
    displayLabel: string,
  ): Promise<void> => {
    const turnId = randomUUID();
    opts.turnDiff.reset();
    opts.append("user", displayLabel);
    opts.messagesRef.current.push(userPromptMessage(llmContent));
    await persistUserSubmission(opts, llmContent, turnId);

    const abort = new AbortController();
    opts.abortRef.current = abort;
    opts.setIsStreaming(true);
    opts.setStreamingText("");
    opts.setActivity({ kind: "thinking", label: "Thinking" });

    const turnStart = Date.now();
    let turnOk = true;
    const turnPricing: ModelPricing | null = lookupPricing(
      opts.providerName,
      opts.model,
    );
    let turnCost = 0;
    let turnCachedTokens = 0;
    let turnInputTokens = 0;
    let turnOutputTokens = 0;
    let turnToolCalls = 0;
    const buffers = {
      text: "",
      reasoning: "",
      pendingToolCalls: [] as CanonicalToolCall[],
      turnTokens: 0,
    };

    const reflow = new AssistantTextReflow();
    const effectiveSystemPrompt = composeSystemPrompt(
      opts.activeStyle,
      opts.systemPromptRef.current,
    );
    const injectRuntimeContext = makePreTurnInjector({
      instructionsCwd: opts.cwd,
      ...(opts.timers && { timers: opts.timers }),
      ...(opts.jobs && { jobs: opts.jobs }),
      ...(opts.diagnostics && { diagnostics: opts.diagnostics }),
    });
    try {
      do {
        for await (const ev of runAgentLoop({
          provider: opts.providerRef.current,
          model: opts.model,
          ...(effectiveSystemPrompt !== undefined && {
            systemPrompt: effectiveSystemPrompt,
          }),
          messages: opts.messagesRef.current,
          registry: opts.registry,
          policy: opts.policyRef.current,
          cwd: opts.cwd,
          abort: abort.signal,
          sessionRules: opts.sessionRulesRef.current,
          projectRules: opts.projectRulesRef.current,
          userGlobalRules: opts.userGlobalRulesRef.current,
          askPermission: opts.askPermission,
          offloadLargeOutput: makeOffloadLargeOutput({
            sessionId: opts.sessionId,
          }),
          hookRunner: opts.hookRunner,
          sessionId: opts.sessionId,
          ...(opts.jobs && { jobs: opts.jobs }),
          ...(opts.timers && { timers: opts.timers }),
          ...(opts.diagnostics && {
            diagnostics: opts.diagnostics.tracker,
          }),
          turnDiff: opts.turnDiff,
          injectPreTurn: async () => {
            const steering = opts.steeringQueue.drain();
            for (const message of steering) {
              await persistUserSubmission(opts, message.content, turnId, true);
            }
            return [
              ...(await injectRuntimeContext()),
              ...steering.map(steeringMessageFragment),
            ];
          },
          ...(opts.yoloRef.current && { yolo: opts.yoloRef.current }),
          ...(opts.allowDeletes && { allowDeletes: true }),
        })) {
          await persistEventToStore(
            opts.store,
            opts.sessionId,
            ev,
            buffers,
            turnId,
          );
          switch (ev.type) {
            case "text_delta": {
              const completed = reflow.push(sanitizeForTerminal(ev.text));
              if (completed.length > 0) opts.appendAssistantBlock(completed);
              opts.setStreamingText(reflow.preview());
              opts.setActivity((previous) =>
                previous.kind === "responding"
                  ? previous
                  : { kind: "responding", label: "Responding" },
              );
              break;
            }
            case "reasoning_delta":
              opts.setActivity((previous) =>
                previous.kind === "thinking"
                  ? previous
                  : { kind: "thinking", label: "Thinking" },
              );
              break;
            case "tool_call_delta": {
              const tracked = opts.argBytesRef.current;
              if (tracked && tracked.id === ev.id) {
                tracked.bytes += ev.argsDelta.length;
              } else {
                opts.argBytesRef.current = {
                  id: ev.id,
                  bytes: ev.argsDelta.length,
                };
              }
              const bytes = opts.argBytesRef.current?.bytes ?? 0;
              opts.setActivity((previous) => {
                if (previous.kind !== "tool") return previous;
                const label = `Preparing ${previous.toolName} (${formatBytes(bytes)})`;
                return previous.label === label
                  ? previous
                  : { ...previous, label };
              });
              break;
            }
            case "tool_call_start": {
              const remaining = reflow.flush();
              if (remaining) opts.appendAssistantBlock(remaining);
              opts.setStreamingText("");
              opts.argBytesRef.current = { id: ev.id, bytes: 0 };
              opts.setActivity({
                kind: "tool",
                label: `Preparing ${ev.name}`,
                toolName: ev.name,
              });
              break;
            }
            case "tool_call_done":
              opts.argBytesRef.current = null;
              turnToolCalls += 1;
              opts.setActivity({
                kind: "tool",
                label: `Running ${ev.name}`,
                toolName: ev.name,
              });
              opts.append(
                "tool",
                `[${ev.name}] ${formatToolPreview(ev.name, ev.args)}`,
              );
              break;
            case "tool_result": {
              const tag = ev.ok
                ? "ok"
                : ev.reason === "denied"
                  ? "denied"
                  : ev.reason === "aborted"
                    ? "aborted"
                    : ev.reason === "unknown_tool"
                      ? "unknown"
                      : `failed${ev.error ? ` (${ev.error})` : ""}`;
              opts.append(ev.ok ? "tool" : "error", `[${ev.name}] ${tag}`);
              if (ev.name === "TodoWrite") opts.updateTodos();
              opts.setActivity({ kind: "thinking", label: "Thinking" });
              break;
            }
            case "usage": {
              opts.setTotalTokens((total) => total + ev.usage.totalTokens);
              turnInputTokens += ev.usage.inputTokens;
              turnOutputTokens += ev.usage.outputTokens;
              opts.setTotalInputTokens((total) => total + ev.usage.inputTokens);
              opts.setTotalOutputTokens(
                (total) => total + ev.usage.outputTokens,
              );
              const cached = ev.usage.cachedInputTokens ?? 0;
              if (cached > 0) {
                turnCachedTokens += cached;
                opts.setTotalCachedTokens((total) => total + cached);
              }
              let usageRowCost = 0;
              if (turnPricing) {
                usageRowCost = calculateCost(
                  turnPricing,
                  ev.usage.inputTokens,
                  ev.usage.outputTokens,
                  ev.usage.cachedInputTokens,
                );
                turnCost += usageRowCost;
                opts.setTotalCost((total) => total + usageRowCost);
              }
              opts.store.recordUsage({
                ts: new Date().toISOString(),
                sessionId: opts.sessionId,
                cwd: opts.cwd,
                provider: opts.providerName,
                model: opts.model,
                inputTokens: ev.usage.inputTokens,
                cachedInputTokens: cached,
                outputTokens: ev.usage.outputTokens,
                totalTokens: ev.usage.totalTokens,
                costUsd: usageRowCost,
                toolCalls: turnToolCalls,
                source: "turn",
              });
              break;
            }
            case "error":
              turnOk = false;
              opts.append("error", `${ev.code}: ${ev.message}`);
              opts.setActivity({ kind: "idle", label: "" });
              break;
            case "done": {
              const remaining = reflow.flush();
              if (remaining) opts.appendAssistantBlock(remaining);
              opts.setStreamingText("");
              opts.setActivity({ kind: "idle", label: "" });
              break;
            }
          }
        }
      } while (opts.steeringQueue.hasPending && !abort.signal.aborted);
      try {
        await opts.store.checkpointTurn(opts.sessionId, {
          turnId,
          cwd: opts.cwd,
          label: displayLabel,
          tokenDelta: buffers.turnTokens,
        });
      } catch (err: unknown) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "turn checkpoint failed; falling back to index bump",
        );
        opts.store.bumpUsage(opts.sessionId, 1, buffers.turnTokens);
      }
      opts.setTurnCount((count) => count + 1);
      opts.bumpIdle();
      opts.setLastTurnTokens(buffers.turnTokens);
      opts.setLastTurnCachedTokens(turnCachedTokens);
      opts.setLastTurnInputTokens(turnInputTokens);
      opts.setLastTurnOutputTokens(turnOutputTokens);
      opts.setLastTurnCost(turnCost);
      const contextWindow = lookupContextWindow(opts.providerName, opts.model);
      if (shouldAutoCompact(turnInputTokens, contextWindow)) {
        opts.append(
          "system",
          `auto-compact triggered: ${formatTokenCount(turnInputTokens)} of ${formatTokenCount(contextWindow ?? 0)} context tokens used`,
        );
        await runCompact();
      }
    } catch (err: unknown) {
      turnOk = false;
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, "repl turn failed");
      opts.append("error", `turn failed: ${message}`);
    } finally {
      try {
        await opts.store.flush(opts.sessionId);
      } catch (err: unknown) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "session flush failed",
        );
      }
      opts.setIsStreaming(false);
      opts.setStreamingText("");
      opts.setActivity({ kind: "idle", label: "" });
      opts.abortRef.current = null;
      opts.append(
        "system",
        `• Worked for ${formatElapsed(Date.now() - turnStart)}`,
      );
      void notifyTurnComplete(
        opts.notifications,
        {
          event: "turn_complete",
          sessionId: opts.sessionId,
          cwd: opts.cwd,
          provider: opts.providerName,
          model: opts.model,
          ok: turnOk,
          durationMs: Date.now() - turnStart,
          turn: opts.turnNumber,
        },
        {
          focused: opts.isTerminalFocused(),
          ...(opts.writeTerminal && { writeTerminal: opts.writeTerminal }),
        },
      );
    }
  };

  return { runCompact, runUserTurn };
}

async function persistUserSubmission(
  opts: ReplTurnControllerOptions,
  content: string,
  turnId: string,
  queued = false,
): Promise<void> {
  try {
    await opts.store.appendUserMessage(opts.sessionId, content, turnId);
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      queued
        ? "session append (queued steering) failed"
        : "session append (user) failed",
    );
  }
  try {
    await opts.hookRunner.fire({
      event: "UserPromptSubmit",
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      prompt: content,
    });
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      queued
        ? "queued UserPromptSubmit hook fire failed"
        : "UserPromptSubmit hook fire failed",
    );
  }
}
