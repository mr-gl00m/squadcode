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

// Each "turn" is a fixed list of tool calls the fake provider should emit.
// An empty array signals "no tool calls" — the loop ends naturally.
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

function makeStubRegistry(): ToolRegistry {
  const echoTool: Tool = {
    name: "echo",
    description: "stub",
    inputSchema: { type: "object" },
    inputZod: z.unknown(),
    defaultPermission: "auto-allow",
    isReadOnly: true,
    execute: async () => ({ ok: true, content: "ok" }),
  };
  const tools = new Map<string, Tool>([[echoTool.name, echoTool]]);
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
    registry: makeStubRegistry(),
    policy,
    cwd: process.cwd(),
    abort: ctrl.signal,
    maxTurns: 20,
  })) {
    if (ev.type === "error") errors.push({ code: ev.code, message: ev.message });
  }
  return errors;
}

const sigGlob = (pattern: string): CanonicalToolCall => ({
  id: `g-${pattern}-${Math.random()}`,
  name: "echo",
  args: { kind: "glob", pattern },
});

const sigRead = (path: string): CanonicalToolCall => ({
  id: `r-${path}-${Math.random()}`,
  name: "echo",
  args: { kind: "read", path },
});

describe("agent loop repeated-call guard", () => {
  it("aborts when the same tool call is emitted alone on 3 consecutive turns", async () => {
    const errors = await collectErrors([
      [sigGlob("src/**/*.ts")],
      [sigGlob("src/**/*.ts")],
      [sigGlob("src/**/*.ts")],
      [],
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("REPEATED_TOOL_CALLS");
  });

  it("does NOT abort when each turn re-emits the same call but also makes progress with new reads", async () => {
    // This is the red-team-audit failure mode: model re-globs every turn but
    // also reads new files — that's exploration, not thrashing.
    const errors = await collectErrors([
      [sigRead("a.md"), sigRead("b.md")],
      [sigGlob("src/**/*.ts"), sigRead("c.md")],
      [sigGlob("src/**/*.ts"), sigRead("d.md")],
      [sigGlob("src/**/*.ts"), sigRead("e.md")],
      [sigGlob("src/**/*.ts"), sigRead("f.md")],
      [],
    ]);
    expect(errors).toEqual([]);
  });

  it("aborts identical-set thrash (exact same tool calls every turn for 3 turns)", async () => {
    // If the model emits {Glob X, Read A} three times in a row with no
    // progress, that IS thrashing — even though there are two tools.
    const callA = sigRead("a.md");
    const callB = sigGlob("src/**/*.ts");
    // Use stable IDs so canonicalization sees identical args across turns.
    const stableA: CanonicalToolCall = { ...callA, id: "fixed-a" };
    const stableB: CanonicalToolCall = { ...callB, id: "fixed-b" };
    const errors = await collectErrors([
      [stableA, stableB],
      [stableA, stableB],
      [stableA, stableB],
      [],
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("REPEATED_TOOL_CALLS");
  });

  it("does NOT abort when a single new call breaks the streak between repeats", async () => {
    const errors = await collectErrors([
      [sigGlob("src/**/*.ts")],
      [sigGlob("src/**/*.ts")],
      [sigRead("breaker.md")],
      [sigGlob("src/**/*.ts")],
      [sigGlob("src/**/*.ts")],
      [],
    ]);
    expect(errors).toEqual([]);
  });
});
