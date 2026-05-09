import { logger } from "../logger.js";
import { deriveScopePattern } from "../permissions/match.js";
import {
  appendRule,
  decideAction,
  mergeRules,
  type PolicyConfig,
  type RuleMap,
} from "../permissions/policy.js";
import {
  promptForPermission,
  type PromptOutcome,
  type PromptRequest,
} from "../permissions/prompt.js";
import type {
  CanonicalEvent,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalToolCall,
  LLMProvider,
} from "../providers/types.js";
import type { HookRunner } from "../hooks/runner.js";
import type { ArtifactRef } from "../sessions/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PreviewResult, ToolResult } from "../tools/types.js";
import type { YoloSession } from "../yolo/index.js";
import { runTurn } from "./stream.js";

export type AskPermissionFn = (req: PromptRequest) => Promise<PromptOutcome>;

export type OffloadLargeOutputFn = (args: {
  callId: string;
  toolName: string;
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
  askPermission?: AskPermissionFn;
  offloadLargeOutput?: OffloadLargeOutputFn;
  hookRunner?: HookRunner;
  sessionId?: string;
  yolo?: YoloSession;
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
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const callStreaks = new Map<string, number>();
  let consecutiveFailures = 0;
  let consecutiveFailuresWarned = false;

  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (opts.abort.aborted) return;

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

    for await (const ev of runTurn(opts.provider, req, opts.abort)) {
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
      const msg: CanonicalMessage = { role: "assistant", content: assistantText };
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

    let callIndex = 0;
    for (; callIndex < pendingCalls.length; callIndex += 1) {
      if (opts.abort.aborted) break;
      const call = pendingCalls[callIndex]!;
      if (opts.hookRunner && opts.sessionId) {
        try {
          await opts.hookRunner.fire({
            event: "PreToolUse",
            sessionId: opts.sessionId,
            cwd: opts.cwd,
            toolName: call.name,
            args: call.args,
            callId: call.id,
          });
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
      );
      if (opts.hookRunner && opts.sessionId) {
        try {
          await opts.hookRunner.fire({
            event: result.ok ? "PostToolUse" : "PostToolUseFailure",
            sessionId: opts.sessionId,
            cwd: opts.cwd,
            toolName: call.name,
            args: call.args,
            callId: call.id,
            ok: result.ok,
            ...(result.error !== undefined && { error: result.error }),
          });
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
      const wrappedContent = wrapToolOutput(call.name, bodyContent, attrs);
      messages.push({
        role: "tool",
        content: wrappedContent,
        toolCallId: call.id,
        toolName: call.name,
      });
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
      return;
    }
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

  const effectivePolicy: PolicyConfig = {
    ...opts.policy,
    rules: mergeRules(sessionRules, projectRules, opts.policy.rules),
  };
  const action = decideAction(
    tool.name,
    tool.defaultPermission,
    call.args,
    effectivePolicy,
  );
  const scopePattern = deriveScopePattern(tool.name, call.args);

  let allowed: boolean;
  let executeMetadata: unknown = undefined;
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
    });
    if (preview) executeMetadata = preview.metadata;
    if (outcome === "always-allow") {
      appendRule(sessionRules, tool.name, {
        pattern: scopePattern,
        action: "allow",
      });
      allowed = true;
    } else if (outcome === "always-project") {
      appendRule(projectRules, tool.name, {
        pattern: scopePattern,
        action: "allow",
      });
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
      },
      executeMetadata,
    );
    return { result, reason: "executed" };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ tool: tool.name, callId: call.id, err: message }, "tool error");
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

function escapeForMarker(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
    messages.push({
      role: "tool",
      content: wrapToolOutput(call.name, body, { ok: false, error: errorCode }),
      toolCallId: call.id,
      toolName: call.name,
    });
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

function wrapToolOutput(
  name: string,
  body: string,
  attrs: { ok: boolean; error?: string },
): string {
  const okAttr = attrs.ok ? ' ok="true"' : ' ok="false"';
  const errAttr = attrs.error ? ` error="${attrs.error}"` : "";
  return `<TOOL_OUTPUT tool="${name}"${okAttr}${errAttr}>\n${escapeForMarker(body)}\n</TOOL_OUTPUT>`;
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
