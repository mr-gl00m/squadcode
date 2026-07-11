import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderContextFragment } from "../src/context/fragment.js";
import {
  HOOK_EVENTS,
  HookSchema,
  loadHooks,
  parseHooksFromSettings,
  TOOL_HOOK_EVENTS,
} from "../src/hooks/config.js";
import { matchesHook } from "../src/hooks/match.js";
import {
  createHookRunner,
  type HookContext,
  type HookFireResult,
  hookResultsFragment,
  runCommandHook,
  runHttpHook,
  validateHttpHookDestination,
} from "../src/hooks/runner.js";

describe("hook context fragments", () => {
  it("reports failed hooks as bounded untrusted context", () => {
    const context: HookContext = {
      event: "PostToolUseFailure",
      sessionId: "s1",
      cwd: process.cwd(),
      toolName: "Read",
      callId: "c1",
    };
    const fragment = hookResultsFragment(
      [
        {
          id: "notify",
          event: "PostToolUseFailure",
          ok: false,
          status: "<failed>",
          elapsedMs: 2,
        },
      ],
      context,
    );
    expect(fragment?.source).toBe("hooks");
    expect(fragment?.trust).toBe("untrusted-environment");
    if (!fragment) throw new Error("expected hook failure fragment");
    expect(renderContextFragment(fragment).content).toContain("&lt;failed&gt;");
  });

  it("does not inject successful hook results", () => {
    const fragment = hookResultsFragment(
      [
        {
          id: "notify",
          event: "PostToolUse",
          ok: true,
          status: "ok",
          elapsedMs: 1,
        },
      ],
      { event: "PostToolUse", sessionId: "s1", cwd: process.cwd() },
    );
    expect(fragment).toBeNull();
  });
});

