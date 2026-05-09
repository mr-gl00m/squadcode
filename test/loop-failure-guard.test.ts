import { describe, it, expect } from "vitest";
import { runAgentLoop } from "../src/engine/loop.js";
import type {
  CanonicalEvent,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalToolCall,
  LLMProvider,
} from "../src/providers/types.js";
import type { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";
import type { PolicyConfig } from "../src/permissions/policy.js";
import { z } from "zod";

type ScriptedTurn = CanonicalToolCall[];

function makeProvider(turns: ScriptedTurn[]): LLMProvider {
  let i = 0;
  return {
    name: "ollama",
    async *stream(_req: CanonicalRequest): AsyncIterable<CanonicalEvent> {
      const calls = turns[i] ?? [];
      i += 1;
      for (const call of calls) {
        yield { type: "tool_call_done", id: call.id, name: call.name, args: call.args };
      }
      yield { type: "done", reason: calls.length > 0 ? "tool_use" : "stop" };
    },
    async complete(): Promise<CanonicalResponse> {
      throw new Error("not used");
    },
  };
}

// A registry exposing one tool that succeeds or fails based on args.kind.
// args = { kind: "ok" }    -> { ok: true }
// args = { kind: "fail" }  -> { ok: false, error: "TOOL_ERROR" }
function makeRegistry(): ToolRegistry {
  const dual: Tool = {
    name: "dual",
    description: "stub that succeeds or fails based on args.kind",
    inputSchema: { type: "object" },
    inputZod: z.unknown(),
    defaultPermission: "auto-allow",
    isReadOnly: true,
    execute: async (args: unknown) => {
      const kind = (args as { kind?: string } | null)?.kind;
      if (kind === "fail") {
        return { ok: false, content: "scripted failure", error: "TOOL_ERROR" };
      }
      return { ok: true, content: "ok" };
    },
  };
  const tools = new Map<string, Tool>([[dual.name, dual]]);
  return {
    get: (n) => tools.get(n),
    list: () => [...tools.values()],
    toCanonicalSpecs: () =>
      [...tools.values()].map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    deferredCatalog: () => [],
    isLoaded: () => false,
    markLoaded: () => false,
    markLoadedFromMessages: () => {},
    loadedDeferredNames: () => [],
    todoState: { todos: [] } as unknown as ToolRegistry["todoState"],
  };
}

const policy: PolicyConfig = {
  defaultMode: "allow",
  rules: new Map(),
  dangerouslySkipPermissions: false,
};

async function collectErrors(
  turns: ScriptedTurn[],
): Promise<Array<{ code: string; message: string }>> {
  const errors: Array<{ code: string; message: string }> = [];
  const ctrl = new AbortController();
  for await (const ev of runAgentLoop({
    provider: makeProvider(turns),
    model: "test",
    messages: [{ role: "user", content: "go" }],
    registry: makeRegistry(),
    policy,
    cwd: process.cwd(),
    abort: ctrl.signal,
    maxTurns: 50,
  })) {
    if (ev.type === "error") errors.push({ code: ev.code, message: ev.message });
  }
  return errors;
}

let counter = 0;
function failCall(): CanonicalToolCall {
  counter += 1;
  return { id: `fail-${counter}`, name: "dual", args: { kind: "fail", seq: counter } };
}

function okCall(): CanonicalToolCall {
  counter += 1;
  return { id: `ok-${counter}`, name: "dual", args: { kind: "ok", seq: counter } };
}

function unknownToolCall(): CanonicalToolCall {
  counter += 1;
  return { id: `u-${counter}`, name: "no_such_tool", args: { seq: counter } };
}

describe("agent loop consecutive-failure guard", () => {
  it("aborts after 8 consecutive tool failures across distinct calls", async () => {
    counter = 0;
    // Use distinct args each turn (different seq numbers) so the repeat-guard
    // doesn't trigger first — we want to isolate the failure-streak signal.
    const turns: ScriptedTurn[] = [];
    for (let i = 0; i < 9; i++) turns.push([failCall()]);
    turns.push([]);
    const errors = await collectErrors(turns);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("REPEATED_TOOL_FAILURES");
  });

  it("does not abort when failures are interrupted by a success", async () => {
    counter = 0;
    // 5 fails, then 1 ok, then 5 more fails — the success resets the streak,
    // so neither half hits the halt threshold of 8.
    const turns: ScriptedTurn[] = [];
    for (let i = 0; i < 5; i++) turns.push([failCall()]);
    turns.push([okCall()]);
    for (let i = 0; i < 5; i++) turns.push([failCall()]);
    turns.push([]);
    const errors = await collectErrors(turns);
    expect(errors).toEqual([]);
  });

  it("counts unknown-tool calls as failures", async () => {
    counter = 0;
    // 8 unknown-tool calls in a row should hit the halt threshold even
    // though the tool itself never executes.
    const turns: ScriptedTurn[] = [];
    for (let i = 0; i < 9; i++) turns.push([unknownToolCall()]);
    turns.push([]);
    const errors = await collectErrors(turns);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("REPEATED_TOOL_FAILURES");
  });

  it("counts mixed fail-then-unknown as one streak", async () => {
    counter = 0;
    // Alternating fail/unknown across 8 turns — same streak.
    const turns: ScriptedTurn[] = [];
    for (let i = 0; i < 9; i++) {
      turns.push([i % 2 === 0 ? failCall() : unknownToolCall()]);
    }
    turns.push([]);
    const errors = await collectErrors(turns);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("REPEATED_TOOL_FAILURES");
  });

  it("a successful turn resets the streak", async () => {
    counter = 0;
    // 7 fails (one short of halt), then 1 success, then 7 fails again. Neither
    // half hits 8, so no halt.
    const turns: ScriptedTurn[] = [];
    for (let i = 0; i < 7; i++) turns.push([failCall()]);
    turns.push([okCall()]);
    for (let i = 0; i < 7; i++) turns.push([failCall()]);
    turns.push([]);
    const errors = await collectErrors(turns);
    expect(errors).toEqual([]);
  });
});
