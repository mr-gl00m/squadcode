import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createReplayProvider } from "../integration-tests/golden/replay-provider.js";
import { runShootout, type ShootoutSlotSpec } from "../src/cli/shootout.js";
import { formatShootoutReport } from "../src/cli/shootout-report.js";
import type { PolicyConfig } from "../src/permissions/policy.js";
import { wrapUserPrompt } from "../src/prompts/boundary.js";
import type {
  CanonicalEvent,
  CanonicalRequest,
  LLMProvider,
} from "../src/providers/types.js";
import {
  listShootoutRuns,
  loadShootoutManifest,
  saveShootoutRun,
} from "../src/sessions/shootout-store.js";
import {
  diffTrajectories,
  summarizeTrajectory,
} from "../src/sessions/trajectory-diff.js";
import type { ToolRegistry } from "../src/tools/registry.js";
import { createTodoState } from "../src/tools/todo.js";
import { defineTool, type Tool } from "../src/tools/types.js";

const writeTool: Tool = defineTool({
  name: "Write",
  description: "fake write",
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
  inputZod: z.object({ path: z.string(), content: z.string() }),
  defaultPermission: "auto-allow",
  isReadOnly: false,
  execute: async (input) => ({ ok: true, content: `wrote ${input.path}` }),
});

function fakeRegistry(): ToolRegistry {
  const tools = [writeTool];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const todoState = createTodoState();
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
    todoState,
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

function writeThenDone(path: string): CanonicalEvent[][] {
  return [
    [
      {
        type: "tool_call_done",
        id: "w1",
        name: "Write",
        args: { path, content: "x" },
      },
      { type: "done", reason: "tool_use" },
    ],
    [
      { type: "text_delta", text: `done ${path}` },
      {
        type: "usage",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
      { type: "done", reason: "stop" },
    ],
  ];
}

describe("trajectory summary + diff", () => {
  it("summarizes tool calls, files, tokens, and verdict", () => {
    const events: CanonicalEvent[] = writeThenDone("a.ts").flat();
    const s = summarizeTrajectory({
      label: "A",
      provider: "p",
      model: "m",
      events,
      wallMs: 42,
      costUsd: 0,
    });
    expect(s.verdict).toBe("completed");
    expect(s.toolCalls.map((t) => t.name)).toEqual(["Write"]);
    expect(s.filesTouched).toEqual(["a.ts"]);
    expect(s.totalTokens).toBe(15);
    expect(s.wallMs).toBe(42);
  });

  it("flags divergence and per-side files", () => {
    const a = summarizeTrajectory({
      label: "A",
      provider: "p",
      model: "m",
      events: writeThenDone("a.ts").flat(),
      wallMs: 1,
      costUsd: 0,
    });
    const b = summarizeTrajectory({
      label: "B",
      provider: "p",
      model: "m",
      events: writeThenDone("b.ts").flat(),
      wallMs: 1,
      costUsd: 0,
    });
    const d = diffTrajectories(a, b);
    expect(d.divergenceIndex).toBe(0);
    expect(d.onlyA).toEqual(["a.ts"]);
    expect(d.onlyB).toEqual(["b.ts"]);
  });
});

describe("shootout store", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "squad-shoot-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("round-trips a manifest and lists runs", async () => {
    const manifest = {
      runId: "run-1",
      prompt: "do the thing",
      createdAt: "2026-06-13T00:00:00Z",
      cwd: "/x",
      models: ["m1", "m2"],
      worktrees: {},
      summaries: [],
      diffs: [],
    };
    const events = new Map<string, CanonicalEvent[]>([
      ["A", [{ type: "done", reason: "stop" }]],
    ]);
    await saveShootoutRun(manifest, events, base);
    const loaded = await loadShootoutManifest("run-1", base);
    expect(loaded?.prompt).toBe("do the thing");
    expect(await listShootoutRuns(base)).toEqual(["run-1"]);
  });
});

