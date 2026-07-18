// Replay harness: drive runAgentLoop with a scripted provider, a deterministic
// fake tool registry, and a permissive policy, collecting every emitted event.
// This is the offline regression rig — load a golden fixture (a recorded
// provider event stream), replay it through the real loop, and assert on the
// loop's behavior (tool dispatch, repeat/failure guards, message assembly)
// without a network call or a real filesystem tool.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runAgentLoop } from "../../src/engine/loop.js";
import type { PolicyConfig } from "../../src/permissions/policy.js";
import type {
  CanonicalEvent,
  CanonicalMessage,
} from "../../src/providers/types.js";
import type { ToolRegistry } from "../../src/tools/registry.js";
import { createTodoState } from "../../src/tools/todo.js";
import { defineTool, type Tool } from "../../src/tools/types.js";
import {
  createReplayProvider,
  type GoldenTurn,
  type ReplayProvider,
} from "./replay-provider.js";

export interface GoldenFixture {
  name: string;
  description?: string;
  turns: GoldenTurn[];
  initialMessages?: CanonicalMessage[];
}

export interface GoldenRun {
  events: CanonicalEvent[];
  provider: ReplayProvider;
}

// Deterministic, side-effect-free tools the fixtures script against. echo
// returns its args; boom always fails. Both read-only so they auto-allow.
const anyArgs = z.record(z.string(), z.unknown());

const echoTool: Tool = defineTool({
  name: "echo",
  description: "Echo the call args back as JSON.",
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
  inputZod: anyArgs,
  defaultPermission: "auto-allow",
  isReadOnly: true,
  execute: async (input) => ({ ok: true, content: JSON.stringify(input) }),
});

const boomTool: Tool = defineTool({
  name: "boom",
  description: "Always fails.",
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
  inputZod: anyArgs,
  defaultPermission: "auto-allow",
  isReadOnly: true,
  execute: async () => ({ ok: false, content: "boom", error: "BOOM" }),
});

const DEFAULT_TOOLS: Tool[] = [echoTool, boomTool];

function makeReplayRegistry(tools: Tool[]): ToolRegistry {
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

export interface RunGoldenOptions {
  tools?: Tool[];
  maxTurns?: number;
}

export async function runGolden(
  fixture: GoldenFixture,
  opts: RunGoldenOptions = {},
): Promise<GoldenRun> {
  const provider = createReplayProvider(fixture.turns, "replay");
  const registry = makeReplayRegistry(opts.tools ?? DEFAULT_TOOLS);
  const events: CanonicalEvent[] = [];
  for await (const ev of runAgentLoop({
    provider,
    model: "replay-model",
    messages: fixture.initialMessages ?? [{ role: "user", content: "go" }],
    registry,
    policy: permissivePolicy(),
    cwd: process.cwd(),
    abort: new AbortController().signal,
    askPermission: async () => "allow",
    ...(opts.maxTurns !== undefined && { maxTurns: opts.maxTurns }),
  })) {
    events.push(ev);
  }
  return { events, provider };
}

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));

export function loadFixture(name: string): GoldenFixture {
  const raw = readFileSync(`${FIXTURES_DIR}${name}.json`, "utf-8");
  return JSON.parse(raw) as GoldenFixture;
}
