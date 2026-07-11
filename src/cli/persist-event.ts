import { logger } from "../logger.js";
import type { CanonicalEvent, CanonicalToolCall } from "../providers/types.js";
import type { SessionStore } from "../sessions/store.js";

export interface PersistBuffers {
  text: string;
  reasoning: string;
  pendingToolCalls: CanonicalToolCall[];
  turnTokens: number;
}

// Folds a stream of CanonicalEvents into the session store. Text and reasoning
// accumulate in `buffers` and flush as one assistant message on `done`; tool
// calls and results append as they arrive. Each store write is wrapped so a
// transcript-append failure logs and continues rather than aborting the turn —
// the live UI already rendered the event, so the persisted copy is best-effort.
// Shared by both the Ink REPL (repl.tsx) and the fallback REPL (simple-repl.ts).
export async function persistEventToStore(
  store: SessionStore,
  sessionId: string,
  ev: CanonicalEvent,
  buffers: PersistBuffers,
  turnId?: string,
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
      try {
        await store.appendToolCall(
          sessionId,
          {
            callId: ev.id,
            toolName: ev.name,
            args: ev.args,
          },
          turnId,
        );
      } catch (err: unknown) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "session append (tool_call) failed",
        );
      }
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
        try {
          await store.appendAssistantMessage(sessionId, payload, turnId);
        } catch (err: unknown) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "session append (assistant) failed",
          );
        }
      }
      buffers.text = "";
      buffers.reasoning = "";
      buffers.pendingToolCalls = [];
      return;
    }
    case "tool_result":
      try {
        await store.appendToolResult(
          sessionId,
          {
            callId: ev.id,
            toolName: ev.name,
            ok: ev.ok,
            reason: ev.reason ?? "executed",
            content: ev.content,
            contentTruncated: false,
            ...(ev.error !== undefined && { error: ev.error }),
            ...(ev.artifact && { artifact: ev.artifact }),
          },
          turnId,
        );
      } catch (err: unknown) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "session append (tool_result) failed",
        );
      }
      return;
    case "usage":
      buffers.turnTokens += ev.usage.totalTokens;
      return;
    case "tool_call_start":
    case "tool_call_delta":
    case "error":
      return;
  }
}
