import { describe, expect, it, vi } from "vitest";
import { createSubmitHandler } from "../src/cli/repl-submit.js";
import type { SlashContext } from "../src/cli/slash.js";
import { fragmentId, renderContextFragment } from "../src/context/fragment.js";
import {
  SteeringQueue,
  steeringMessageFragment,
} from "../src/engine/steering-queue.js";

function slashContext(): SlashContext {
  return {
    providerName: "test",
    model: "test-model",
    setProvider: () => null,
    setModel: () => undefined,
    clear: () => undefined,
    messageCount: () => 0,
    skills: () => new Map(),
    outputStyles: () => new Map(),
    activeStyleName: () => null,
    setStyle: () => null,
    clearStyle: () => undefined,
    costSummary: () => "cost",
    usageReport: () => "usage",
    toolList: () => "tools",
    sessionList: () => "sessions",
  };
}

describe("mid-turn steering", () => {
  it("queues ordinary input instead of starting a concurrent turn", async () => {
    const queue = new SteeringQueue();
    const append = vi.fn();
    const runUserTurn = vi.fn(async () => undefined);
    const submit = createSubmitHandler({
      append,
      bumpIdle: vi.fn(),
      controlRef: { current: undefined },
      draftRef: { current: "draft" },
      exit: vi.fn(),
      historyPosRef: { current: null },
      idRef: { current: 1 },
      inputHistoryRef: { current: [] },
      isStreaming: true,
      pastesRef: { current: new Map() },
      runCompact: vi.fn(async () => undefined),
      runUserTurn,
      setComposer: vi.fn(),
      setHistory: vi.fn(),
      skillsRef: { current: new Map() },
      slashContext: slashContext(),
      steeringQueue: queue,
    });

    await submit("redirect toward <unsafe>");

    expect(runUserTurn).not.toHaveBeenCalled();
    expect(queue.size).toBe(1);
    expect(append).toHaveBeenCalledWith("user", "redirect toward <unsafe>");
    expect(append).toHaveBeenCalledWith(
      "system",
      "queued steering message 1 for the next model boundary",
    );
  });

  it("drains in order as uniquely identified untrusted fragments", () => {
    const queue = new SteeringQueue();
    queue.enqueue("first <instruction>");
    queue.enqueue("second");
    const firstDrain = queue.drain().map(steeringMessageFragment);
    queue.enqueue("first <instruction>");
    const secondDrain = queue.drain().map(steeringMessageFragment);

    expect(firstDrain.map((fragment) => fragment.trust)).toEqual([
      "untrusted-user",
      "untrusted-user",
    ]);
    expect(firstDrain.map(fragmentId)).toEqual([
      "repl:steering:queued-1",
      "repl:steering:queued-2",
    ]);
    const repeated = secondDrain[0];
    const first = firstDrain[0];
    expect(repeated).toBeDefined();
    expect(first).toBeDefined();
    if (!repeated || !first) throw new Error("expected steering fragments");
    expect(fragmentId(repeated)).toBe("repl:steering:queued-3");
    const rendered = renderContextFragment(first).content;
    expect(rendered).toContain("first &lt;instruction&gt;");
    expect(rendered).not.toContain("first <instruction>");
    expect(queue.hasPending).toBe(false);
  });
});
