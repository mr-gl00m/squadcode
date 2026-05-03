import { logger } from "../logger.js";
import { decideAction, type PolicyConfig } from "../permissions/policy.js";
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
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolResult } from "../tools/types.js";
import { runTurn } from "./stream.js";

export type AskPermissionFn = (req: PromptRequest) => Promise<PromptOutcome>;

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
  sessionAllow?: Set<string>;
  projectAllow?: Set<string>;
  askPermission?: AskPermissionFn;
}

const DEFAULT_MAX_TURNS = 25;

// Diminishing-returns guard. If the model produces fewer than this many chars
// of assistant content (text + reasoning) for LOW_PROGRESS_STREAK consecutive
// turns while still emitting tool calls, the loop is thrashing — bail out
// rather than burn the rest of maxTurns on a model that's not making progress.
const LOW_PROGRESS_CHARS = 500;
const LOW_PROGRESS_STREAK = 3;

export async function* runAgentLoop(
  opts: AgentLoopOptions,
): AsyncIterable<CanonicalEvent> {
  const messages = opts.messages;
  const sessionAllow = opts.sessionAllow ?? new Set<string>();
  const projectAllow = opts.projectAllow ?? new Set<string>();
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  let lowProgressStreak = 0;

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

    const turnChars = assistantText.length + assistantReasoning.length;
    if (turnChars < LOW_PROGRESS_CHARS) {
      lowProgressStreak += 1;
      if (lowProgressStreak >= LOW_PROGRESS_STREAK) {
        logger.warn(
          { turn, lowProgressStreak, turnChars },
          "agent loop diminishing returns",
        );
        yield {
          type: "error",
          code: "DIMINISHING_RETURNS",
          message: `aborted after ${LOW_PROGRESS_STREAK} consecutive low-progress turns (<${LOW_PROGRESS_CHARS} chars each); model appears stuck`,
          retryable: false,
        };
        return;
      }
    } else {
      lowProgressStreak = 0;
    }

    for (const call of pendingCalls) {
      if (opts.abort.aborted) return;
      const { result, reason } = await runOneToolCall(
        call,
        opts,
        sessionAllow,
        projectAllow,
      );
      const attrs: { ok: boolean; error?: string } = { ok: result.ok };
      if (result.error !== undefined) attrs.error = result.error;
      const wrappedContent = wrapToolOutput(call.name, result.content, attrs);
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
      yield resultEvent;
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
  sessionAllow: Set<string>,
  projectAllow: Set<string>,
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

  const action = sessionAllow.has(tool.name) || projectAllow.has(tool.name)
    ? "allow"
    : decideAction(tool.name, tool.defaultPermission, opts.policy);

  let allowed: boolean;
  if (action === "deny") {
    allowed = false;
  } else if (action === "allow") {
    allowed = true;
  } else {
    const askFn = opts.askPermission ?? promptForPermission;
    const outcome = await askFn({
      toolName: tool.name,
      callId: call.id,
      argsPreview: previewArgs(call.args),
    });
    if (outcome === "always-allow") {
      sessionAllow.add(tool.name);
      allowed = true;
    } else if (outcome === "always-project") {
      projectAllow.add(tool.name);
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
    const result = await tool.execute(call.args, {
      cwd: opts.cwd,
      signal: opts.abort,
      callId: call.id,
    });
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
