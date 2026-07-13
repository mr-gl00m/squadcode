import {
  type ContextFragment,
  ContextFragmentAccumulator,
} from "../context/fragment.js";
import type { HookRunner } from "../hooks/runner.js";
import { hookResultsFragment } from "../hooks/runner.js";
import { logger } from "../logger.js";
import { deriveScopePatterns } from "../permissions/match.js";
import {
  appendRule,
  decideAction,
  type PolicyConfig,
  type RuleMap,
  sensitiveLayer,
} from "../permissions/policy.js";
import {
  type PromptOutcome,
  type PromptRequest,
  promptForPermission,
} from "../permissions/prompt.js";
import { toolOutputMessage } from "../prompts/boundary.js";
import type {
  CanonicalEvent,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalToolCall,
  LLMProvider,
} from "../providers/types.js";
import type { TurnDiffTracker } from "../sessions/trajectory-diff.js";
import type { ArtifactRef } from "../sessions/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PreviewResult, ToolResult } from "../tools/types.js";
import type { YoloSession } from "../yolo/index.js";
import type { JobRegistry } from "./job-registry.js";
import type { DiagnosticsTracker } from "./post-edit-diagnostics.js";
import { runTurnWithRetry } from "./stream.js";
import type { TimerRegistry } from "./timer-registry.js";

export type AskPermissionFn = (req: PromptRequest) => Promise<PromptOutcome>;

export type OffloadLargeOutputFn = (args: {
  callId: string;
  toolName: string;
  toolArgs: unknown;
  content: string;
}) => Promise<{ content: string; artifact: ArtifactRef } | null>;

export interface AgentLoopOptions {
  provider: LLMProvider;
  model: string;
  systemPrompt?: string;
  messages: CanonicalMessage[];
  registry: ToolRegistry;
  policy: PolicyConfig;
  cwd: string;
  abort: AbortSignal;
  maxTurns?: number;
  sessionRules?: RuleMap;
  projectRules?: RuleMap;
  userGlobalRules?: RuleMap;
  askPermission?: AskPermissionFn;
  offloadLargeOutput?: OffloadLargeOutputFn;
  hookRunner?: HookRunner;
  sessionId?: string;
  yolo?: YoloSession;
  // Bypasses the Shell tool's always-on delete guard (user-set
  // --dangerously-allow-deletes). Threaded into ToolContext for execute().
  allowDeletes?: boolean;
  // Long-running registries threaded into ToolContext so the Shell background
  // mode and the job/timer tools can reach them. A subagent passes its own pair.
  jobs?: JobRegistry;
  timers?: TimerRegistry;
  // Post-edit diagnostics tracker threaded into ToolContext so mutating file
  // tools can record touched paths; the pre-turn injector drains it.
  diagnostics?: DiagnosticsTracker;
  // Receives committed Write/Edit/ApplyPatch mutations for the current user
  // turn. Rendering uses these snapshots and never rereads the filesystem.
  turnDiff?: TurnDiffTracker;
  // Called at the top of each turn; any messages it returns are appended to the
  // conversation before the request is built. This is the seam for pre-turn
  // synthetic injection — expired timers ("timer fired"), finished background
  // jobs, and post-edit diagnostics — without the loop itself depending on
  // those registries. Returning [] (the common case) is a no-op. May be async
  // (diagnostics parse files); sync injectors still work.
  injectPreTurn?: () => ContextFragment[] | Promise<ContextFragment[]>;
}

const DEFAULT_MAX_TURNS = 25;

// Repeated-call guard. If the same tool call (name + canonicalized args) shows
// up on this many consecutive turns *with no fresh tool calls mixed in*, the
// model is genuinely thrashing on the same operation — bail out rather than
// burn the rest of maxTurns. A turn that introduces a signature we haven't
// seen before is progress and resets all streaks; this lets local models do
// "explore → re-glob → read more → re-glob" without false-positive aborts,
// while still catching "same call emitted turn after turn" with nothing else.
const REPEATED_CALL_STREAK = 3;

// Consecutive-failure guard. Independent from the repeated-call signal: counts
// tool calls that DISPATCHED (executed or unknown-tool) and FAILED. User
// denials and aborts don't count — those are deliberate intent, not a stuck
// model. Warn-only at the lower threshold leaves a structured marker in the
// log for vetting analysis; halt at the upper threshold ends the loop with
// REPEATED_TOOL_FAILURES so the harness records the failure mode rather than
// burn the rest of maxTurns. Ported from DeepSeek-TUI loop_guard.rs.
const CONSECUTIVE_FAILURE_WARN = 3;
const CONSECUTIVE_FAILURE_HALT = 8;

