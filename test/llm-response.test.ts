import { describe, expect, it } from "vitest";
import {
  toResponseInput,
  toResponseTools,
} from "../src/providers/llm-response.js";
import type { CanonicalRequest } from "../src/providers/types.js";

describe("toResponseInput", () => {
  it("hoists system messages into instructions", () => {
    const req: CanonicalRequest = {
      model: "gpt-5.1",
      messages: [
        { role: "system", content: "be helpful" },
        { role: "user", content: "hi" },
      ],
    };
    const { instructions, input } = toResponseInput(req);
    expect(instructions).toBe("be helpful");
    expect(input).toEqual([
      { role: "user", content: "hi", type: "message" },
    ]);
  });

  it("concatenates req.system with system messages", () => {
    const req: CanonicalRequest = {
      model: "gpt-5.1",
      system: "first",
      messages: [
        { role: "system", content: "second" },
        { role: "user", content: "hi" },
      ],
    };
    const { instructions } = toResponseInput(req);
    expect(instructions).toBe("first\n\nsecond");
  });

  it("converts assistant text + tool_calls into separate input items", () => {
    const req: CanonicalRequest = {
      model: "gpt-5.1",
      messages: [
        { role: "user", content: "list files" },
        {
          role: "assistant",
          content: "I'll glob",
          toolCalls: [
            { id: "call_1", name: "Glob", args: { pattern: "*.ts" } },
          ],
        },
      ],
    };
    const { input } = toResponseInput(req);
    expect(input).toHaveLength(3);
    expect(input[0]).toEqual({
      role: "user",
      content: "list files",
      type: "message",
    });
    expect(input[1]).toEqual({
      role: "assistant",
      content: "I'll glob",
      type: "message",
    });
    expect(input[2]).toEqual({
      type: "function_call",
      call_id: "call_1",
      name: "Glob",
      arguments: '{"pattern":"*.ts"}',
    });
  });

  it("emits a function_call without text when assistant has no content", () => {
    const req: CanonicalRequest = {
      model: "gpt-5.1",
      messages: [
        { role: "user", content: "x" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c", name: "Glob", args: { pattern: "*" } }],
        },
      ],
    };
    const { input } = toResponseInput(req);
    expect(input).toHaveLength(2);
    expect(input[1]).toMatchObject({ type: "function_call", call_id: "c" });
  });

  it("converts tool messages into function_call_output items", () => {
    const req: CanonicalRequest = {
      model: "gpt-5.1",
      messages: [
        { role: "user", content: "x" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c", name: "Glob", args: { pattern: "*" } }],
        },
        { role: "tool", content: "src/foo.ts", toolCallId: "c" },
      ],
    };
    const { input } = toResponseInput(req);
    expect(input[2]).toEqual({
      type: "function_call_output",
      call_id: "c",
      output: "src/foo.ts",
    });
  });

  it("preserves string-typed tool args without re-stringifying", () => {
    const req: CanonicalRequest = {
      model: "gpt-5.1",
      messages: [
        { role: "user", content: "x" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c", name: "Glob", args: '{"pattern":"*.ts"}' }],
        },
      ],
    };
    const { input } = toResponseInput(req);
    expect(input[1]).toMatchObject({
      arguments: '{"pattern":"*.ts"}',
    });
  });

  it("collapses interleaved tool roles correctly", () => {
    const req: CanonicalRequest = {
      model: "gpt-5.1",
      messages: [
        { role: "user", content: "x" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "c1", name: "Glob", args: {} },
            { id: "c2", name: "Grep", args: {} },
          ],
        },
        { role: "tool", content: "out1", toolCallId: "c1" },
        { role: "tool", content: "out2", toolCallId: "c2" },
        { role: "assistant", content: "done" },
      ],
    };
    const { input } = toResponseInput(req);
    // user, fc1, fc2, fco1, fco2, msg
    expect(input).toHaveLength(6);
    const types = input.map((i) => (i as { type?: string }).type);
    expect(types).toEqual([
      "message",
      "function_call",
      "function_call",
      "function_call_output",
      "function_call_output",
      "message",
    ]);
  });
});

describe("toResponseTools", () => {
  it("returns undefined for empty input", () => {
    expect(toResponseTools(undefined)).toBeUndefined();
    expect(toResponseTools([])).toBeUndefined();
  });

  it("converts tool specs to FunctionTool shape", () => {
    const tools = toResponseTools([
      {
        name: "Glob",
        description: "list files",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    expect(tools).toHaveLength(1);
    expect(tools![0]).toEqual({
      type: "function",
      name: "Glob",
      description: "list files",
      parameters: { type: "object", properties: {} },
      strict: false,
    });
  });

  it("converts multiple tools without mutation across entries", () => {
    const tools = toResponseTools([
      { name: "A", description: "1", inputSchema: { type: "object" } },
      { name: "B", description: "2", inputSchema: { type: "object" } },
    ]);
    expect(tools).toHaveLength(2);
    expect(tools![0]?.name).toBe("A");
    expect(tools![1]?.name).toBe("B");
  });
});
