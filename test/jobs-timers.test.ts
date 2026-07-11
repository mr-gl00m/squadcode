import { describe, expect, it } from "vitest";
import { createReplayProvider } from "../integration-tests/golden/replay-provider.js";
import { createAgentRuntime } from "../src/agents/runtime.js";
import { createDeadlineTimer } from "../src/deadline-timer.js";
import { createJobRegistry } from "../src/engine/job-registry.js";
import { runAgentLoop } from "../src/engine/loop.js";
import { makePreTurnInjector } from "../src/engine/pre-turn.js";
import { createTimerRegistry } from "../src/engine/timer-registry.js";
import type { PolicyConfig } from "../src/permissions/policy.js";
import type {
  CanonicalEvent,
  CanonicalMessage,
} from "../src/providers/types.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { shellTool } from "../src/tools/shell.js";
import type { ToolContext } from "../src/tools/types.js";

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

function textTurn(text: string): CanonicalEvent[] {
  return [
    { type: "text_delta", text },
    { type: "done", reason: "stop" },
  ];
}

describe("deadline timer", () => {
  it("tracks elapsed, expiry, and excludes paused spans", () => {
    const t = createDeadlineTimer({
      id: "t1",
      label: "x",
      durationMs: 1000,
      startedAtMs: 0,
    });
    expect(t.expired(500)).toBe(false);
    expect(t.remainingMs(500)).toBe(500);
    expect(t.expired(1000)).toBe(true);

    const p = createDeadlineTimer({
      id: "t2",
      label: "y",
      durationMs: 1000,
      startedAtMs: 0,
    });
    p.pause(200);
    // While paused, elapsed is frozen at 200 no matter the wall clock.
    expect(p.elapsedMs(5000)).toBe(200);
    p.resume(5000);
    expect(p.elapsedMs(5800)).toBe(1000);
    expect(p.expired(5800)).toBe(true);
  });
});

describe("timer registry", () => {
  it("sets, lists, cancels, and drains expired", () => {
    const reg = createTimerRegistry();
    const a = reg.set("watch", 1000, 0);
    reg.set("other", 5000, 0);
    expect(reg.list(0)).toHaveLength(2);
    expect(reg.cancel(a)).toBe(true);
    expect(reg.list(0)).toHaveLength(1);
    // Nothing expired at t=1000 (only "other" remains, 5000ms).
    expect(reg.drainExpired(1000)).toHaveLength(0);
    const fired = reg.drainExpired(6000);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.label).toBe("other");
    // Drained timers are gone.
    expect(reg.list(6000)).toHaveLength(0);
  });
});

describe("job registry", () => {
  it("creates, settles, waits, and reports once via drainSettled", async () => {
    const reg = createJobRegistry();
    const job = reg.create({ type: "shell", title: "build" });
    expect(reg.get(job.id)?.status).toBe("running");
    job.appendStdout("hello");
    const waited = job.wait();
    job.settle("completed", { exitCode: 0 });
    const info = await waited;
    expect(info.status).toBe("completed");
    expect(info.exitCode).toBe(0);
    expect(info.stdout).toBe("hello");
    // drainSettled surfaces it once, then never again.
    expect(reg.drainSettled().map((j) => j.id)).toEqual([job.id]);
    expect(reg.drainSettled()).toHaveLength(0);
  });

  it("cancel invokes onCancel and settles cancelled", () => {
    const reg = createJobRegistry();
    let cancelled = false;
    const job = reg.create({
      type: "shell",
      onCancel: () => {
        cancelled = true;
      },
    });
    expect(reg.cancel(job.id)).toBe(true);
    expect(cancelled).toBe(true);
    expect(reg.get(job.id)?.status).toBe("cancelled");
  });
});

describe("pre-turn injector", () => {
  it("injects fired timers and finished shell jobs, skips subagent jobs", async () => {
    const timers = createTimerRegistry();
    timers.set("watch", 1000, 0);
    const jobs = createJobRegistry();
    const shellJob = jobs.create({ type: "shell" });
    shellJob.settle("completed", { exitCode: 0 });
    const subJob = jobs.create({ type: "subagent", id: "KT-4" });
    subJob.settle("completed");

    const inject = makePreTurnInjector({
      timers,
      jobs,
      nowMs: () => 2000,
    });
    const msgs = await inject();
    expect(msgs).toHaveLength(1);
    const content = msgs[0]?.content ?? "";
    expect(content).toContain("TIMER_FIRED");
    expect(content).toContain('label="watch"');
    expect(content).toContain("JOB_FINISHED");
    // The subagent job is delivered via the Agent tool, not re-injected here.
    expect(content).not.toContain("KT-4");
    // Nothing pending now -> no-op.
    expect(await inject()).toHaveLength(0);
  });
});

