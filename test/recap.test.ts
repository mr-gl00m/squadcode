import { describe, expect, it } from "vitest";
import type {
  CanonicalMessage,
  CanonicalToolCall,
} from "../src/providers/types.js";
import { formatRecap, formatRecapFromMessages } from "../src/sessions/recap.js";
import type { SessionMetadata, SessionRecord } from "../src/sessions/types.js";
import type { UsageTotals } from "../src/sessions/usage-ledger.js";

const META: SessionMetadata = {
  sessionId: "abcd1234-test-test-test-recap000000",
  startedAt: "2026-05-20T10:00:00.000Z",
  updatedAt: "2026-05-20T10:05:00.000Z",
  cwd: "/repo",
  provider: "anthropic",
  model: "claude-opus-4-7",
  turnCount: 2,
  totalTokens: 1234,
  archived: false,
};

function rec(
  type: SessionRecord["type"],
  payload: object,
  ts = "2026-05-20T10:00:00.000Z",
): SessionRecord {
  return { ts, sessionId: META.sessionId, type, payload } as SessionRecord;
}

const ZERO_USAGE: UsageTotals = {
  rows: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  toolCalls: 0,
  firstTs: null,
  lastTs: null,
};

describe("formatRecap (records path)", () => {
  it("renders header and metadata for an empty session", () => {
    const text = formatRecap({
      metadata: META,
      records: [],
      usage: ZERO_USAGE,
    });
    expect(text).toContain("Recap — session abcd1234");
    expect(text).toContain("anthropic/claude-opus-4-7");
    expect(text).toContain("/repo");
  });

  it("surfaces the first user message as Goal", () => {
    const text = formatRecap({
      metadata: META,
      records: [rec("user_message", { content: "refactor the auth module" })],
      usage: ZERO_USAGE,
    });
    expect(text).toContain("## Goal");
    expect(text).toContain("refactor the auth module");
  });

  it("groups file touches by path with kind", () => {
    const records: SessionRecord[] = [
      rec("user_message", { content: "do the thing" }),
      rec("tool_call", {
        callId: "1",
        toolName: "Read",
        args: { path: "/repo/a.ts" },
      }),
      rec("tool_result", {
        callId: "1",
        toolName: "Read",
        ok: true,
        reason: "executed",
        content: "...",
        contentTruncated: false,
      }),
      rec("tool_call", {
        callId: "2",
        toolName: "Edit",
        args: { path: "/repo/a.ts" },
      }),
      rec("tool_result", {
        callId: "2",
        toolName: "Edit",
        ok: true,
        reason: "executed",
        content: "...",
        contentTruncated: false,
      }),
    ];
    const text = formatRecap({ metadata: META, records, usage: ZERO_USAGE });
    expect(text).toContain("## Files touched");
    expect(text).toContain("a.ts");
    expect(text).toMatch(/a\.ts.*edit.*read/);
  });

  it("lists shell commands with ok status and reason on failure", () => {
    const records: SessionRecord[] = [
      rec("tool_call", {
        callId: "s1",
        toolName: "Shell",
        args: { command: "git status" },
      }),
      rec("tool_result", {
        callId: "s1",
        toolName: "Shell",
        ok: true,
        reason: "executed",
        content: "clean",
        contentTruncated: false,
      }),
    ];
    const text = formatRecap({ metadata: META, records, usage: ZERO_USAGE });
    expect(text).toContain("## Shell");
    expect(text).toContain("[ok]");
    expect(text).toContain("git status");
  });

  it("lists denied tool calls under Denied / aborted", () => {
    const records: SessionRecord[] = [
      rec("tool_call", {
        callId: "e1",
        toolName: "Edit",
        args: { path: "/repo/secret.ts" },
      }),
      rec("tool_result", {
        callId: "e1",
        toolName: "Edit",
        ok: false,
        reason: "denied",
        content: "",
        contentTruncated: false,
      }),
    ];
    const text = formatRecap({ metadata: META, records, usage: ZERO_USAGE });
    expect(text).toContain("## Denied / aborted");
    expect(text).toContain("Edit");
  });

  it("surfaces usage totals when rows > 0", () => {
    const usage: UsageTotals = {
      ...ZERO_USAGE,
      rows: 2,
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 500,
      totalTokens: 1200,
      costUsd: 0.0123,
    };
    const text = formatRecap({ metadata: META, records: [], usage });
    expect(text).toContain("## Tokens & cost");
    expect(text).toContain("input: 1,000");
    expect(text).toContain("output: 200");
    expect(text).toContain("cost: $0.0123");
  });

  it("derives next-action from in-progress todo when available", () => {
    const records: SessionRecord[] = [
      rec("tool_call", {
        callId: "t1",
        toolName: "TodoWrite",
        args: {
          todos: [
            { status: "completed", content: "done thing" },
            { status: "in_progress", content: "current thing" },
            { status: "pending", content: "later thing" },
          ],
        },
      }),
      rec("tool_result", {
        callId: "t1",
        toolName: "TodoWrite",
        ok: true,
        reason: "executed",
        content: "",
        contentTruncated: false,
      }),
    ];
    const text = formatRecap({ metadata: META, records, usage: ZERO_USAGE });
    expect(text).toContain("## Outstanding todos");
    expect(text).toContain("[~] current thing");
    expect(text).toContain("[ ] later thing");
    expect(text).toContain("## Next action");
    expect(text).toContain("current thing");
  });

  it("falls back to last-assistant tail for next-action when no todos", () => {
    const records: SessionRecord[] = [
      rec("user_message", { content: "do X" }),
      rec("assistant_message", {
        content: "Step 1.\n\nNext: run the migration.",
      }),
    ];
    const text = formatRecap({ metadata: META, records, usage: ZERO_USAGE });
    expect(text).toContain("## Next action");
    expect(text).toContain("Next: run the migration");
  });
});