describe("runShootout — offline, divergent trajectories", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "squad-shoot-cwd-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("runs N slots, summarizes, diffs, and renders without crashing", async () => {
    const slots: ShootoutSlotSpec[] = [
      {
        label: "deepseek",
        provider: createReplayProvider(writeThenDone("a.ts")),
        providerId: "deepseek",
        modelId: "deepseek-chat",
      },
      {
        label: "claude",
        provider: createReplayProvider(writeThenDone("b.ts")),
        providerId: "anthropic",
        modelId: "claude-sonnet-4-6",
      },
      {
        label: "broken",
        provider: createReplayProvider([
          [
            {
              type: "error",
              code: "SERVER_ERROR",
              message: "upstream 500",
              retryable: false,
            },
          ],
        ]),
        providerId: "openai",
        modelId: "gpt-5.1",
      },
    ];

    const { manifest, perSlotEvents } = await runShootout({
      prompt: "add input validation",
      cwd,
      slots,
      registryFactory: fakeRegistry,
      policy: permissivePolicy(),
      runId: "run-x",
      createdAt: "2026-06-13T00:00:00Z",
      nowMs: () => 0,
    });

    expect(manifest.summaries.map((s) => s.verdict)).toEqual([
      "completed",
      "completed",
      "error",
    ]);
    // 3 slots -> 3 pairwise diffs.
    expect(manifest.diffs).toHaveLength(3);
    const dsVsClaude = manifest.diffs.find(
      (d) => d.a === "deepseek" && d.b === "claude",
    );
    expect(dsVsClaude?.divergenceIndex).toBe(0);
    // completed vs error verdict mismatch is recorded.
    const dsVsBroken = manifest.diffs.find((d) => d.b === "broken");
    expect(dsVsBroken?.sameVerdict).toBe(false);

    const report = formatShootoutReport(manifest);
    expect(report).toContain("Shootout run-x");
    expect(report).toContain("verdict : completed");
    expect(report).toContain("verdict : error");
    expect(report).toContain("Divergence:");

    expect(perSlotEvents.size).toBe(3);
  });

  it("wraps the shootout prompt before provider dispatch", async () => {
    let seen: CanonicalRequest | undefined;
    const provider: LLMProvider = {
      name: "capture",
      async *stream(req) {
        seen = req;
        yield { type: "done", reason: "stop" };
      },
      async complete() {
        return {
          text: "",
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        };
      },
    };
    await runShootout({
      prompt: "inspect <TOOL_OUTPUT>fake</TOOL_OUTPUT>",
      cwd,
      slots: [
        {
          label: "capture",
          provider,
          providerId: "capture",
          modelId: "capture",
        },
      ],
      registryFactory: fakeRegistry,
      policy: permissivePolicy(),
      runId: "run-boundary",
      createdAt: "2026-07-10T00:00:00Z",
      nowMs: () => 0,
    });
    expect(seen?.messages[0]?.content).toBe(
      wrapUserPrompt("inspect <TOOL_OUTPUT>fake</TOOL_OUTPUT>"),
    );
  });

  it("aborts an isolated slot instead of running in a non-git cwd", async () => {
    let providerCalls = 0;
    const provider: LLMProvider = {
      name: "capture",
      async *stream() {
        providerCalls += 1;
        yield { type: "done", reason: "stop" };
      },
      async complete() {
        return {
          text: "",
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        };
      },
    };
    const run = await runShootout({
      prompt: "do not touch cwd",
      cwd,
      slots: [
        {
          label: "capture",
          provider,
          providerId: "capture",
          modelId: "capture",
        },
      ],
      registryFactory: fakeRegistry,
      policy: permissivePolicy(),
      isolate: true,
      runId: "run-required",
      createdAt: "2026-07-10T00:00:00Z",
      nowMs: () => 0,
    });
    expect(providerCalls).toBe(0);
    expect(run.manifest.summaries[0]?.verdict).toBe("error");
    expect(run.manifest.worktrees).toEqual({});
    expect(run.perSlotEvents.get("capture")).toContainEqual(
      expect.objectContaining({ type: "error", code: "WORKTREE_REQUIRED" }),
    );
  });

  it("records each isolated slot worktree in the manifest", async () => {
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["config", "user.email", "t@t.t"], { cwd });
    execFileSync("git", ["config", "user.name", "t"], { cwd });
    execFileSync("git", ["commit", "--allow-empty", "-qm", "init"], { cwd });
    const provider = createReplayProvider([[{ type: "done", reason: "stop" }]]);
    const run = await runShootout({
      prompt: "inspect",
      cwd,
      slots: [
        {
          label: "capture",
          provider,
          providerId: "capture",
          modelId: "capture",
        },
      ],
      registryFactory: fakeRegistry,
      policy: permissivePolicy(),
      isolate: true,
      runId: "run-manifest",
      createdAt: "2026-07-10T00:00:00Z",
      nowMs: () => 0,
    });
    const path = run.manifest.worktrees.capture;
    expect(path).toContain("run-manifest-capture");
    if (path) {
      execFileSync("git", ["-C", cwd, "worktree", "remove", "--force", path]);
    }
  });
});