export async function* runAgentLoop(
  opts: AgentLoopOptions,
): AsyncIterable<CanonicalEvent> {
  const messages = opts.messages;
  const sessionRules: RuleMap = opts.sessionRules ?? new Map();
  const projectRules: RuleMap = opts.projectRules ?? new Map();
  const userGlobalRules: RuleMap = opts.userGlobalRules ?? new Map();
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const fragmentAccumulator = new ContextFragmentAccumulator();
  const callStreaks = new Map<string, number>();
  let consecutiveFailures = 0;
  let consecutiveFailuresWarned = false;

  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (opts.abort.aborted) return;

    // Pre-turn synthetic injection: fired timers, finished background jobs,
    // and post-edit diagnostics become messages the model sees before it acts
    // this turn. No-op when nothing is pending.
    if (opts.injectPreTurn) {
      fragmentAccumulator.apply(messages, await opts.injectPreTurn());
    }

    const req: CanonicalRequest = {
      model: opts.model,
      messages,
      tools: opts.registry.toCanonicalSpecs(),
    };
    if (opts.systemPrompt) req.system = opts.systemPrompt;

    const pendingCalls: CanonicalToolCall[] = [];
    let assistantText = "";
    let assistantReasoning = "";
    let errored = false;

    for await (const ev of runTurnWithRetry(opts.provider, req, {
      signal: opts.abort,
    })) {
      if (ev.type === "text_delta") assistantText += ev.text;
      if (ev.type === "reasoning_delta") assistantReasoning += ev.text;
      if (ev.type === "tool_call_done") {
        pendingCalls.push({ id: ev.id, name: ev.name, args: ev.args });
      }
      if (ev.type === "error") errored = true;
      yield ev;
    }

    if (errored) return;

    if (assistantText || pendingCalls.length > 0 || assistantReasoning) {
      const msg: CanonicalMessage = {
        role: "assistant",
        content: assistantText,
      };
      if (pendingCalls.length > 0) msg.toolCalls = pendingCalls;
      if (assistantReasoning) msg.reasoningContent = assistantReasoning;
      messages.push(msg);
    }

    if (pendingCalls.length === 0) {
      logger.debug({ turn }, "agent loop ended");
      return;
    }

    const turnSigs = new Set<string>();
    for (const call of pendingCalls) turnSigs.add(callSignature(call));
    let hasFreshSig = false;
    for (const sig of turnSigs) {
      if (!callStreaks.has(sig)) {
        hasFreshSig = true;
        break;
      }
    }
    let thrashSig: string | null = null;
    let thrashStreak = 0;
    if (hasFreshSig) {
      callStreaks.clear();
      for (const sig of turnSigs) callStreaks.set(sig, 1);
    } else {
      for (const sig of turnSigs) {
        const next = (callStreaks.get(sig) ?? 0) + 1;
        callStreaks.set(sig, next);
        if (next > thrashStreak) {
          thrashStreak = next;
          thrashSig = sig;
        }
      }
      for (const sig of [...callStreaks.keys()]) {
        if (!turnSigs.has(sig)) callStreaks.delete(sig);
      }
    }
    if (thrashStreak >= REPEATED_CALL_STREAK) {
      logger.warn(
        { turn, streak: thrashStreak, signature: thrashSig },
        "agent loop repeated tool call",
      );
      // Conversation invariant: every assistant message with tool_calls must
      // be followed by tool messages on each tool_call_id. We pushed the
      // assistant message above; if we return now without running these
      // calls, the next provider request from the REPL ("Continue ...")
      // fails with the OpenAI-style alignment error. Stub them out.
      satisfyUnfulfilledCalls(messages, pendingCalls, "REPEATED_TOOL_CALLS");
      yield {
        type: "error",
        code: "REPEATED_TOOL_CALLS",
        message: `aborted: same tool call emitted on ${thrashStreak} consecutive turns; model appears stuck`,
        retryable: false,
      };
      return;
    }

    const hookFragments: ContextFragment[] = [];
    let callIndex = 0;
    for (; callIndex < pendingCalls.length; callIndex += 1) {
      if (opts.abort.aborted) break;
      const call = pendingCalls[callIndex]!;
      if (opts.hookRunner && opts.sessionId) {
        try {
          const hookContext = {
            event: "PreToolUse",
            sessionId: opts.sessionId,
            cwd: opts.cwd,
            toolName: call.name,
            args: call.args,
            callId: call.id,
          } as const;
          const hookResults = await opts.hookRunner.fire(hookContext);
          const hookFragment = hookResultsFragment(hookResults, hookContext);
          if (hookFragment) {
            hookFragments.push(hookFragment);
          }
        } catch (err: unknown) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "PreToolUse hook fire failed",
          );
        }
      }
      const { result, reason } = await runOneToolCall(
        call,
        opts,
        sessionRules,
        projectRules,
        userGlobalRules,
      );
      if (result.mutations) opts.turnDiff?.record(result.mutations);
      if (opts.hookRunner && opts.sessionId) {
        try {
          const hookContext = {
            event: result.ok ? "PostToolUse" : "PostToolUseFailure",
            sessionId: opts.sessionId,
            cwd: opts.cwd,
            toolName: call.name,
            args: call.args,
            callId: call.id,
            ok: result.ok,
            ...(result.error !== undefined && { error: result.error }),
          } as const;
          const hookResults = await opts.hookRunner.fire(hookContext);
          const hookFragment = hookResultsFragment(hookResults, hookContext);
          if (hookFragment) {
            hookFragments.push(hookFragment);
          }
        } catch (err: unknown) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "PostToolUse hook fire failed",
          );
        }
      }
      let bodyContent = result.content;
      let artifact: ArtifactRef | undefined;
      if (opts.offloadLargeOutput && result.ok) {
        try {
          const off = await opts.offloadLargeOutput({
            callId: call.id,
            toolName: call.name,
            toolArgs: call.args,
            content: result.content,
          });
          if (off) {
            bodyContent = off.content;
            artifact = off.artifact;
          }
        } catch (err: unknown) {
          logger.warn(
            {
              tool: call.name,
              callId: call.id,
              err: err instanceof Error ? err.message : String(err),
            },
            "offload large output hook failed; using inline content",
          );
        }
      }
      const attrs: { ok: boolean; error?: string } = { ok: result.ok };
      if (result.error !== undefined) attrs.error = result.error;
      const toolMessage = toolOutputMessage({
        name: call.name,
        body: bodyContent,
        ok: attrs.ok,
        ...(attrs.error !== undefined && { error: attrs.error }),
        callId: call.id,
      });
      const wrappedContent = toolMessage.content;
      messages.push(toolMessage);
      const resultEvent: CanonicalEvent = {
        type: "tool_result",
        id: call.id,
        name: call.name,
        ok: result.ok,
        reason,
        content: wrappedContent,
      };
      if (result.error !== undefined) resultEvent.error = result.error;
      if (artifact) resultEvent.artifact = artifact;
      yield resultEvent;

      // Consecutive-failure guard. See comment block at top.
      const countsAsFailure =
        !result.ok && (reason === "executed" || reason === "unknown_tool");
      if (result.ok || reason === "denied") {
        consecutiveFailures = 0;
        consecutiveFailuresWarned = false;
      } else if (countsAsFailure) {
        consecutiveFailures += 1;
        if (
          consecutiveFailures >= CONSECUTIVE_FAILURE_WARN &&
          !consecutiveFailuresWarned
        ) {
          logger.warn(
            { turn, consecutiveFailures, tool: call.name, callId: call.id },
            "agent loop tool-failure streak crossed warn threshold",
          );
          consecutiveFailuresWarned = true;
        }
        if (consecutiveFailures >= CONSECUTIVE_FAILURE_HALT) {
          logger.warn(
            { turn, consecutiveFailures, tool: call.name },
            "agent loop tool-failure streak hit halt threshold",
          );
          // Same conversation invariant as the repeated-call halt above.
          satisfyUnfulfilledCalls(
            messages,
            pendingCalls.slice(callIndex + 1),
            "REPEATED_TOOL_FAILURES",
          );
          fragmentAccumulator.apply(messages, hookFragments);
          yield {
            type: "error",
            code: "REPEATED_TOOL_FAILURES",
            message: `aborted: ${consecutiveFailures} consecutive tool failures; model not recovering`,
            retryable: false,
          };
          return;
        }
      }
    }
    if (callIndex < pendingCalls.length) {
      // Aborted mid-tool-execution. Same invariant as above — fill in the
      // remaining unsatisfied calls so the next request stays valid.
      satisfyUnfulfilledCalls(
        messages,
        pendingCalls.slice(callIndex),
        "ABORTED",
      );
      fragmentAccumulator.apply(messages, hookFragments);
      return;
    }
    fragmentAccumulator.apply(messages, hookFragments);
  }

  logger.warn({ maxTurns }, "agent loop hit max_turns");
  yield {
    type: "error",
    code: "MAX_TURNS",
    message: `hit max_turns=${maxTurns} without resolution`,
    retryable: false,
  };
}

