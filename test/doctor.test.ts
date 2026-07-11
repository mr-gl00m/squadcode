import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diagnoseConfiguration, verifyAuditChain } from "../src/cli/doctor.js";
import { buildConfigurationStack } from "../src/config/stack.js";
import type { Env } from "../src/env.js";
import type { ModelCatalog, ModelEntry } from "../src/providers/catalog.js";
import type { SessionStore } from "../src/sessions/store.js";

const model: ModelEntry = {
  id: "local-test",
  provider_id: "local",
  kind: "llm-local",
  base_url: "http://localhost:11434",
};

const catalog: ModelCatalog = {
  list: () => [model],
  get: (id) => (id === model.id ? model : undefined),
  byProvider: (provider) => (provider === model.provider_id ? [model] : []),
  byKind: (kind) => (kind === model.kind ? [model] : []),
  provenance: () => ({ origin: "built-in", source: "test-catalog" }),
};

function testEnv(): Env {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "info",
    AI_DEFAULT_PROVIDER: "local",
    AI_DEFAULT_MODEL: "local-test",
    ANTHROPIC_MODEL: "claude-sonnet-4-6",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    OPENAI_MODEL: "gpt-5.1",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    DEEPSEEK_MODEL: "deepseek-v4-flash",
    OLLAMA_BASE_URL: "http://localhost:11434",
    OLLAMA_MODEL: "llama3.2",
    OLLAMA_ALLOW_REMOTE: false,
    CLI_PERMISSION_MODE: "ask",
    CLI_MAX_TOOL_CONCURRENCY: 4,
    SQUAD_PROJECT_PERMS: true,
    SQUAD_POST_EDIT_DIAGNOSTICS: true,
  };
}

describe("doctor and audit CLI services", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "squad-doctor-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("reports install, config, auth, and runtime health with provenance", async () => {
    const configuration = buildConfigurationStack({
      cwd,
      cli: {},
      env: testEnv(),
      settings: { version: "0.1.0", createdAt: "now" },
      catalog,
      hooks: { hooks: [], invalidCount: 0 },
      projectRules: new Map(),
      userGlobalRules: new Map(),
    });
    const checks = await diagnoseConfiguration(configuration, cwd);
    expect(new Set(checks.map((check) => check.area))).toEqual(
      new Set(["install", "config", "auth", "runtime"]),
    );
    expect(checks.every((check) => check.status !== "fail")).toBe(true);
    expect(checks.find((check) => check.name === "provider")?.detail).toContain(
      "environment schema default",
    );
  });

  it("returns non-zero semantics and a row id for broken audit continuity", async () => {
    const output: string[] = [];
    const store = {
      validateAuditChain: () => ({
        ok: false,
        brokenAtId: 7,
        reason: "prev_hash mismatch",
      }),
    } as unknown as SessionStore;
    expect(
      await verifyAuditChain({ store, write: (text) => output.push(text) }),
    ).toBe(false);
    expect(output.join("")).toContain("row 7");
  });
});