describe("formatRecapFromMessages (in-memory path)", () => {
  function call(id: string, name: string, args: unknown): CanonicalToolCall {
    return { id, name, args };
  }

  it("surfaces user prompt as Goal", () => {
    const messages: CanonicalMessage[] = [
      { role: "user", content: "implement plan mode" },
    ];
    const text = formatRecapFromMessages({
      metadata: META,
      messages,
      usage: ZERO_USAGE,
    });
    expect(text).toContain("implement plan mode");
  });

  it("tracks file touches via tool calls + tool messages", () => {
    const messages: CanonicalMessage[] = [
      { role: "user", content: "edit foo" },
      {
        role: "assistant",
        content: "",
        toolCalls: [call("1", "Edit", { path: "/repo/foo.ts" })],
      },
      {
        role: "tool",
        content: "ok",
        toolCallId: "1",
        toolName: "Edit",
      },
    ];
    const text = formatRecapFromMessages({
      metadata: META,
      messages,
      usage: ZERO_USAGE,
    });
    expect(text).toContain("foo.ts");
    expect(text).toContain("(edit)");
  });

  it("Shell tool message starting with [permission denied] is flagged as denied", () => {
    const messages: CanonicalMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [call("s1", "Shell", { command: "rm -rf /" })],
      },
      {
        role: "tool",
        content: "[permission denied] user said no",
        toolCallId: "s1",
        toolName: "Shell",
      },
    ];
    const text = formatRecapFromMessages({
      metadata: META,
      messages,
      usage: ZERO_USAGE,
    });
    expect(text).toContain("[denied]");
    expect(text).toContain("rm -rf");
  });

  it("does not emit denied / aborted section (in-memory path has no reason)", () => {
    const messages: CanonicalMessage[] = [{ role: "user", content: "x" }];
    const text = formatRecapFromMessages({
      metadata: META,
      messages,
      usage: ZERO_USAGE,
    });
    expect(text).not.toContain("## Denied / aborted");
  });
});
