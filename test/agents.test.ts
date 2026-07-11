import { describe, expect, it } from "vitest";
import { createReplayProvider } from "../integration-tests/golden/replay-provider.js";
import {
  anguishBand,
  computeAnguish,
  createAnguishTracker,
} from "../src/agents/anguish.js";
import { createHowlBus, type HowlEvent } from "../src/agents/howl.js";
import { createIdentityPool } from "../src/agents/identity.js";
import { killAgent, killAllAgents } from "../src/agents/kill.js";
import { parseAgentDef } from "../src/agents/loader.js";
import { resolveAgentRuleset } from "../src/agents/per-agent-rulesets.js";
import { createAgentRegistry } from "../src/agents/registry.js";
import {
  buildSubagentRegistry,
  matchesToolFilter,
} from "../src/agents/registry-build.js";
import { createAgentRuntime } from "../src/agents/runtime.js";
import { deriveSubagentSessionPermission } from "../src/agents/subagent-permissions.js";
import type { SubagentRecord } from "../src/agents/types.js";
import { runAgentLoop } from "../src/engine/loop.js";
import {
  appendRule,
  type PolicyConfig,
  type RuleMap,
} from "../src/permissions/policy.js";
import { wrapUserPrompt } from "../src/prompts/boundary.js";
import {
  assembleSubagentSystemPrompt,
  formatSubagentReport,
  isScopeRefusal,
  parseSubagentReport,
} from "../src/prompts/subagent.js";
import type {
  CanonicalEvent,
  CanonicalMessage,
  CanonicalRequest,
} from "../src/providers/types.js";
import { createToolRegistry } from "../src/tools/registry.js";

type Turn = CanonicalEvent[];

function textTurn(text: string): Turn {
  return [
    { type: "text_delta", text },
    { type: "done", reason: "stop" },
  ];
}

function permissivePolicy(): PolicyConfig {
  return {
    defaultMode: "allow",
    rules: new Map(),
    dangerouslySkipPermissions: false,
    mode: "act",
  };
}

const RED_TEAM_REPORT = [
  "### SUMMARY",
  "Found 2 issues.",
  "",
  "### EVIDENCE",
  "- src/loop.ts:294 — failure guard halts at 8",
  "",
  "### CHANGES",
  "None.",
  "",
  "### RISKS",
  "- did not exercise the abort path",
  "",
  "### BLOCKERS",
  "None.",
].join("\n");

describe("identity pool", () => {
  it("never hands out a live designation, falling back to a scan on collision", () => {
    // rng pinned to 0 makes every random candidate "AA-1", forcing the
    // deterministic scan to find the next free id rather than spin.
    const pool = createIdentityPool(() => 0);
    const a = pool.allocate();
    const b = pool.allocate();
    expect(a).toBe("AA-1");
    expect(b).not.toBe(a);
    expect(pool.living().sort()).toEqual([a, b].sort());
    pool.release(a);
    expect(pool.living()).toEqual([b]);
  });

  it("produces two-letter+digit designations", () => {
    const pool = createIdentityPool();
    for (let i = 0; i < 20; i += 1) {
      expect(pool.allocate()).toMatch(/^[A-Z]{2}-[1-9]$/);
    }
  });
});

describe("anguish", () => {
  it("bands climb with pressure and stay in [0,1]", () => {
    expect(
      anguishBand(
        computeAnguish({ elapsedMs: 0, retries: 0, toolFailures: 0 }),
      ),
    ).toBe("calm");
    const high = computeAnguish({
      elapsedMs: 1000,
      deadlineMs: 1000,
      retries: 8,
      toolFailures: 8,
      ambiguity: 1,
    });
    expect(high).toBeLessThanOrEqual(1);
    expect(anguishBand(high)).toBe("terminal");
  });

  it("tracker accumulates failures and resets on success", () => {
    const t = createAnguishTracker({ startedAtMs: 0 });
    expect(t.value(0)).toBe(0);
    t.recordToolFailure();
    t.recordToolFailure();
    const after = t.value(0);
    expect(after).toBeGreaterThan(0);
    t.recordToolSuccess();
    expect(t.value(0)).toBe(0);
  });
});

