// Invariant: toAnthropicMessages must produce a message list where no two
// consecutive entries share the same role. Quote (llm-message.ts:47-50):
// "Anthropic requires alternating user/assistant. The squad canonical
// message stream has separate "tool" entries (one per tool result) which
// must coalesce into a single user message with multiple tool_result
// content blocks."
// Violation: when a canonical "tool" message is followed by a canonical
// "user" message, MessageBuilder flushes the pending tool_result as one
// user message AND then flushes the user text as another user message —
// producing two consecutive user-role messages.
// Predicted failure: the assertion `no two consecutive user-role messages`
// fails because output is [user, assistant, user, user].

import { expect, it } from "vitest";
import { toAnthropicMessages } from "../../src/providers/llm-message.js";
import type { CanonicalMessage } from "../../src/providers/types.js";

it("toAnthropicMessages does not emit consecutive same-role messages when user follows tool", () => {
  const canonical: CanonicalMessage[] = [
    { role: "user", content: "first prompt" },
    {
      role: "assistant",
      content: "thinking",
      toolCalls: [{ id: "call_1", name: "Read", args: { path: "x" } }],
    },
    {
      role: "tool",
      content: "file content",
      toolCallId: "call_1",
      toolName: "Read",
    },
    { role: "user", content: "follow-up question" },
  ];

  const { messages } = toAnthropicMessages({
    model: "claude-x",
    messages: canonical,
  });

  for (let i = 1; i < messages.length; i += 1) {
    expect(
      messages[i]!.role,
      `messages[${i}].role === messages[${i - 1}].role; output: ${JSON.stringify(messages.map((m) => m.role))}`,
    ).not.toBe(messages[i - 1]!.role);
  }
});
