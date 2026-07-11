import type {
  CanonicalEvent,
  CanonicalToolCall,
  CanonicalUsage,
} from "../providers/types.js";
import type { SessionStore } from "../sessions/store.js";

export interface PrintTurnBuffers {
  text: string;
  reasoning: string;
  pendingToolCalls: CanonicalToolCall[];
  turnTokens: number;
  toolCalls: number;
  lastUsage?: CanonicalUsage;
  lastAssistantText?: string;
}

export async function persistEvent(args: {
  store: SessionStore;
  sessionId: string;
  ev: CanonicalEvent;
  buffers: PrintTurnBuffers;
}): Promise<void> {
  const { store, sessionId, ev, buffers } = args;
  switch (ev.type) {
    case "text_delta":
      buffers.text += ev.text;
      return;
    case "reasoning_delta":
      buffers.reasoning += ev.text;
      return;
    case "tool_call_done": {
      buffers.pendingToolCalls.push({
        id: ev.id,
        name: ev.name,
        args: ev.args,
      });
      buffers.toolCalls += 1;
      await store.appendToolCall(sessionId, {
        callId: ev.id,
        toolName: ev.name,
        args: ev.args,
      });
      return;
    }
    case "done": {
      if (buffers.text.length > 0) buffers.lastAssistantText = buffers.text;
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
    case "tool_result":
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
    case "usage":
      buffers.turnTokens += ev.usage.totalTokens;
      buffers.lastUsage = ev.usage;
      return;
    case "tool_call_start":
    case "tool_call_delta":
    case "error":
      return;
  }
}
