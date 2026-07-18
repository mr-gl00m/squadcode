import { describe, expect, it } from "vitest";
import type { CanonicalEvent } from "../../src/providers/types.js";
import { loadFixture, runGolden } from "./harness.js";

function types(events: CanonicalEvent[]): string[] {
  return events.map((e) => e.type);
}

function toolResults(events: CanonicalEvent[]) {
  return events.filter(
    (e): e is Extract<CanonicalEvent, { type: "tool_result" }> =>
      e.type === "tool_result",
  );
}

describe("golden replay — text-only", () => {
  it("emits the text and stops after one turn", async () => {
    const { events, provider } = await runGolden(loadFixture("text-only"));
    expect(provider.turnsConsumed).toBe(1);
    const text = events
      .filter(
        (e): e is Extract<CanonicalEvent, { type: "text_delta" }> =>
          e.type === "text_delta",
      )
      .map((e) => e.text)
      .join("");
    expect(text).toBe("Hello, world.");
    expect(types(events)).toContain("done");
    expect(toolResults(events)).toHaveLength(0);
  });
});

describe("golden replay — single-tool-call", () => {
  it("runs the tool, emits a successful tool_result, then the final text", async () => {
    const { events, provider } = await runGolden(
      loadFixture("single-tool-call"),
    );
    expect(provider.turnsConsumed).toBe(2);
    const results = toolResults(events);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: "echo", ok: true });
    // echo returns its args as JSON
    expect(results[0]?.content).toContain('"value":"hi"');
    const text = events
      .filter(
        (e): e is Extract<CanonicalEvent, { type: "text_delta" }> =>
          e.type === "text_delta",
      )
      .map((e) => e.text)
      .join("");
    expect(text).toBe("Echoed it.");
  });

  it("sends the tool catalog to the provider on each request", async () => {
    const { provider } = await runGolden(loadFixture("single-tool-call"));
    expect(provider.requests.length).toBe(2);
    const names = (provider.requests[0]?.tools ?? []).map((t) => t.name);
    expect(names).toContain("echo");
  });
});

describe("golden replay — tool-failure", () => {
  it("a single tool failure does not halt the loop", async () => {
    const { events, provider } = await runGolden(loadFixture("tool-failure"));
    expect(provider.turnsConsumed).toBe(2);
    const results = toolResults(events);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      name: "boom",
      ok: false,
      error: "BOOM",
    });
    // loop continued to the recovery turn
    const text = events
      .filter(
        (e): e is Extract<CanonicalEvent, { type: "text_delta" }> =>
          e.type === "text_delta",
      )
      .map((e) => e.text)
      .join("");
    expect(text).toBe("Recovered.");
    // no fatal error event
    expect(types(events)).not.toContain("error");
  });
});

describe("golden replay — repeated-tool-call guard", () => {
  it("halts with REPEATED_TOOL_CALLS on the third identical call", async () => {
    const { events, provider } = await runGolden(
      loadFixture("repeated-tool-call"),
    );
    expect(provider.turnsConsumed).toBe(3);
    const errors = events.filter(
      (e): e is Extract<CanonicalEvent, { type: "error" }> =>
        e.type === "error",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("REPEATED_TOOL_CALLS");
    // the call executed on turns 0 and 1 only (turn 2 halts before executing)
    expect(toolResults(events)).toHaveLength(2);
  });
});

describe("golden replay — multi-tool-call in one turn", () => {
  it("dispatches every tool call in the turn, in order, then continues", async () => {
    const { events, provider } = await runGolden(
      loadFixture("multi-tool-call"),
    );
    expect(provider.turnsConsumed).toBe(2);
    const results = toolResults(events);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.id)).toEqual(["m1", "m2"]);
    expect(results.every((r) => r.name === "echo" && r.ok)).toBe(true);
    expect(results[0]?.content).toContain('"value":"first"');
    expect(results[1]?.content).toContain('"value":"second"');
    const text = events
      .filter(
        (e): e is Extract<CanonicalEvent, { type: "text_delta" }> =>
          e.type === "text_delta",
      )
      .map((e) => e.text)
      .join("");
    expect(text).toBe("Both done.");
    expect(types(events)).not.toContain("error");
  });
});

describe("golden replay — max_turns cap", () => {
  it("halts with MAX_TURNS once the turn budget is exhausted", async () => {
    const { events, provider } = await runGolden(loadFixture("max-turns"), {
      maxTurns: 3,
    });
    expect(provider.turnsConsumed).toBe(3);
    // Distinct-args calls each turn, all succeeding: neither the repeat-guard
    // nor the failure-guard fires, so the only halt is the turn cap.
    const results = toolResults(events);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ok)).toBe(true);
    const errors = events.filter(
      (e): e is Extract<CanonicalEvent, { type: "error" }> =>
        e.type === "error",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("MAX_TURNS");
  });
});

describe("golden replay — consecutive-failure guard", () => {
  it("halts with REPEATED_TOOL_FAILURES on the eighth failure", async () => {
    const { events, provider } = await runGolden(
      loadFixture("consecutive-failures"),
    );
    expect(provider.turnsConsumed).toBe(8);
    // Every fixture call fails but with fresh args, so the repeat-guard never
    // trips; the failure counter accumulates to the halt threshold.
    const results = toolResults(events);
    expect(results).toHaveLength(8);
    expect(results.every((r) => r.name === "boom" && !r.ok)).toBe(true);
    const errors = events.filter(
      (e): e is Extract<CanonicalEvent, { type: "error" }> =>
        e.type === "error",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("REPEATED_TOOL_FAILURES");
  });
});

describe("golden replay — generic invariants", () => {
  const all = [
    "text-only",
    "single-tool-call",
    "tool-failure",
    "repeated-tool-call",
    "multi-tool-call",
    "max-turns",
    "consecutive-failures",
  ];
  it("every fixture run terminates and every tool_result has a matching tool_call", async () => {
    for (const name of all) {
      const { events } = await runGolden(loadFixture(name));
      const startedIds = new Set(
        events
          .filter((e) => e.type === "tool_call_done")
          .map(
            (e) =>
              (e as Extract<CanonicalEvent, { type: "tool_call_done" }>).id,
          ),
      );
      for (const r of toolResults(events)) {
        expect(startedIds.has(r.id), `${name}: result ${r.id} has a call`).toBe(
          true,
        );
      }
    }
  });
});
