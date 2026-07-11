import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentRuntime } from "../src/agents/runtime.js";
import { createAgentWorktree } from "../src/agents/worktree.js";
import type { PolicyConfig } from "../src/permissions/policy.js";
import { loadCatalog } from "../src/providers/catalog.js";
import {
  dispatchProvider,
  makeEnvFromProcess,
} from "../src/providers/dispatch.js";
import { createExternalCliProvider } from "../src/providers/external-cli.js";
import type {
  CanonicalEvent,
  CanonicalRequest,
} from "../src/providers/types.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { findChecklist } from "../src/yolo/checklist.js";

const NODE = process.execPath;

function permissivePolicy(): PolicyConfig {
  return {
    defaultMode: "allow",
    rules: new Map(),
    dangerouslySkipPermissions: false,
    mode: "act",
  };
}

function req(prompt: string): CanonicalRequest {
  return { model: "ext", messages: [{ role: "user", content: prompt }] };
}

async function collectText(
  provider: ReturnType<typeof createExternalCliProvider>,
  request: CanonicalRequest,
): Promise<string> {
  let text = "";
  for await (const ev of provider.stream(request)) {
    if (ev.type === "text_delta") text += ev.text;
  }
  return text;
}

describe("external-cli adapter", () => {
  it("returns raw stdout (prompt passed as arg)", async () => {
    const provider = createExternalCliProvider({
      providerId: "fake",
      command: [
        NODE,
        "-e",
        "process.stdout.write('### SUMMARY\\nfound 1 issue')",
      ],
    });
    const text = await collectText(provider, req("audit"));
    expect(text).toBe("### SUMMARY\nfound 1 issue");
  });

  it("extracts a json_path from JSON stdout", async () => {
    const provider = createExternalCliProvider({
      providerId: "fake",
      command: [
        NODE,
        "-e",
        "process.stdout.write(JSON.stringify({result:{text:'parsed ok'}}))",
      ],
      parse: { mode: "json_path", jsonPath: "result.text" },
    });
    expect(await collectText(provider, req("x"))).toBe("parsed ok");
  });

  it("passes the prompt via stdin when configured", async () => {
    const provider = createExternalCliProvider({
      providerId: "fake",
      promptVia: "stdin",
      command: [
        NODE,
        "-e",
        "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('got:'+d))",
      ],
    });
    expect(await collectText(provider, req("hello-stdin"))).toBe(
      "got:hello-stdin",
    );
  });

  it("does not pass provider credentials to external CLIs by default", async () => {
    const old = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "leaked";
    try {
      const provider = createExternalCliProvider({
        providerId: "fake",
        command: [
          NODE,
          "-e",
          "process.stdout.write(process.env.OPENAI_API_KEY || '')",
        ],
      });
      expect(await collectText(provider, req("x"))).toBe("");
    } finally {
      if (old === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = old;
    }
  });

  it("passes explicitly opted-in env vars to external CLIs", async () => {
    const old = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "needed";
    try {
      const provider = createExternalCliProvider({
        providerId: "fake",
        command: [
          NODE,
          "-e",
          "process.stdout.write(process.env.OPENAI_API_KEY || '')",
        ],
        passEnv: ["OPENAI_API_KEY"],
      });
      expect(await collectText(provider, req("x"))).toBe("needed");
    } finally {
      if (old === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = old;
    }
  });

  it("emits an error event on a non-zero exit", async () => {
    const provider = createExternalCliProvider({
      providerId: "fake",
      command: [NODE, "-e", "process.exit(3)"],
    });
    const events: CanonicalEvent[] = [];
    for await (const ev of provider.stream(req("x"))) events.push(ev);
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect((err as Extract<CanonicalEvent, { type: "error" }>).code).toBe(
      "EXTERNAL_CLI_FAILED",
    );
  });
});

describe("dispatch external-cli kind", () => {
  it("dispatches a catalog entry to the adapter", () => {
    const catalog = loadCatalog({
      defaultPath: "/nonexistent",
      userPath: "/nonexistent",
      extraEntries: [
        {
          id: "ext-model",
          provider_id: "fake-cli",
          kind: "external-cli",
          base_url: "http://localhost",
          external_cli: { command: [NODE, "-e", "1"] },
        },
      ],
    });
    const entry = catalog.get("ext-model");
    expect(entry).toBeDefined();
    const provider = dispatchProvider(entry!, makeEnvFromProcess(false));
    expect(typeof provider).not.toBe("string");
  });

  it("errors when external_cli config is missing", () => {
    const catalog = loadCatalog({
      defaultPath: "/nonexistent",
      userPath: "/nonexistent",
      extraEntries: [
        {
          id: "broken",
          provider_id: "x",
          kind: "external-cli",
          base_url: "http://localhost",
        },
      ],
    });
    const result = dispatchProvider(
      catalog.get("broken")!,
      makeEnvFromProcess(false),
    );
    expect(typeof result).toBe("string");
    expect(result as string).toContain("external_cli");
  });
});

describe("git worktree isolation", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "squad-wt-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-qm", "init"], {
      cwd: repo,
    });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("creates and removes a worktree at HEAD", async () => {
    const wt = await createAgentWorktree(repo, "AB-1");
    expect(wt).not.toBeNull();
    expect(existsSync(wt?.path ?? "")).toBe(true);
    await wt?.remove();
    expect(existsSync(wt?.path ?? "")).toBe(false);
  });

  it("returns null for a non-git directory", async () => {
    const plain = mkdtempSync(join(tmpdir(), "squad-plain-"));
    try {
      expect(await createAgentWorktree(plain, "AB-2")).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("throws when required isolation cannot be created", async () => {
    const plain = mkdtempSync(join(tmpdir(), "squad-required-"));
    try {
      await expect(
        createAgentWorktree(plain, "AB-3", { required: true }),
      ).rejects.toMatchObject({ code: "WORKTREE_REQUIRED" });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("uses run ids to avoid collisions for identical labels", async () => {
    const [first, second] = await Promise.all([
      createAgentWorktree(repo, "judge", { required: true, runId: "run-a" }),
      createAgentWorktree(repo, "judge", { required: true, runId: "run-b" }),
    ]);
    expect(first?.path).not.toBe(second?.path);
    expect(first?.path).toContain("run-a-judge");
    expect(second?.path).toContain("run-b-judge");
    await Promise.all([first?.remove(), second?.remove()]);
  });

  it("copies ignored gate and environment files into the worktree", async () => {
    execFileSync("git", ["-C", repo, "checkout", "--orphan", "includes"], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", repo, "rm", "-rf", "--ignore-unmatch", "."], {
      stdio: "ignore",
    });
    writeFileSync(join(repo, ".gitignore"), ".env\nchecklist.txt\n");
    writeFileSync(join(repo, ".worktreeinclude"), ".env\nchecklist.txt\n");
    writeFileSync(join(repo, ".env"), "SECRET=local-only\n");
    writeFileSync(join(repo, "checklist.txt"), "[ ] isolated gate\n");
    execFileSync("git", ["-C", repo, "add", ".gitignore", ".worktreeinclude"]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "include policy"]);

    const mainChecklist = await findChecklist(repo);
    const wt = await createAgentWorktree(repo, "copy", {
      required: true,
      runId: "run-includes",
    });
    expect(wt).not.toBeNull();
    expect(readFileSync(join(wt?.path ?? "", ".env"), "utf-8")).toBe(
      "SECRET=local-only\n",
    );
    expect(readFileSync(join(wt?.path ?? "", "checklist.txt"), "utf-8")).toBe(
      "[ ] isolated gate\n",
    );
    const isolatedChecklist = await findChecklist(wt?.path ?? "");
    expect(isolatedChecklist?.contents).toBe(mainChecklist?.contents);
    await wt?.remove();
  });
});

describe("required subagent worktree isolation", () => {
  it("does not invoke the provider or leak a slot in a non-git directory", async () => {
    const plain = mkdtempSync(join(tmpdir(), "squad-agent-required-"));
    let providerBuilds = 0;
    try {
      const bundle = createAgentRuntime({
        agentDefs: new Map(),
        makeProvider: () => {
          providerBuilds += 1;
          return "provider should not be built";
        },
        cwd: plain,
        parentAbort: new AbortController().signal,
        defaultProvider: "ext",
        defaultModel: "m",
        basePolicy: permissivePolicy(),
        responder: async () => "allow",
      });
      await expect(
        bundle.host.spawn(
          {
            name: "isolated",
            description: "must isolate",
            systemPrompt: "s",
            isolation: "worktree",
          },
          "do work",
        ),
      ).rejects.toMatchObject({ code: "WORKTREE_REQUIRED" });
      expect(providerBuilds).toBe(0);
      expect(bundle.slotRegistry.livingCount()).toBe(0);
      expect(bundle.slotRegistry.freeSlots()).toBe(
        bundle.slotRegistry.maxSlots,
      );
      expect(bundle.identity.living()).toEqual([]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("subagent backed by an external CLI — smoke", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "squad-ext-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-qm", "init"], {
      cwd: repo,
    });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("runs in an isolated worktree, writes a file, returns issues; parent sees the diff", async () => {
    // The fake CLI writes a finding into its cwd and prints a structured report.
    const script =
      "require('fs').writeFileSync('finding.txt','issue: bad input handling');" +
      "process.stdout.write('### SUMMARY\\nFound 1 issue.\\n\\n### CHANGES\\n- wrote finding.txt')";
    const bundle = createAgentRuntime({
      agentDefs: new Map([
        [
          "red-team",
          {
            name: "red-team",
            description: "external red team",
            provider: "ext",
            isolation: "worktree",
            systemPrompt: "s",
          },
        ],
      ]),
      makeProvider: (providerId, _model, cwd) =>
        createExternalCliProvider({
          providerId,
          command: [NODE, "-e", script],
          ...(cwd !== undefined && { cwd }),
        }),
      cwd: repo,
      parentAbort: new AbortController().signal,
      defaultProvider: "ext",
      defaultModel: "m",
      basePolicy: permissivePolicy(),
      responder: async () => "allow",
    });
    const registry = createToolRegistry({ agentHost: bundle.host });
    bundle.setBaseRegistry(registry);

    const def = bundle.host.defs().get("red-team");
    expect(def).toBeDefined();
    const { record, report } = await bundle.host.spawn(def!, "audit the repo");

    expect(record.status).toBe("completed");
    expect(report.summary).toBe("Found 1 issue.");
    // The agent ran in an isolated worktree, not the main checkout.
    expect(record.worktree).toBeDefined();
    expect(record.worktree).not.toBe(repo);
    // The finding landed in the worktree...
    expect(
      readFileSync(join(record.worktree as string, "finding.txt"), "utf-8"),
    ).toContain("bad input handling");
    // ...and NOT in the parent checkout.
    expect(existsSync(join(repo, "finding.txt"))).toBe(false);
    // The parent can review the worktree diff.
    const status = execFileSync(
      "git",
      ["-C", record.worktree as string, "status", "--porcelain"],
      { encoding: "utf-8" },
    );
    expect(status).toContain("finding.txt");
  });
});
