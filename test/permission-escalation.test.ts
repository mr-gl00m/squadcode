import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runAgentLoop } from "../src/engine/loop.js";
import {
  appendRule,
  type PolicyConfig,
  type RuleMap,
} from "../src/permissions/policy.js";
import type {
  PromptOutcome,
  PromptRequest,
} from "../src/permissions/prompt.js";
import type {
  CanonicalEvent,
  CanonicalRequest,
  CanonicalResponse,
  LLMProvider,
} from "../src/providers/types.js";
import type { ToolRegistry } from "../src/tools/registry.js";
import { defineTool } from "../src/tools/types.js";

function retryingProvider(): LLMProvider {
  let turn = 0;
  return {
    name: "retrying",
    async *stream(_req: CanonicalRequest): AsyncIterable<CanonicalEvent> {
      turn += 1;
      if (turn <= 2) {
        yield {
          type: "tool_call_done",
          id: `write-${turn}`,
          name: "Write",
          args: { path: "blocked.txt", content: "must not run" },
        };
        yield { type: "done", reason: "tool_use" };
        return;
      }
      yield { type: "done", reason: "stop" };
    },
    async complete(): Promise<CanonicalResponse> {
      throw new Error("not used");
    },
  };
}

function registry(executions: { count: number }): ToolRegistry {
  const write = defineTool({
    name: "Write",
    description: "test write",
    inputSchema: { type: "object" },
    inputZod: z.object({ path: z.string(), content: z.string() }),
    defaultPermission: "ask",
    isReadOnly: false,
    execute: async () => {
      executions.count += 1;
      return { ok: true, content: "executed" };
    },
  });
  return {
    get: (name) => (name === write.name ? write : undefined),
    list: () => [write],
    toCanonicalSpecs: () => [],
    deferredCatalog: () => [],
    isLoaded: () => false,
    markLoaded: () => false,
    markLoadedFromMessages: () => undefined,
    loadedDeferredNames: () => [],
    todoState: { todos: [] } as unknown as ToolRegistry["todoState"],
  };
}

function patchFor(paths: string[]): string {
  return paths
    .map((path) => `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+content`)
    .join("\n");
}

function patchProvider(): LLMProvider {
  const calls = [
    ["src/a.ts", "src/b.ts"],
    ["src/a.ts", "src/b.ts"],
    ["src/b.ts", "src/c.ts"],
  ];
  let turn = 0;
  return {
    name: "patch-approval",
    async *stream(_req: CanonicalRequest): AsyncIterable<CanonicalEvent> {
      const paths = calls[turn];
      turn += 1;
      if (paths) {
        yield {
          type: "tool_call_done",
          id: `patch-${turn}`,
          name: "ApplyPatch",
          args: { patch: patchFor(paths) },
        };
        yield { type: "done", reason: "tool_use" };
        return;
      }
      yield { type: "done", reason: "stop" };
    },
    async complete(): Promise<CanonicalResponse> {
      throw new Error("not used");
    },
  };
}

function patchRegistry(executions: { count: number }): ToolRegistry {
  const applyPatch = defineTool({
    name: "ApplyPatch",
    description: "test patch",
    inputSchema: { type: "object" },
    inputZod: z.object({ patch: z.string() }),
    defaultPermission: "ask",
    isReadOnly: false,
    execute: async () => {
      executions.count += 1;
      return { ok: true, content: "executed" };
    },
  });
  return {
    get: (name) => (name === applyPatch.name ? applyPatch : undefined),
    list: () => [applyPatch],
    toCanonicalSpecs: () => [],
    deferredCatalog: () => [],
    isLoaded: () => false,
    markLoaded: () => false,
    markLoadedFromMessages: () => undefined,
    loadedDeferredNames: () => [],
    todoState: { todos: [] } as unknown as ToolRegistry["todoState"],
  };
}

describe("permission escalation invariant", () => {
  it("keeps an explicit deny across a retried tool call", async () => {
    const rules: RuleMap = new Map();
    appendRule(rules, "Write", { pattern: "*", action: "deny" });
    const policy: PolicyConfig = {
      defaultMode: "ask",
      rules,
      dangerouslySkipPermissions: true,
      mode: "act",
    };
    const executions = { count: 0 };
    const results: CanonicalEvent[] = [];
    for await (const event of runAgentLoop({
      provider: retryingProvider(),
      model: "test",
      messages: [{ role: "user", content: "try twice" }],
      registry: registry(executions),
      policy,
      cwd: process.cwd(),
      abort: new AbortController().signal,
      askPermission: async () => {
        throw new Error("a deny rule must not prompt");
      },
    })) {
      results.push(event);
    }

    expect(executions.count).toBe(0);
    expect(
      results.filter(
        (event) => event.type === "tool_result" && event.reason === "denied",
      ),
    ).toHaveLength(2);
  });

  it("re-prompts when a multi-file patch only partially overlaps a session grant", async () => {
    const executions = { count: 0 };
    const prompts: PromptRequest[] = [];
    const outcomes: PromptOutcome[] = ["always-allow", "deny"];
    const policy: PolicyConfig = {
      defaultMode: "ask",
      rules: new Map(),
      dangerouslySkipPermissions: false,
      mode: "act",
    };

    for await (const _event of runAgentLoop({
      provider: patchProvider(),
      model: "test",
      messages: [{ role: "user", content: "patch files" }],
      registry: patchRegistry(executions),
      policy,
      cwd: process.cwd(),
      abort: new AbortController().signal,
      askPermission: async (request) => {
        prompts.push(request);
        return outcomes.shift() ?? "deny";
      },
    })) {
      // Drain the loop.
    }

    expect(executions.count).toBe(2);
    expect(prompts.map((request) => request.scopePatterns)).toEqual([
      ["src/a.ts", "src/b.ts"],
      ["src/b.ts", "src/c.ts"],
    ]);
  });
});
