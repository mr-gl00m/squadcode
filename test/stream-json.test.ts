import { describe, expect, it } from "vitest";
import { createStreamJsonRenderer } from "../src/cli/stream-json.js";
import { streamJsonRecordSchema } from "../src/cli/stream-json-schema.js";
import type { CanonicalEvent } from "../src/providers/types.js";

function collector() {
  const lines: string[] = [];
  const renderer = createStreamJsonRenderer((l) => lines.push(l));
  return {
    renderer,
    records: () =>
      lines.map((l) => {
        expect(l.endsWith("\n")).toBe(true);
        const record = JSON.parse(l) as Record<string, unknown>;
        expect(streamJsonRecordSchema.safeParse(record).success).toBe(true);
        return record;
      }),
  };
}

describe("createStreamJsonRenderer", () => {
  it("emits an init record with turn metadata", () => {
    const c = collector();
    c.renderer.init({
      sessionId: "S1",
      provider: "deepseek",
      model: "deepseek-chat",
      cwd: "/proj",
      mode: "act",
      resumed: false,
    });
    const [rec] = c.records();
    expect(rec).toMatchObject({
      type: "init",
      sessionId: "S1",
      provider: "deepseek",
      model: "deepseek-chat",
      cwd: "/proj",
      mode: "act",
    });
    expect(typeof rec?.ts).toBe("string");
  });

  it("accumulates text deltas into one message record at done", () => {
    const c = collector();
    const evs: CanonicalEvent[] = [
      { type: "text_delta", text: "Hello " },
      { type: "text_delta", text: "world" },
      { type: "done", reason: "stop" },
    ];
    for (const e of evs) c.renderer.event(e);
    const recs = c.records();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      type: "message",
      role: "assistant",
      text: "Hello world",
    });
  });

  it("flushes accumulated text as a message before a tool_use", () => {
    const c = collector();
    const evs: CanonicalEvent[] = [
      { type: "text_delta", text: "let me check" },
      { type: "tool_call_start", id: "t1", name: "Shell" },
      {
        type: "tool_call_done",
        id: "t1",
        name: "Shell",
        args: { command: "ls" },
      },
      {
        type: "tool_result",
        id: "t1",
        name: "Shell",
        ok: true,
        content: "a\nb",
        reason: "executed",
      },
      { type: "text_delta", text: "done" },
      { type: "done", reason: "stop" },
    ];
    for (const e of evs) c.renderer.event(e);
    const recs = c.records();
    expect(recs.map((r) => r.type)).toEqual([
      "message",
      "tool_use",
      "tool_result",
      "message",
    ]);
    expect(recs[0]).toMatchObject({ text: "let me check" });
    expect(recs[1]).toMatchObject({
      type: "tool_use",
      id: "t1",
      name: "Shell",
      args: { command: "ls" },
    });
    expect(recs[2]).toMatchObject({
      type: "tool_result",
      id: "t1",
      ok: true,
      reason: "executed",
      content: "a\nb",
    });
    expect(recs[3]).toMatchObject({ text: "done" });
  });

  it("carries error/reason/artifact on a tool_result when present", () => {
    const c = collector();
    c.renderer.event({
      type: "tool_result",
      id: "t1",
      name: "Read",
      ok: false,
      error: "ENOENT",
      reason: "executed",
      content: "no such file",
      artifact: { path: "/a/x", sha256: "abc", fullSizeBytes: 999 },
    });
    const [rec] = c.records();
    expect(rec).toMatchObject({
      type: "tool_result",
      ok: false,
      error: "ENOENT",
      artifact: { path: "/a/x", sha256: "abc", fullSizeBytes: 999 },
    });
  });

  it("records reasoning separately from text", () => {
    const c = collector();
    c.renderer.event({ type: "reasoning_delta", text: "thinking..." });
    c.renderer.event({ type: "text_delta", text: "answer" });
    c.renderer.event({ type: "done", reason: "stop" });
    const [rec] = c.records();
    expect(rec).toMatchObject({ text: "answer", reasoning: "thinking..." });
  });

  it("emits an error record and flags exitCode", () => {
    const c = collector();
    c.renderer.event({
      type: "error",
      code: "RATE_LIMITED",
      message: "slow down",
      retryable: true,
    });
    const [rec] = c.records();
    expect(rec).toMatchObject({
      type: "error",
      code: "RATE_LIMITED",
      retryable: true,
    });
    expect(c.renderer.state.exitCode).toBe(1);
  });

  it("captures usage and folds it into the result breakdown", () => {
    const c = collector();
    c.renderer.event({
      type: "usage",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cachedInputTokens: 40,
      },
    });
    c.renderer.event({ type: "done", reason: "stop" });
    c.renderer.result({
      sessionId: "S1",
      provider: "deepseek",
      model: "deepseek-chat",
      usage: c.renderer.state.lastUsage ?? {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      costUsd: 0.0123,
      toolCalls: 2,
      exitCode: 0,
    });
    const recs = c.records();
    const result = recs.find((r) => r.type === "result");
    expect(result).toMatchObject({
      type: "result",
      provider: "deepseek",
      model: "deepseek-chat",
      usage: {
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 50,
        totalTokens: 150,
      },
      costUsd: 0.0123,
      toolCalls: 2,
      exitCode: 0,
    });
  });

  it("defaults cachedInputTokens to 0 in the result", () => {
    const c = collector();
    c.renderer.result({
      sessionId: "S1",
      provider: "ollama",
      model: "qwen3",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      costUsd: 0,
      toolCalls: 0,
      exitCode: 0,
    });
    const [rec] = c.records();
    expect((rec?.usage as Record<string, number>).cachedInputTokens).toBe(0);
  });

  it("counts tool calls in renderer state", () => {
    const c = collector();
    c.renderer.event({
      type: "tool_call_done",
      id: "a",
      name: "Read",
      args: {},
    });
    c.renderer.event({
      type: "tool_call_done",
      id: "b",
      name: "Glob",
      args: {},
    });
    expect(c.renderer.state.toolCalls).toBe(2);
  });
});
