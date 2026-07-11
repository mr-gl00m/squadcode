import { describe, expect, it } from "vitest";
import {
  mapStopReason,
  systemFieldWithCacheControl,
  toAnthropicMessages,
  toAnthropicTools,
} from "../src/providers/llm-message.js";
import type { CanonicalRequest } from "../src/providers/types.js";

describe("toAnthropicMessages", () => {
  it("hoists system messages into the system field", () => {
    const req: CanonicalRequest = {
      model: "claude-sonnet-4-6",
      messages: [
        { role: "system", content: "be helpful" },
        { role: "user", content: "hi" },
      ],
    };
    const { system, messages } = toAnthropicMessages(req);
    expect(system).toBe("be helpful");
    expect(messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  it("concatenates req.system with system messages", () => {
    const req: CanonicalRequest = {
      model: "claude-sonnet-4-6",
      system: "first system block",
      messages: [
        { role: "system", content: "second system block" },
        { role: "user", content: "hi" },
      ],
    };
    const { system } = toAnthropicMessages(req);
    expect(system).toBe("first system block\n\nsecond system block");
  });

  it("coalesces consecutive tool messages into one user message", () => {
    const req: CanonicalRequest = {
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "find files" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_1", name: "Glob", args: { pattern: "*.ts" } },
            { id: "call_2", name: "Grep", args: { pattern: "TODO" } },
          ],
        },
        {
          role: "tool",
          content: "src/foo.ts\nsrc/bar.ts",
          toolCallId: "call_1",
        },
        {
          role: "tool",
          content: "src/foo.ts:42:// TODO",
          toolCallId: "call_2",
        },
        { role: "assistant", content: "Found 1 TODO" },
      ],
    };
    const { messages } = toAnthropicMessages(req);
    expect(messages).toHaveLength(4);
    // user(find files), assistant(tool_use x2), user(tool_result x2), assistant(text)
    const toolResultMsg = messages[2]!;
    expect(toolResultMsg.role).toBe("user");
    expect(Array.isArray(toolResultMsg.content)).toBe(true);
    const blocks = toolResultMsg.content as Array<{ type: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.type).toBe("tool_result");
    expect(blocks[1]?.type).toBe("tool_result");
  });

  it("converts assistant tool calls into tool_use blocks", () => {
    const req: CanonicalRequest = {
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "list files" },
        {
          role: "assistant",
          content: "I'll look",
          toolCalls: [
            { id: "call_1", name: "Glob", args: { pattern: "*.ts" } },
          ],
        },
      ],
    };
    const { messages } = toAnthropicMessages(req);
    const assistant = messages[1]!;
    expect(assistant.role).toBe("assistant");
    const blocks = assistant.content as Array<{ type: string }>;
    expect(blocks[0]?.type).toBe("text");
    expect(blocks[1]?.type).toBe("tool_use");
  });

  it("parses string tool args into JSON when possible", () => {
    const req: CanonicalRequest = {
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "x" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_1", name: "Glob", args: '{"pattern":"*.ts"}' },
          ],
        },
      ],
    };
    const { messages } = toAnthropicMessages(req);
    const assistant = messages[1]!;
    const blocks = assistant.content as Array<{
      type: string;
      input?: unknown;
    }>;
    expect(blocks[0]?.type).toBe("tool_use");
    expect(blocks[0]?.input).toEqual({ pattern: "*.ts" });
  });

  it("inserts placeholder text for empty assistant content (Anthropic rejects empty arrays)", () => {
    const req: CanonicalRequest = {
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "" },
      ],
    };
    const { messages } = toAnthropicMessages(req);
    const blocks = messages[1]!.content as Array<{ type: string }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("text");
  });
});

describe("toAnthropicTools", () => {
  it("returns undefined for empty input", () => {
    expect(toAnthropicTools(undefined, false)).toBeUndefined();
    expect(toAnthropicTools([], false)).toBeUndefined();
  });

  it("converts tool specs to Anthropic shape", () => {
    const tools = toAnthropicTools(
      [
        {
          name: "Glob",
          description: "list files",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      false,
    );
    expect(tools).toHaveLength(1);
    expect(tools![0]?.name).toBe("Glob");
    expect(tools![0]?.input_schema).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("attaches cache_control ephemeral to the LAST tool when requested", () => {
    const tools = toAnthropicTools(
      [
        {
          name: "Glob",
          description: "x",
          inputSchema: { type: "object" },
        },
        {
          name: "Grep",
          description: "y",
          inputSchema: { type: "object" },
        },
        {
          name: "Read",
          description: "z",
          inputSchema: { type: "object" },
        },
      ],
      true,
    );
    expect(tools).toHaveLength(3);
    const withCache = tools as Array<{
      name: string;
      cache_control?: { type: string };
    }>;
    expect(withCache[0]?.cache_control).toBeUndefined();
    expect(withCache[1]?.cache_control).toBeUndefined();
    expect(withCache[2]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("does not attach cache_control when capability is off", () => {
    const tools = toAnthropicTools(
      [{ name: "Glob", description: "x", inputSchema: { type: "object" } }],
      false,
    );
    const result = tools as Array<{ cache_control?: unknown }>;
    expect(result[0]?.cache_control).toBeUndefined();
  });
});

describe("systemFieldWithCacheControl", () => {
  it("returns undefined when system is missing", () => {
    expect(systemFieldWithCacheControl(undefined, true)).toBeUndefined();
  });

  it("returns plain string when cache is off", () => {
    expect(systemFieldWithCacheControl("be helpful", false)).toBe("be helpful");
  });

  it("wraps in array with cache_control when cache is on", () => {
    const out = systemFieldWithCacheControl("be helpful", true);
    expect(Array.isArray(out)).toBe(true);
    const arr = out as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;
    expect(arr).toHaveLength(1);
    expect(arr[0]?.type).toBe("text");
    expect(arr[0]?.text).toBe("be helpful");
    expect(arr[0]?.cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("mapStopReason", () => {
  it("maps Anthropic stop reasons to canonical", () => {
    expect(mapStopReason("end_turn")).toBe("stop");
    expect(mapStopReason("max_tokens")).toBe("max_tokens");
    expect(mapStopReason("tool_use")).toBe("tool_use");
    expect(mapStopReason("stop_sequence")).toBe("stop");
    expect(mapStopReason("refusal")).toBe("content_filter");
    expect(mapStopReason("pause_turn")).toBe("stop");
    expect(mapStopReason(null)).toBe("stop");
    expect(mapStopReason(undefined)).toBe("stop");
  });
});