describe("shell background mode", () => {
  it("returns a job handle and the job settles when the child exits", async () => {
    const jobs = createJobRegistry();
    const ctx: ToolContext = {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      callId: "c1",
      jobs,
    };
    const res = await shellTool.execute(
      { command: "node --version", background: true },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain("background job");
    const jobId = jobs.list()[0]?.id;
    expect(jobId).toBeDefined();
    const info = await jobs.wait(jobId as string);
    expect(info?.status).toBe("completed");
    expect(info?.exitCode).toBe(0);
    expect(info?.stdout ?? "").toMatch(/v\d+\./);
  });

  it("reports BACKGROUND_UNAVAILABLE when no job registry is present", async () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      callId: "c2",
    };
    const res = await shellTool.execute(
      { command: "node --version", background: true },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("BACKGROUND_UNAVAILABLE");
  });
});

describe("offline loop smoke — timer fires, model checks then kills a job", () => {
  it("injects TIMER_FIRED pre-turn, JobStatus sees running, JobKill cancels", async () => {
    const jobs = createJobRegistry();
    const timers = createTimerRegistry();
    // A standing 'npm install' job that never settles on its own.
    const install = jobs.create({ type: "shell", title: "npm install" });
    // A 'stuck' timer already past its deadline (set 5s ago, 1s budget).
    timers.set("install watch", 1000, Date.now() - 5000);

    const registry = createToolRegistry();
    const provider = createReplayProvider([
      toolUse("c1", "JobStatus", { jobId: install.id }),
      toolUse("c2", "JobKill", { jobId: install.id }),
      textTurn("Install was stuck; killed it."),
    ]);
    const messages: CanonicalMessage[] = [{ role: "user", content: "go" }];
    const events: CanonicalEvent[] = [];
    for await (const ev of runAgentLoop({
      provider,
      model: "m",
      messages,
      registry,
      policy: permissivePolicy(),
      cwd: process.cwd(),
      abort: new AbortController().signal,
      askPermission: async () => "allow",
      jobs,
      timers,
      injectPreTurn: makePreTurnInjector({ timers, jobs }),
    })) {
      events.push(ev);
    }

    // The fired timer was injected before the first request.
    const firstReq = provider.requests[0];
    const injected = (firstReq?.messages ?? []).some((m) =>
      m.content.includes("TIMER_FIRED"),
    );
    expect(injected).toBe(true);

    const results = events.filter(
      (e): e is Extract<CanonicalEvent, { type: "tool_result" }> =>
        e.type === "tool_result",
    );
    const status = results.find((r) => r.name === "JobStatus");
    expect(status?.content).toContain("status: running");
    const kill = results.find((r) => r.name === "JobKill");
    expect(kill?.ok).toBe(true);
    expect(jobs.get(install.id)?.status).toBe("cancelled");
  });
});

describe("offline loop smoke — parent watches a subagent with a timer", () => {
  it("spawns a subagent (registered as a job), then cancels the watch timer", async () => {
    const jobs = createJobRegistry();
    const timers = createTimerRegistry();
    const bundle = createAgentRuntime({
      agentDefs: new Map([
        ["red-team", { name: "red-team", description: "d", systemPrompt: "s" }],
      ]),
      makeProvider: () =>
        createReplayProvider([textTurn("### SUMMARY\nlooks fine")]),
      cwd: process.cwd(),
      parentAbort: new AbortController().signal,
      defaultProvider: "replay",
      defaultModel: "m",
      basePolicy: permissivePolicy(),
      responder: async () => "allow",
      parentJobs: jobs,
    });
    const registry = createToolRegistry({ agentHost: bundle.host });
    bundle.setBaseRegistry(registry);

    const provider = createReplayProvider([
      toolUse("c1", "SetTimer", { label: "stuck-if-no-return", ms: 1800000 }),
      toolUse("c2", "Agent", {
        description: "red team",
        prompt: "audit it",
        subagent_type: "red-team",
      }),
      toolUse("c3", "CancelTimer", { timerId: "timer_1" }),
      textTurn("Subagent returned in time."),
    ]);
    const messages: CanonicalMessage[] = [{ role: "user", content: "go" }];
    const events: CanonicalEvent[] = [];
    for await (const ev of runAgentLoop({
      provider,
      model: "m",
      messages,
      registry,
      policy: permissivePolicy(),
      cwd: process.cwd(),
      abort: new AbortController().signal,
      askPermission: async () => "allow",
      jobs,
      timers,
      injectPreTurn: makePreTurnInjector({ timers, jobs }),
    })) {
      events.push(ev);
    }

    // The subagent ran and was registered as a (now-settled) job in the
    // parent's registry under its KT-style id.
    const subagentJobs = jobs.list().filter((j) => j.type === "subagent");
    expect(subagentJobs).toHaveLength(1);
    expect(subagentJobs[0]?.status).toBe("completed");
    // The watch timer was cancelled before it could fire.
    expect(timers.list(0)).toHaveLength(0);
    const record = bundle.slotRegistry.list()[0];
    expect(record?.status).toBe("completed");
  });
});
