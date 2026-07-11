import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createReplayProvider } from "../integration-tests/golden/replay-provider.js";
import { runAgentLoop } from "../src/engine/loop.js";
import type { PolicyConfig } from "../src/permissions/policy.js";
import type {
  CanonicalEvent,
  CanonicalMessage,
} from "../src/providers/types.js";
import { TurnDiffTracker } from "../src/sessions/trajectory-diff.js";
import { createToolRegistry } from "../src/tools/registry.js";

function permissivePolicy(): PolicyConfig {
  return {
    defaultMode: "allow",
    rules: new Map(),
    dangerouslySkipPermissions: false,
    mode: "act",
  };
}

function toolUse(id: string, name: string, args: unknown): CanonicalEvent[] {
  return [
    { type: "tool_call_done", id, name, args },
    { type: "done", reason: "tool_use" },
  ];
}

describe("per-turn diff tracker", () => {
  it("renders the net mutation rather than intermediate edits", () => {
    const cwd = process.cwd();
    const path = join(cwd, "a.txt");
    const tracker = new TurnDiffTracker({ cwd });
    tracker.record([{ path, before: "one\n", after: "two\n" }]);
    tracker.record([{ path, before: "two\n", after: "three\n" }]);
    const diff = tracker.render();
    expect(diff).toContain("--- a/a.txt");
    expect(diff).toContain("-one");
    expect(diff).toContain("+three");
    expect(diff).not.toContain("two");
  });

  it("falls back to changed paths when the compute budget expires", () => {
    let now = 0;
    const tracker = new TurnDiffTracker({
      cwd: process.cwd(),
      budgetMs: 100,
      nowMs: () => (now += 101),
    });
    tracker.record([
      {
        path: join(process.cwd(), "slow.txt"),
        before: "same\na",
        after: "same\nb",
      },
    ]);
    expect(tracker.render()).toContain("changed paths:\n- slow.txt");
  });

  it("receives committed Write mutations from the agent loop", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "squad-turn-diff-"));
    const tracker = new TurnDiffTracker({ cwd });
    const provider = createReplayProvider([
      toolUse("c1", "Write", { path: "made.txt", content: "hello\n" }),
      [{ type: "done", reason: "stop" }],
    ]);
    const messages: CanonicalMessage[] = [{ role: "user", content: "go" }];

    for await (const _event of runAgentLoop({
      provider,
      model: "m",
      messages,
      registry: createToolRegistry(),
      policy: permissivePolicy(),
      cwd,
      abort: new AbortController().signal,
      askPermission: async () => "allow",
      turnDiff: tracker,
    })) {
      // Drain the loop; the assertion is on the tracker.
    }

    const diff = tracker.render();
    expect(diff).toContain("--- /dev/null");
    expect(diff).toContain("+++ b/made.txt");
    expect(diff).toContain("+hello");
  });
});
