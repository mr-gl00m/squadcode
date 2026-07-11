import { userPromptMessage } from "../prompts/boundary.js";
import type {
  CanonicalMessage,
  CanonicalToolCall,
} from "../providers/types.js";
import type { SessionRecord } from "./types.js";

export function recordsToMessages(
  records: readonly SessionRecord[],
): CanonicalMessage[] {
  const messages: CanonicalMessage[] = [];
  let pendingAssistant: {
    content: string;
    toolCalls: CanonicalToolCall[];
    reasoningContent?: string;
  } | null = null;

  function flushAssistant(): void {
    if (!pendingAssistant) return;
    const msg: CanonicalMessage = {
      role: "assistant",
      content: pendingAssistant.content,
    };
    if (pendingAssistant.toolCalls.length > 0) {
      msg.toolCalls = pendingAssistant.toolCalls;
    }
    if (pendingAssistant.reasoningContent) {
      msg.reasoningContent = pendingAssistant.reasoningContent;
    }
    messages.push(msg);
    pendingAssistant = null;
  }

  for (const record of records) {
    switch (record.type) {
      case "session_meta":
      case "turn_checkpoint":
        break;
      case "user_message":
        flushAssistant();
        messages.push(userPromptMessage(record.payload.content));
        break;
      case "assistant_message":
        flushAssistant();
        pendingAssistant = {
          content: record.payload.content,
          toolCalls: record.payload.toolCalls ?? [],
          ...(record.payload.reasoningContent !== undefined && {
            reasoningContent: record.payload.reasoningContent,
          }),
        };
        flushAssistant();
        break;
      case "tool_call":
        break;
      case "tool_result":
        messages.push({
          role: "tool",
          content: record.payload.content,
          toolCallId: record.payload.callId,
          toolName: record.payload.toolName,
        });
        break;
    }
  }
  flushAssistant();
  return messages;
}
