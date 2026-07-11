// Invariant: Anthropic Messages requests must not contain adjacent messages
// with the same role. Consecutive canonical user turns can happen after a
// provider error or interrupted assistant turn, so the adapter must coalesce
// adjacent user blocks before sending the request.
// Violation: toAnthropicMessages flushes each user message immediately, so two
// consecutive canonical user messages become two consecutive Anthropic user
// messages.
// Predicted failure: the adjacent same-role assertion fails at index 1.
import { describe, expect, it } from "vitest";
import { toAnthropicMessages } from "../../src/providers/llm-message.js";
import type { CanonicalRequest } from "../../src/providers/types.js";

describe("repro: Anthropic user turns must coalesce", () => {
  it("does not emit adjacent user messages for consecutive canonical user turns", () => {
    const req: CanonicalRequest = {
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "first prompt" },
        { role: "user", content: "second prompt after provider error" },
      ],
    };

    const { messages } = toAnthropicMessages(req);

    for (let i = 1; i < messages.length; i += 1) {
      expect(
        messages[i]!.role,
        `adjacent same-role messages at ${i - 1}/${i}: ${JSON.stringify(messages)}`,
      ).not.toBe(messages[i - 1]!.role);
    }
  });
});