type ToolResultReason = "denied" | "executed" | "unknown_tool" | "aborted";

async function runOneToolCall(
  call: CanonicalToolCall,
  opts: AgentLoopOptions,
  sessionRules: RuleMap,
  projectRules: RuleMap,
  userGlobalRules: RuleMap,
): Promise<{ result: ToolResult; reason: ToolResultReason }> {
  const tool = opts.registry.get(call.name);
  if (!tool) {
    return {
      result: {
        ok: false,
        content: `unknown tool: ${call.name}`,
        error: "UNKNOWN_TOOL",
      },
      reason: "unknown_tool",
    };
  }

  // Precedence stack, highest first: sensitive defaults (the un-overridable
  // floor) > this-session [A] grants > project [P] rules > user-global [U]
  // rules > cli --allowed/--disallowed. decideAction stops at the first layer
  // that matches; deny wins within a layer.
  const effectivePolicy: PolicyConfig = {
    ...opts.policy,
    layers: [
      sensitiveLayer(),
      sessionRules,
      projectRules,
      userGlobalRules,
      opts.policy.rules,
    ],
  };
  const action = decideAction(
    tool.name,
    tool.defaultPermission,
    call.args,
    effectivePolicy,
  );
  const scopePatterns = deriveScopePatterns(tool.name, call.args);
  const scopePattern = scopePatterns[0] ?? "*";

  let allowed: boolean;
  let executeMetadata: unknown;
  if (action === "deny") {
    allowed = false;
  } else if (action === "allow") {
    allowed = true;
  } else {
    let preview: PreviewResult | null = null;
    if (tool.preview) {
      try {
        preview = await tool.preview(call.args, {
          cwd: opts.cwd,
          signal: opts.abort,
          callId: call.id,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { tool: tool.name, callId: call.id, err: msg },
          "tool preview failed; falling back to JSON args",
        );
      }
    }
    const askFn = opts.askPermission ?? promptForPermission;
    const outcome = await askFn({
      toolName: tool.name,
      callId: call.id,
      argsPreview: preview?.display ?? previewArgs(call.args),
      scopePattern,
      scopePatterns,
    });
    if (preview) executeMetadata = preview.metadata;
    if (outcome === "always-allow") {
      appendAllowRules(sessionRules, tool.name, scopePatterns);
      allowed = true;
    } else if (outcome === "always-project") {
      appendAllowRules(projectRules, tool.name, scopePatterns);
      allowed = true;
    } else if (outcome === "always-user") {
      appendAllowRules(userGlobalRules, tool.name, scopePatterns);
      allowed = true;
    } else {
      allowed = outcome === "allow";
    }
  }

  if (!allowed) {
    logger.info(
      { tool: tool.name, callId: call.id, action },
      "permission denied",
    );
    return {
      result: {
        ok: false,
        content: `permission denied for tool ${tool.name}`,
        error: "PERMISSION_DENIED",
      },
      reason: "denied",
    };
  }

  try {
    const result = await tool.execute(
      call.args,
      {
        cwd: opts.cwd,
        signal: opts.abort,
        callId: call.id,
        ...(opts.yolo && { yolo: opts.yolo }),
        ...(opts.allowDeletes && { allowDeletes: true }),
        ...(opts.jobs && { jobs: opts.jobs }),
        ...(opts.timers && { timers: opts.timers }),
        ...(opts.diagnostics && { diagnostics: opts.diagnostics }),
      },
      executeMetadata,
    );
    return { result, reason: "executed" };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { tool: tool.name, callId: call.id, err: message },
      "tool error",
    );
    const aborted = opts.abort.aborted;
    return {
      result: {
        ok: false,
        content: message,
        error: aborted ? "ABORTED" : "TOOL_ERROR",
      },
      reason: aborted ? "aborted" : "executed",
    };
  }
}