describe("HookSchema validation", () => {
  it("accepts a minimal command hook", () => {
    const parsed = HookSchema.safeParse({
      id: "fmt",
      type: "command",
      event: "PostToolUse",
      command: "prettier --write",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a minimal http hook with optional fields", () => {
    const parsed = HookSchema.safeParse({
      id: "ping",
      type: "http",
      event: "SessionEnd",
      url: "https://example.test/ping",
      method: "POST",
      headers: { Authorization: "Bearer x" },
      timeoutMs: 5000,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown event names", () => {
    const parsed = HookSchema.safeParse({
      id: "x",
      type: "command",
      event: "MidToolUse",
      command: "echo",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects http hooks without a URL", () => {
    const parsed = HookSchema.safeParse({
      id: "x",
      type: "http",
      event: "PreToolUse",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects unbounded timeouts above the cap", () => {
    const parsed = HookSchema.safeParse({
      id: "x",
      type: "command",
      event: "PreToolUse",
      command: "true",
      timeoutMs: 99999999,
    });
    expect(parsed.success).toBe(false);
  });

  it("HOOK_EVENTS exposes all six lifecycle events", () => {
    expect(HOOK_EVENTS).toEqual([
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "UserPromptSubmit",
      "SessionStart",
      "SessionEnd",
    ]);
    expect(TOOL_HOOK_EVENTS.has("PreToolUse")).toBe(true);
    expect(TOOL_HOOK_EVENTS.has("SessionStart")).toBe(false);
  });
});

describe("parseHooksFromSettings", () => {
  it("returns empty when hooks key is absent", () => {
    expect(parseHooksFromSettings({})).toEqual({ hooks: [], invalidCount: 0 });
  });

  it("filters invalid entries and counts them", () => {
    const result = parseHooksFromSettings({
      hooks: [
        { id: "ok", type: "command", event: "SessionEnd", command: "true" },
        { id: "bad", type: "command", event: "Nope", command: "true" },
        "not-an-object",
      ],
    });
    expect(result.hooks).toHaveLength(1);
    expect(result.hooks[0]!.id).toBe("ok");
    expect(result.invalidCount).toBe(2);
  });

  it("dedupes hooks by id, keeping the first occurrence", () => {
    const result = parseHooksFromSettings({
      hooks: [
        { id: "dup", type: "command", event: "PreToolUse", command: "a" },
        { id: "dup", type: "command", event: "PostToolUse", command: "b" },
      ],
    });
    expect(result.hooks).toHaveLength(1);
    expect(result.invalidCount).toBe(1);
    expect((result.hooks[0]! as { command: string }).command).toBe("a");
  });

  it("loadHooks returns empty for a missing settings file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squad-hooks-"));
    const result = await loadHooks(join(dir, "no-such-settings.json"));
    expect(result).toEqual({ hooks: [], invalidCount: 0 });
  });

  it("loadHooks reads and validates a real settings.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squad-hooks-"));
    const path = join(dir, "settings.json");
    await writeFile(
      path,
      JSON.stringify({
        version: "0.1.0",
        hooks: [
          {
            id: "log",
            type: "command",
            event: "SessionStart",
            command: "echo hi",
          },
        ],
      }),
    );
    const result = await loadHooks(path);
    expect(result.hooks).toHaveLength(1);
    expect(result.hooks[0]!.id).toBe("log");
  });

  it("loadHooks handles malformed JSON gracefully", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squad-hooks-"));
    const path = join(dir, "settings.json");
    await writeFile(path, "{ not valid json");
    const result = await loadHooks(path);
    expect(result.hooks).toEqual([]);
  });
});

describe("matchesHook", () => {
  const baseCommand = {
    id: "x",
    type: "command" as const,
    command: "true",
  };

  it("rejects events that don't match the hook's event", () => {
    const hook = HookSchema.parse({
      ...baseCommand,
      event: "PostToolUse",
    });
    expect(matchesHook(hook, { event: "PreToolUse", toolName: "Edit" })).toBe(
      false,
    );
  });

  it("ignores tool/pattern fields on non-tool events", () => {
    const hook = HookSchema.parse({
      ...baseCommand,
      event: "SessionStart",
      tool: "ShouldBeIgnored",
      pattern: "**/*.ts",
    });
    expect(matchesHook(hook, { event: "SessionStart" })).toBe(true);
  });

  it("filters by tool name when provided", () => {
    const hook = HookSchema.parse({
      ...baseCommand,
      event: "PostToolUse",
      tool: "Edit",
    });
    expect(
      matchesHook(hook, { event: "PostToolUse", toolName: "Edit", args: {} }),
    ).toBe(true);
    expect(
      matchesHook(hook, { event: "PostToolUse", toolName: "Read", args: {} }),
    ).toBe(false);
  });

  it("filters Edit calls by path pattern", () => {
    const hook = HookSchema.parse({
      ...baseCommand,
      event: "PostToolUse",
      tool: "Edit",
      pattern: "src/**",
    });
    expect(
      matchesHook(hook, {
        event: "PostToolUse",
        toolName: "Edit",
        args: { path: "src/foo.ts" },
      }),
    ).toBe(true);
    expect(
      matchesHook(hook, {
        event: "PostToolUse",
        toolName: "Edit",
        args: { path: "test/foo.ts" },
      }),
    ).toBe(false);
  });

  it("filters Shell calls by command pattern", () => {
    const hook = HookSchema.parse({
      ...baseCommand,
      event: "PreToolUse",
      tool: "Shell",
      pattern: "git push *",
    });
    expect(
      matchesHook(hook, {
        event: "PreToolUse",
        toolName: "Shell",
        args: { command: "git push origin main" },
      }),
    ).toBe(true);
    expect(
      matchesHook(hook, {
        event: "PreToolUse",
        toolName: "Shell",
        args: { command: "git status" },
      }),
    ).toBe(false);
  });
});

describe("hook runner", () => {
  function ctx(overrides: Partial<HookContext> = {}): HookContext {
    return {
      event: "PostToolUse",
      sessionId: "s1",
      cwd: "/tmp/x",
      toolName: "Edit",
      args: { path: "src/foo.ts" },
      callId: "c1",
      ok: true,
      ...overrides,
    };
  }

  it("is a no-op when no hooks are registered", async () => {
    const runner = createHookRunner({ hooks: [] });
    const results = await runner.fire(ctx());
    expect(results).toEqual([]);
  });

  it("invokes only matching hooks and audits each fire", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValue({ ok: true, status: "exit=0" });
    const runHttp = vi.fn();
    const audit = vi.fn();
    const runner = createHookRunner({
      hooks: [
        HookSchema.parse({
          id: "match",
          type: "command",
          event: "PostToolUse",
          tool: "Edit",
          command: "echo",
        }),
        HookSchema.parse({
          id: "skip",
          type: "command",
          event: "PostToolUse",
          tool: "Read",
          command: "echo",
        }),
      ],
      audit,
      runCommand,
      runHttp,
    });
    const results = await runner.fire(ctx());
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("match");
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runHttp).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(1);
    const auditedResult = audit.mock.calls[0]![0] as HookFireResult;
    expect(auditedResult.id).toBe("match");
    expect(auditedResult.event).toBe("PostToolUse");
    expect(auditedResult.ok).toBe(true);
    expect(auditedResult.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("captures executor errors as ok:false in the audit row", async () => {
    const runCommand = vi.fn().mockRejectedValue(new Error("boom"));
    const audit = vi.fn();
    const runner = createHookRunner({
      hooks: [
        HookSchema.parse({
          id: "err",
          type: "command",
          event: "SessionEnd",
          command: "false",
        }),
      ],
      audit,
      runCommand,
    });
    const results = await runner.fire({
      event: "SessionEnd",
      sessionId: "s1",
      cwd: "/tmp",
    });
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.status).toContain("boom");
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("dispatches http hooks to the http executor with the context payload", async () => {
    const runHttp = vi
      .fn()
      .mockResolvedValue({ ok: true, status: "status=200" });
    const runner = createHookRunner({
      hooks: [
        HookSchema.parse({
          id: "http",
          type: "http",
          event: "UserPromptSubmit",
          url: "https://example.test/hook",
        }),
      ],
      runHttp,
    });
    await runner.fire({
      event: "UserPromptSubmit",
      sessionId: "s1",
      cwd: "/tmp",
      prompt: "hello",
    });
    expect(runHttp).toHaveBeenCalledTimes(1);
    const [hook, passedCtx] = runHttp.mock.calls[0]!;
    expect((hook as { id: string }).id).toBe("http");
    expect((passedCtx as HookContext).prompt).toBe("hello");
  });

  it("strips credential-shaped env vars from command hooks by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squad-hook-env-"));
    const out = join(dir, "env.txt");
    const old = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "leaked";
    try {
      const result = await runCommandHook(
        HookSchema.parse({
          id: "env",
          type: "command",
          event: "SessionEnd",
          command: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync(process.argv[1], process.env.OPENAI_API_KEY || '')" ${JSON.stringify(out)}`,
        }),
        { event: "SessionEnd", sessionId: "s1", cwd: dir },
      );
      expect(result.ok).toBe(true);
      expect(await readFile(out, "utf-8")).toBe("");
    } finally {
      if (old === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = old;
    }
  });

  it("passes only explicitly opted-in credential env vars to command hooks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squad-hook-env-"));
    const out = join(dir, "env.txt");
    const old = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "needed";
    try {
      const result = await runCommandHook(
        HookSchema.parse({
          id: "env",
          type: "command",
          event: "SessionEnd",
          command: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync(process.argv[1], process.env.OPENAI_API_KEY || '')" ${JSON.stringify(out)}`,
          passEnv: ["OPENAI_API_KEY"],
        }),
        { event: "SessionEnd", sessionId: "s1", cwd: dir },
      );
      expect(result.ok).toBe(true);
      expect(await readFile(out, "utf-8")).toBe("needed");
    } finally {
      if (old === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = old;
    }
  });

  it("blocks non-local http hooks unless the destination is allowlisted", async () => {
    const result = await runHttpHook(
      HookSchema.parse({
        id: "leak",
        type: "http",
        event: "UserPromptSubmit",
        url: "https://example.test/hook",
      }),
      { event: "UserPromptSubmit", sessionId: "s1", cwd: "/tmp", prompt: "x" },
    );
    expect(result.ok).toBe(false);
    expect(result.status).toContain("allowedHosts");
  });

  it("rejects cleartext non-local http hook URLs", async () => {
    const result = await runHttpHook(
      HookSchema.parse({
        id: "clear",
        type: "http",
        event: "UserPromptSubmit",
        url: "http://example.test/hook",
        allowedHosts: ["example.test"],
      }),
      { event: "UserPromptSubmit", sessionId: "s1", cwd: "/tmp", prompt: "x" },
    );
    expect(result.ok).toBe(false);
    expect(result.status).toContain("https");
  });

  it("rejects allowlisted hosts that resolve to private addresses", async () => {
    const hook = HookSchema.parse({
      id: "dns-rebind",
      type: "http",
      event: "UserPromptSubmit",
      url: "https://hooks.example.test/ingest",
      allowedHosts: ["hooks.example.test"],
    });
    const blocked = await validateHttpHookDestination(hook, async () => [
      { address: "169.254.169.254", family: 4 },
    ]);
    expect(blocked).toContain("resolves to a private-network address");
  });

  it("does not follow redirects from an allowed hook URL", async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await runHttpHook(
        HookSchema.parse({
          id: "redirect",
          type: "http",
          event: "UserPromptSubmit",
          url: "https://93.184.216.34/hook",
          allowedHosts: ["93.184.216.34"],
        }),
        {
          event: "UserPromptSubmit",
          sessionId: "s1",
          cwd: "/tmp",
          prompt: "x",
        },
      );
      expect(result.ok).toBe(false);
      expect(result.status).toContain("redirect");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://93.184.216.34/hook",
        expect.objectContaining({ redirect: "manual" }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
