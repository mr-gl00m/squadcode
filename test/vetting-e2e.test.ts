import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createReplayProvider } from "../integration-tests/golden/replay-provider.js";
import { createAgentRuntime } from "../src/agents/runtime.js";
import type { SubagentDef } from "../src/agents/types.js";
import type { PolicyConfig } from "../src/permissions/policy.js";
import type { CanonicalEvent } from "../src/providers/types.js";
import type { ToolRegistry } from "../src/tools/registry.js";
import { createTodoState } from "../src/tools/todo.js";
import { defineTool, type Tool } from "../src/tools/types.js";

// A tool that always fails, so a replay script can drive a run's anguish up by
// scripting failures. Args carry an n so successive calls have distinct
// signatures (the loop's repeat-guard halts on 3 *identical* calls).
const boomTool: Tool = defineTool({
  name: "boom",
  description: "always fails",
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
  inputZod: z.object({ n: z.number() }),
  defaultPermission: "auto-allow",
  isReadOnly: true,
  execute: async () => ({ ok: false, content: "boom", error: "BOOM" }),
});

function boomRegistry(): ToolRegistry {
  const tools = [boomTool];
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    get: (n) => byName.get(n),
    list: () => tools,
    toCanonicalSpecs: () =>
      tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    deferredCatalog: () => [],
    isLoaded: () => false,
    markLoaded: () => false,
    markLoadedFromMessages: () => undefined,
    loadedDeferredNames: () => [],
    getManifest: () => null,
    getRepoMap: () => null,
    todoState: createTodoState(),
  };
}

function permissivePolicy(): PolicyConfig {
  return {
    defaultMode: "allow",
    rules: new Map(),
    dangerouslySkipPermissions: false,
    mode: "act",
  };
}

const REPORT = "### SUMMARY\ndone\n\n### BLOCKERS\nNone.";

function boomTurn(n: number): CanonicalEvent[] {
  return [
    { type: "tool_call_done", id: `b${n}`, name: "boom", args: { n } },
    { type: "done", reason: "tool_use" },
  ];
}
function reportTurn(): CanonicalEvent[] {
  return [
    { type: "text_delta", text: REPORT },
    { type: "done", reason: "stop" },
  ];
}

const def = (name: string, model: string): SubagentDef => ({
  name,
  description: "worker",
  model,
  tools: ["boom"],
  systemPrompt: "do the task",
});

describe("vetting E2E — same task across 3 backends, scored by terminal anguish", () => {
  it("anguish ranks the model that thrashed most highest", async () => {
    const bundle = createAgentRuntime({
      agentDefs: new Map([
        ["clean", def("clean", "clean")],
        ["flaky", def("flaky", "flaky")],
        ["broken", def("broken", "broken")],
      ]),
      // Same task, different backend behavior keyed by model id.
      makeProvider: (_provider, model) => {
        if (model === "clean") return createReplayProvider([reportTurn()]);
        if (model === "flaky")
          return createReplayProvider([boomTurn(1), reportTurn()]);
        return createReplayProvider([
          boomTurn(1),
          boomTurn(2),
          boomTurn(3),
          reportTurn(),
        ]);
      },
      cwd: process.cwd(),
      parentAbort: new AbortController().signal,
      defaultProvider: "replay",
      defaultModel: "m",
      basePolicy: permissivePolicy(),
      responder: async () => "allow",
    });
    bundle.setBaseRegistry(boomRegistry());

    // Dispatch all three concurrently — same prompt, different model backends.
    const defs = bundle.host.defs();
    const [clean, flaky, broken] = await Promise.all([
      bundle.host.spawn(defs.get("clean") as SubagentDef, "do the task"),
      bundle.host.spawn(defs.get("flaky") as SubagentDef, "do the task"),
      bundle.host.spawn(defs.get("broken") as SubagentDef, "do the task"),
    ]);

    // All three completed (failures didn't fatally halt at this count).
    expect(clean.record.status).toBe("completed");
    expect(flaky.record.status).toBe("completed");
    expect(broken.record.status).toBe("completed");

    // Terminal anguish is the vetting signal: more thrashing => higher anguish.
    // The clean run carries only a negligible time component (no failures).
    expect(clean.record.anguish).toBeLessThan(0.001);
    expect(flaky.record.anguish).toBeGreaterThan(clean.record.anguish);
    expect(broken.record.anguish).toBeGreaterThan(flaky.record.anguish);
  });
});