function appendAllowRules(
  rules: RuleMap,
  toolName: string,
  scopePatterns: string[],
): void {
  for (const pattern of scopePatterns) {
    appendRule(rules, toolName, { pattern, action: "allow" });
  }
}

function satisfyUnfulfilledCalls(
  messages: CanonicalMessage[],
  calls: CanonicalToolCall[],
  errorCode: "REPEATED_TOOL_CALLS" | "REPEATED_TOOL_FAILURES" | "ABORTED",
): void {
  const body =
    errorCode === "REPEATED_TOOL_CALLS"
      ? "tool call not executed: agent loop aborted (repeated identical tool calls)"
      : errorCode === "REPEATED_TOOL_FAILURES"
        ? "tool call not executed: agent loop aborted (consecutive tool failures)"
        : "tool call not executed: agent loop aborted";
  for (const call of calls) {
    messages.push(
      toolOutputMessage({
        name: call.name,
        body,
        ok: false,
        error: errorCode,
        callId: call.id,
      }),
    );
  }
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`)
    .join(",")}}`;
}

function callSignature(call: CanonicalToolCall): string {
  return `${call.name} ${canonicalStringify(call.args)}`;
}

function previewArgs(args: unknown): string {
  try {
    const json = JSON.stringify(args, null, 2);
    if (json.length > 800) return `${json.slice(0, 800)}\n... (truncated)`;
    return json;
  } catch {
    return String(args);
  }
}
