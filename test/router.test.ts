import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReplayProvider } from "../integration-tests/golden/replay-provider.js";
import { loadCatalog } from "../src/providers/catalog.js";
import {
  dispatchProvider,
  makeEnvFromProcess,
} from "../src/providers/dispatch.js";
import {
  createRouterProvider,
  type ModelResolver,
} from "../src/providers/router.js";
import type {
  CanonicalEvent,
  CanonicalRequest,
  LLMProvider,
} from "../src/providers/types.js";

const NODE = process.execPath;

function req(prompt: string): CanonicalRequest {
  return {
    model: "router",
    messages: [{ role: "user", content: prompt }],
    tools: [{ name: "Read", description: "r", inputSchema: {} }],
  };
}

async function collect(
  provider: LLMProvider,
  request: CanonicalRequest,
): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  for await (const ev of provider.stream(request)) events.push(ev);
  return events;
}

function textTurn(text: string): CanonicalEvent[] {
  return [
    { type: "text_delta", text },
    { type: "done", reason: "stop" },
  ];
}

// A resolver that hands back a replay provider only for the expected choice.
const resolverFor = (
  expectProvider: string,
  expectModel: string,
  text: string,
): ModelResolver => {
  return (p, m) =>
    p === expectProvider && m === expectModel
      ? createReplayProvider([textTurn(text)])
      : `unexpected route ${p}/${m}`;
};

describe("router provider", () => {
  it("asks the router, then delegates to the chosen model", async () => {
    const provider = createRouterProvider({
      config: {
        providerId: "router",
        command: [
          NODE,
          "-e",
          "process.stdout.write(JSON.stringify({provider_id:'deepseek',model_id:'deepseek-chat',rationale:'reasoning'}))",
        ],
      },
      resolveModel: resolverFor("deepseek", "deepseek-chat", "from deepseek"),
    });
    const events = await collect(provider, req("solve it"));
    const text = events
      .filter(
        (e): e is Extract<CanonicalEvent, { type: "text_delta" }> =>
          e.type === "text_delta",
      )
      .map((e) => e.text)
      .join("");
    expect(text).toBe("from deepseek");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("delegates with the ROUTED model id, not the router row's id", async () => {
    // Live-smoke lesson (2026-07-06): req.model still says "crabmeat-router"
    // when it reaches the delegate, and concrete adapters send req.model on
    // the wire. Ollama then 404s on a model literally named after the router
    // row. The router must rewrite model to the decision's model_id.
    const delegate = createReplayProvider([textTurn("routed")]);
    const provider = createRouterProvider({
      config: {
        providerId: "router",
        command: [
          NODE,
          "-e",
          "process.stdout.write(JSON.stringify({provider_id:'ollama',model_id:'qwen3:latest'}))",
        ],
      },
      resolveModel: (p, m) =>
        p === "ollama" && m === "qwen3:latest"
          ? delegate
          : `unexpected route ${p}/${m}`,
    });
    await collect(provider, req("solve it"));
    expect(delegate.requests).toHaveLength(1);
    expect(delegate.requests[0]?.model).toBe("qwen3:latest");
  });

  it("surfaces ROUTER_FAILED on a non-zero exit", async () => {
    const provider = createRouterProvider({
      config: {
        providerId: "router",
        command: [NODE, "-e", "process.exit(2)"],
      },
      resolveModel: () => "should not be called",
    });
    const events = await collect(provider, req("x"));
    const err = events.find((e) => e.type === "error");
    expect((err as Extract<CanonicalEvent, { type: "error" }>)?.code).toBe(
      "ROUTER_FAILED",
    );
  });

  it("surfaces ROUTER_FAILED on non-JSON output", async () => {
    const provider = createRouterProvider({
      config: {
        providerId: "router",
        command: [NODE, "-e", "process.stdout.write('not json')"],
      },
      resolveModel: () => "n/a",
    });
    const events = await collect(provider, req("x"));
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("does not pass provider credentials to router commands by default", async () => {
    const old = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "leaked";
    try {
      const provider = createRouterProvider({
        config: {
          providerId: "router",
          command: [
            NODE,
            "-e",
            "if(process.env.OPENAI_API_KEY) process.exit(7); process.stdout.write(JSON.stringify({provider_id:'deepseek',model_id:'deepseek-chat'}))",
          ],
        },
        resolveModel: resolverFor("deepseek", "deepseek-chat", "ok"),
      });
      const events = await collect(provider, req("x"));
      expect(events.some((e) => e.type === "error")).toBe(false);
    } finally {
      if (old === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = old;
    }
  });

  it("passes explicitly opted-in env vars to router commands", async () => {
    const old = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "needed";
    try {
      const provider = createRouterProvider({
        config: {
          providerId: "router",
          command: [
            NODE,
            "-e",
            "if(process.env.OPENAI_API_KEY!=='needed') process.exit(7); process.stdout.write(JSON.stringify({provider_id:'deepseek',model_id:'deepseek-chat'}))",
          ],
          passEnv: ["OPENAI_API_KEY"],
        },
        resolveModel: resolverFor("deepseek", "deepseek-chat", "ok"),
      });
      const events = await collect(provider, req("x"));
      expect(events.some((e) => e.type === "error")).toBe(false);
    } finally {
      if (old === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = old;
    }
  });
});

describe("router caches the decision (routes once per task)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("runs the router command once across multiple turns", async () => {
    dir = mkdtempSync(join(tmpdir(), "squad-router-"));
    const marker = join(dir, "runs.txt");
    writeFileSync(marker, "");
    // Each invocation appends a byte to the marker; if caching works, two
    // stream() calls produce only one byte.
    const provider = createRouterProvider({
      config: {
        providerId: "router",
        command: [
          NODE,
          "-e",
          `require('fs').appendFileSync(${JSON.stringify(marker)},'x');process.stdout.write(JSON.stringify({provider_id:'deepseek',model_id:'deepseek-chat'}))`,
        ],
      },
      resolveModel: resolverFor("deepseek", "deepseek-chat", "ok"),
    });
    await collect(provider, req("turn 1"));
    await collect(provider, req("turn 2"));
    expect(readFileSync(marker, "utf-8")).toBe("x");
  });
});

describe("dispatch router kind", () => {
  it("builds a router provider when given a resolver, errors without one", () => {
    const catalog = loadCatalog({
      defaultPath: "/nonexistent",
      userPath: "/nonexistent",
      extraEntries: [
        {
          id: "crabmeat-router",
          provider_id: "crabmeat",
          kind: "router",
          base_url: "http://localhost",
          router: { command: [NODE, "-e", "1"] },
        },
      ],
    });
    const entry = catalog.get("crabmeat-router");
    expect(entry).toBeDefined();
    const env = makeEnvFromProcess(false);
    // No resolver -> clean error string.
    expect(typeof dispatchProvider(entry!, env)).toBe("string");
    // With a resolver -> a provider.
    const withResolver = dispatchProvider(entry!, env, {
      resolveModel: () => createReplayProvider([textTurn("x")]),
    });
    expect(typeof withResolver).not.toBe("string");
  });
});
