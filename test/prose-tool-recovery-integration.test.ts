import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runAgentLoop } from "../src/engine/loop.js";
import type { PolicyConfig } from "../src/permissions/policy.js";
import { wrapProviderWithProseRecovery } from "../src/providers/prose-tool-recovery.js";
import type {
  CanonicalEvent,
  CanonicalResponse,
  LLMProvider,
} from "../src/providers/types.js";
import type { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";

// Golden offline integration: a local-model-style provider that emits a tool
// call as assistant *prose* (Hermes <tool_call> shape) drives a real agent loop
// all the way to a tool_result; no provider credentials, no network. This is
// the exact failure mode the recovery layer exists to rescue: streamed text
// that a native adapter would leave as "no tool calls".

function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

// A provider whose turns are plain assistant text. Turn 0 contains a prose tool
// call; turn 1 is a plain answer that ends the loop. Wrapped in recovery so the
// loop sees a canonical tool_call_done, exactly like a native provider.
function makeProseProvider(turns: string[]): LLMProvider {
  let i = 0;
  const base: LLMProvider = {
    name: "ollama",
    async *stream(): AsyncIterable<CanonicalEvent> {
      const text = turns[i] ?? "";
      i += 1;
      for (const piece of chunk(text, 7)) {
        yield { type: "text_delta", text: piece };
      }
      yield {
        type: "usage",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
      yield { type: "done", reason: "stop" };
    },
    async complete(): Promise<CanonicalResponse> {
      throw new Error("not used");
    },
  };
  return wrapProviderWithProseRecovery(base);
}

function makeEchoRegistry(executed: unknown[]): ToolRegistry {
  const echoTool: Tool = {
    name: "echo",
    description: "echoes its args",
    inputSchema: { type: "object" },
    inputZod: z.unknown(),
    defaultPermission: "auto-allow",
    isReadOnly: true,
    execute: async (args) => {
      executed.push(args);
      return { ok: true, content: `echoed ${JSON.stringify(args)}` };
    },
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

describe("prose tool recovery: offline golden integration", () => {
  it("drives a prose <tool_call> through the agent loop to a tool_result", async () => {
    const executed: unknown[] = [];
    const provider = makeProseProvider([
      'On it. <tool_call>{"name":"echo","arguments":{"kind":"read","path":"a.md"}}</tool_call>',
      "The file is fine. Done.",
    ]);

    const events: CanonicalEvent[] = [];
    const ctrl = new AbortController();
    for await (const ev of runAgentLoop({
      provider,
      model: "test",
      messages: [{ role: "user", content: "read a.md" }],
      registry: makeEchoRegistry(executed),
      policy,
      cwd: process.cwd(),
      abort: ctrl.signal,
      maxTurns: 10,
    })) {
      events.push(ev);
    }

    // The recovered call reached execution with the parsed args.
    expect(executed).toEqual([{ kind: "read", path: "a.md" }]);

    // A canonical tool_call_done for echo was produced from the prose.
    const done = events.filter(
      (e): e is Extract<CanonicalEvent, { type: "tool_call_done" }> =>
        e.type === "tool_call_done",
    );
    expect(done.map((d) => d.name)).toEqual(["echo"]);

    // A tool_result came back ok.
    const results = events.filter(
      (e): e is Extract<CanonicalEvent, { type: "tool_result" }> =>
        e.type === "tool_result",
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.name).toBe("echo");

    // The wrapper never leaked into visible assistant text.
    const visible = events
      .filter(
        (e): e is Extract<CanonicalEvent, { type: "text_delta" }> =>
          e.type === "text_delta",
      )
      .map((e) => e.text)
      .join("");
    expect(visible).toContain("On it.");
    expect(visible).toContain("Done.");
    expect(visible).not.toContain("<tool_call");
  });
});