describe("howl bus", () => {
  it("buffers until commit, then delivers as one batch", () => {
    const bus = createHowlBus();
    const batches: HowlEvent[][] = [];
    bus.subscribe((evs) => batches.push(evs));
    bus.publish({ kind: "roster", living: ["AA-1"] });
    bus.publish({ kind: "roster", living: ["AA-1", "BB-2"] });
    expect(batches).toHaveLength(0);
    bus.commit();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it("emit delivers immediately and a thrown listener does not break the bus", () => {
    const bus = createHowlBus();
    let got = 0;
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe(() => {
      got += 1;
    });
    bus.emit({ kind: "roster", living: [] });
    expect(got).toBe(1);
  });
});

describe("agent slot registry", () => {
  it("hands out slots up to the ceiling then returns null", () => {
    const reg = createAgentRegistry({ maxSlots: 2 });
    expect(reg.claimSlot()).toBe(1);
    expect(reg.claimSlot()).toBe(2);
    expect(reg.claimSlot()).toBeNull();
    expect(reg.freeSlots()).toBe(0);
  });

  it("frees a slot when a record leaves running", () => {
    const reg = createAgentRegistry({ maxSlots: 1 });
    const slot = reg.claimSlot();
    const record: SubagentRecord = {
      id: "AA-1",
      type: "red-team",
      slotKey: slot ?? 1,
      model: "m",
      provider: "p",
      task: "t",
      status: "running",
      anguish: 0,
      startedAt: "now",
    };
    reg.register(record);
    expect(reg.claimSlot()).toBeNull();
    reg.update("AA-1", { status: "completed" });
    expect(reg.freeSlots()).toBe(1);
    expect(reg.living()).toHaveLength(0);
  });
});

describe("tool filter + subagent registry", () => {
  it("matches wildcards, prefixes, and exact names", () => {
    expect(matchesToolFilter("Read", ["*"])).toBe(true);
    expect(matchesToolFilter("mcp_github_create", ["mcp_*"])).toBe(true);
    expect(matchesToolFilter("mcp_github_create", ["mcp_github_*"])).toBe(true);
    expect(matchesToolFilter("Write", ["Read", "Grep"])).toBe(false);
  });

  it("clones the parent tools minus the Agent tool, honoring the allowlist", () => {
    const base = createToolRegistry({
      agentHost: {
        defs: () =>
          new Map([["x", { name: "x", description: "d", systemPrompt: "s" }]]),
        spawn: async () => {
          throw new Error("unused");
        },
      },
    });
    expect(base.get("Agent")).toBeDefined();
    const child = buildSubagentRegistry(base, {
      name: "red-team",
      description: "d",
      systemPrompt: "s",
      tools: ["Read", "Grep", "Agent"],
    });
    expect(child.get("Read")).toBeDefined();
    expect(child.get("Grep")).toBeDefined();
    // depth=1: the Agent tool is never cloned into a child, even if listed.
    expect(child.get("Agent")).toBeUndefined();
    expect(child.get("Write")).toBeUndefined();
  });
});

describe("subagent permissions", () => {
  it("forwards parent denies and defaults TodoWrite/Agent to denied", () => {
    const parentSessionRules: RuleMap = new Map();
    appendRule(parentSessionRules, "Shell", { pattern: "*", action: "deny" });
    appendRule(parentSessionRules, "Read", { pattern: "*", action: "allow" });
    const derived = deriveSubagentSessionPermission({ parentSessionRules });
    // The deny forwarded; the allow did NOT (children re-earn grants).
    expect(derived.get("Shell")?.[0]?.action).toBe("deny");
    expect(derived.get("Read")).toBeUndefined();
    expect(derived.get("TodoWrite")?.[0]?.action).toBe("deny");
    expect(derived.get("Agent")?.[0]?.action).toBe("deny");
  });

  it("does not re-deny a tool the subagent ruleset explicitly allows", () => {
    const subagentRules: RuleMap = new Map();
    appendRule(subagentRules, "TodoWrite", { pattern: "*", action: "allow" });
    const derived = deriveSubagentSessionPermission({ subagentRules });
    expect(derived.get("TodoWrite")).toBeUndefined();
    expect(derived.get("Agent")?.[0]?.action).toBe("deny");
  });
});

describe("per-agent ruleset", () => {
  it("merges defaults under agent rules under user override", () => {
    const defaults: RuleMap = new Map();
    appendRule(defaults, "Read", { pattern: "*", action: "allow" });
    const agentRules: RuleMap = new Map();
    appendRule(agentRules, "Write", { pattern: "**/*.md", action: "allow" });
    const merged = resolveAgentRuleset({ defaults, agentRules });
    expect(merged.get("Read")).toBeDefined();
    expect(merged.get("Write")).toBeDefined();
  });
});

describe("subagent report parsing", () => {
  it("splits the five sections, dropping None placeholders", () => {
    const r = parseSubagentReport(RED_TEAM_REPORT);
    expect(r.summary).toBe("Found 2 issues.");
    expect(r.evidence).toEqual(["src/loop.ts:294 — failure guard halts at 8"]);
    expect(r.changes).toEqual([]);
    expect(r.risks).toEqual(["did not exercise the abort path"]);
    expect(r.blockers).toEqual([]);
  });

  it("falls back to whole-text summary when unformatted", () => {
    const r = parseSubagentReport("just some prose");
    expect(r.summary).toBe("just some prose");
    expect(r.raw).toBe("just some prose");
  });

  it("detects a scope refusal in BLOCKERS", () => {
    const r = parseSubagentReport(
      "### SUMMARY\nNope.\n\n### BLOCKERS\nSCOPE_REFUSED: was asked to also refactor",
    );
    expect(isScopeRefusal(r)).toBe(true);
  });

  it("round-trips through formatSubagentReport", () => {
    const r = parseSubagentReport(RED_TEAM_REPORT);
    const formatted = formatSubagentReport(r);
    expect(formatted).toContain("### SUMMARY");
    expect(formatted).toContain("Found 2 issues.");
    expect(formatted).toContain("### CHANGES\nNone.");
  });

  it("scope lock and report contract are in the assembled system prompt", () => {
    const prompt = assembleSubagentSystemPrompt({
      name: "red-team",
      description: "d",
      systemPrompt: "You are red-team.",
    });
    expect(prompt).toContain("You are red-team.");
    expect(prompt).toContain("scope lock");
    expect(prompt).toContain("### SUMMARY");
    // Anguish must never leak into the prompt.
    expect(prompt.toLowerCase()).not.toContain("anguish");
  });
});

describe("agent loader frontmatter", () => {
  it("parses fields, tool lists, and the body as system prompt", () => {
    const def = parseAgentDef(
      [
        "---",
        "name: red-team",
        "description: adversarial reviewer",
        "whenToUse: hostile read of a diff",
        "tools: Read, Grep, Shell",
        "model: deepseek-v4-pro",
        "provider: deepseek",
        "---",
        "You are a red-team reviewer.",
      ].join("\n"),
      "fallback",
    );
    expect(def).not.toBeNull();
    expect(def?.name).toBe("red-team");
    expect(def?.tools).toEqual(["Read", "Grep", "Shell"]);
    expect(def?.model).toBe("deepseek-v4-pro");
    expect(def?.provider).toBe("deepseek");
    expect(def?.systemPrompt).toBe("You are a red-team reviewer.");
  });

  it("returns null without frontmatter", () => {
    expect(parseAgentDef("no frontmatter here", "x")).toBeNull();
  });
});

describe("kill", () => {
  it("stamps user_killed and aborts the controller", () => {
    const reg = createAgentRegistry();
    const controllers = new Map<string, AbortController>();
    const ac = new AbortController();
    controllers.set("AA-1", ac);
    reg.register({
      id: "AA-1",
      type: "x",
      slotKey: reg.claimSlot() ?? 1,
      model: "m",
      provider: "p",
      task: "t",
      status: "running",
      anguish: 0,
      startedAt: "now",
    });
    expect(killAgent(reg, controllers, "AA-1")).toBe(true);
    expect(ac.signal.aborted).toBe(true);
    expect(reg.get("AA-1")?.status).toBe("user_killed");
    // A second kill is a no-op (already terminal).
    expect(killAgent(reg, controllers, "AA-1")).toBe(false);
    expect(killAllAgents(reg, controllers)).toEqual([]);
  });
});

describe("subagent spawn — integration smoke", () => {
  it("parent spawns a subagent, runs it, and continues with the payload only", async () => {
    // The subagent's provider yields one turn: the structured report. The
    // parent's provider yields an Agent call, then a final reply.
    let childRequest: CanonicalRequest | undefined;
    const bundle = createAgentRuntime({
      agentDefs: new Map([
        [
          "red-team",
          {
            name: "red-team",
            description: "adversarial reviewer",
            systemPrompt: "You are red-team.",
            tools: ["Read", "Grep"],
          },
        ],
      ]),
      makeProvider: () => {
        const replay = createReplayProvider([textTurn(RED_TEAM_REPORT)]);
        return {
          ...replay,
          async *stream(req: CanonicalRequest) {
            childRequest = req;
            yield* replay.stream(req);
          },
        };
      },
      cwd: process.cwd(),
      parentAbort: new AbortController().signal,
      defaultProvider: "replay",
      defaultModel: "replay-model",
      basePolicy: permissivePolicy(),
      responder: async () => "allow",
    });
    const registry = createToolRegistry({ agentHost: bundle.host });
    bundle.setBaseRegistry(registry);

    const spawned: HowlEvent[] = [];
    bundle.howl.subscribe((evs) => spawned.push(...evs));

    const parent = createReplayProvider([
      [
        {
          type: "tool_call_done",
          id: "call-1",
          name: "Agent",
          args: {
            description: "red team",
            prompt: "Audit the loop guard.",
            subagent_type: "red-team",
          },
        },
        { type: "done", reason: "tool_use" },
      ],
      textTurn("The red-team agent found 2 issues; proceeding."),
    ]);

    const messages: CanonicalMessage[] = [
      { role: "user", content: "review it" },
    ];
    const events: CanonicalEvent[] = [];
    for await (const ev of runAgentLoop({
      provider: parent,
      model: "parent-model",
      messages,
      registry,
      policy: permissivePolicy(),
      cwd: process.cwd(),
      abort: new AbortController().signal,
      askPermission: async () => "allow",
    })) {
      events.push(ev);
    }

    const toolResults = events.filter(
      (e): e is Extract<CanonicalEvent, { type: "tool_result" }> =>
        e.type === "tool_result",
    );
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.name).toBe("Agent");
    expect(toolResults[0]?.ok).toBe(true);
    // The parent receives the structured report — and only that.
    expect(toolResults[0]?.content).toContain("Found 2 issues.");
    expect(toolResults[0]?.content).toContain("### EVIDENCE");

    // Memory ephemerality: the subagent's own working messages ("You are
    // red-team.", its raw turn) never appear in the parent transcript. The
    // parent only holds user + assistant(Agent call) + tool + assistant(final).
    expect(messages).toHaveLength(4);
    const joined = messages.map((m) => m.content).join("\n");
    expect(joined).not.toContain("You are red-team.");

    // The run is recorded, completed, on its own model.
    const record = bundle.slotRegistry.list()[0];
    expect(record?.status).toBe("completed");
    expect(record?.type).toBe("red-team");
    expect(record?.report?.summary).toBe("Found 2 issues.");
    expect(childRequest?.messages[0]?.content).toBe(
      wrapUserPrompt("Audit the loop guard."),
    );
    expect(childRequest?.system).toContain("<USER_PROMPT>");

    // HOWL announced the lifecycle.
    expect(spawned.some((e) => e.kind === "spawned")).toBe(true);
    expect(spawned.some((e) => e.kind === "terminated")).toBe(true);
  });

  it("fails fast when all slots are occupied", async () => {
    const bundle = createAgentRuntime({
      agentDefs: new Map([
        ["x", { name: "x", description: "d", systemPrompt: "s" }],
      ]),
      makeProvider: () => createReplayProvider([textTurn("### SUMMARY\nok")]),
      cwd: process.cwd(),
      parentAbort: new AbortController().signal,
      defaultProvider: "replay",
      defaultModel: "m",
      basePolicy: permissivePolicy(),
      responder: async () => "allow",
      maxSlots: 1,
    });
    const registry = createToolRegistry({ agentHost: bundle.host });
    bundle.setBaseRegistry(registry);
    // Occupy the only slot by hand.
    expect(bundle.slotRegistry.claimSlot()).toBe(1);
    await expect(
      bundle.host.spawn(
        { name: "x", description: "d", systemPrompt: "s" },
        "go",
      ),
    ).rejects.toThrow(/slots are occupied/);
  });
});
