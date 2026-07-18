import { describe, expect, it } from "vitest";
import {
  buildConfigurationStack,
  type ConfigOrigin,
} from "../src/config/stack.js";
import type { Env } from "../src/env.js";
import { appendRule, type RuleMap } from "../src/permissions/policy.js";
import type {
  CatalogEntryProvenance,
  ModelCatalog,
  ModelEntry,
} from "../src/providers/catalog.js";

function env(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "info",
    AI_DEFAULT_PROVIDER: "deepseek",
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
    ...overrides,
  };
}

function catalog(): ModelCatalog {
  const models: ModelEntry[] = [
    {
      id: "deepseek-v4-flash",
      provider_id: "deepseek",
      kind: "llm-chat",
      base_url: "https://api.deepseek.com",
      env_key_var: "DEEPSEEK_API_KEY",
    },
    {
      id: "custom-model",
      provider_id: "custom",
      kind: "llm-local",
      base_url: "http://localhost:9999",
    },
  ];
  const provenance: CatalogEntryProvenance = {
    origin: "built-in",
    source: "default-models.json",
    version: "1",
  };
  return {
    list: () => models,
    get: (id) => models.find((model) => model.id === id),
    byProvider: (provider) =>
      models.filter((model) => model.provider_id === provider),
    byKind: (kind) => models.filter((model) => model.kind === kind),
    provenance: (id) =>
      models.some((model) => model.id === id) ? provenance : undefined,
  };
}

function origins(
  value: ReturnType<typeof buildConfigurationStack>,
  key: string,
): ConfigOrigin[] {
  return value.stack.explain(key)?.layers.map((layer) => layer.origin) ?? [];
}

describe("configuration stack provenance", () => {
  it("resolves CLI over user settings over environment defaults", () => {
    const loaded = buildConfigurationStack({
      cwd: process.cwd(),
      cli: {
        provider: "custom",
        model: "custom-model",
        notificationSound: true,
      },
      env: env(),
      settings: {
        version: "0.1.0",
        createdAt: "now",
        defaultProvider: "openai",
        defaultModel: "gpt-5.1",
        notifications: { permissionSound: false },
      },
      catalog: catalog(),
      hooks: { hooks: [], invalidCount: 0 },
      projectRules: new Map(),
      userGlobalRules: new Map(),
    });

    expect(loaded.provider).toBe("custom");
    expect(loaded.model).toBe("custom-model");
    expect(loaded.stack.explain("runtime.provider")?.origin).toBe("cli");
    expect(origins(loaded, "runtime.provider")).toEqual([
      "schema-default",
      "user-settings",
      "cli",
    ]);
    expect(loaded.notifications.permissionSound).toBe(true);
    expect(
      loaded.stack.explain("settings.notifications.permissionSound")?.origin,
    ).toBe("cli");
  });

  it("accounts for environment, settings, hooks, catalogs, and permission layers", () => {
    const projectRules: RuleMap = new Map();
    const userRules: RuleMap = new Map();
    appendRule(projectRules, "Read", { pattern: "src/**", action: "allow" });
    appendRule(userRules, "Shell", {
      pattern: "git status *",
      action: "allow",
    });
    const loaded = buildConfigurationStack({
      cwd: process.cwd(),
      cli: {},
      env: env({
        DEEPSEEK_API_KEY: "synthetic-key-not-for-output",
        SQUAD_PROJECT_PERMS: false,
      }),
      settings: {
        version: "0.1.0",
        createdAt: "now",
        defaultProvider: "deepseek",
        recap: { idleMinutes: 9 },
        notifications: {
          program: "notify-squad",
          terminalMode: "unfocused",
          terminalMethod: "bell",
          permissionSound: false,
        },
      },
      catalog: catalog(),
      hooks: {
        hooks: [
          {
            id: "after",
            event: "SessionEnd",
            type: "command",
            command: "echo done",
          },
        ],
        invalidCount: 1,
      },
      projectRules,
      userGlobalRules: userRules,
      projectVersion: "0.2.0",
      userPermissionsVersion: "0.1.0",
    });

    expect(loaded.stack.explain("env.DEEPSEEK_API_KEY")?.value).toBe(
      "[configured]",
    );
    expect(JSON.stringify(loaded.stack.list())).not.toContain(
      "synthetic-key-not-for-output",
    );
    expect(loaded.stack.explain("settings.recap.idleMinutes")?.value).toBe(9);
    expect(loaded.reviewModel).toBe("llama3.2");
    expect(loaded.guardian).toEqual({ enabled: false, model: "llama3.2" });
    expect(loaded.stack.explain("settings.review_model")?.origin).toBe(
      "schema-default",
    );
    expect(loaded.notifications).toEqual({
      program: "notify-squad",
      terminalMode: "unfocused",
      terminalMethod: "bell",
      permissionSound: false,
    });
    expect(
      loaded.stack.explain("settings.notifications.terminalMode")?.origin,
    ).toBe("user-settings");
    expect(
      loaded.stack.explain("settings.notifications.permissionSound")?.origin,
    ).toBe("user-settings");
    expect(loaded.stack.explain("hooks.after")?.version).toBe("0.1.0");
    expect(loaded.stack.explain("hooks.invalid")?.disabledReason).toContain(
      "1 invalid",
    );
    expect(
      loaded.stack.explain("catalog.models.deepseek-v4-flash")?.version,
    ).toBe("1");
    expect(
      loaded.stack.explain("permissions.project.Read.src/**")?.disabledReason,
    ).toBe("SQUAD_PROJECT_PERMS is false");
    expect(
      loaded.stack.explain("permissions.user.Shell.git status *")?.origin,
    ).toBe("user-permissions");
  });

  it("allows a dedicated review model without changing the runtime model", () => {
    const loaded = buildConfigurationStack({
      cwd: process.cwd(),
      cli: {},
      env: env(),
      settings: {
        version: "0.1.0",
        createdAt: "now",
        review_model: "custom-model",
      },
      catalog: catalog(),
      hooks: { hooks: [], invalidCount: 0 },
      projectRules: new Map(),
      userGlobalRules: new Map(),
    });

    expect(loaded.model).toBe("deepseek-v4-flash");
    expect(loaded.reviewModel).toBe("custom-model");
    expect(loaded.stack.explain("settings.review_model")?.origin).toBe(
      "user-settings",
    );
  });

  it("normalizes the opt-in local guardian settings", () => {
    const loaded = buildConfigurationStack({
      cwd: process.cwd(),
      cli: {},
      env: env(),
      settings: {
        version: "0.1.0",
        createdAt: "now",
        guardian: { enabled: true, model: "custom-model" },
      },
      catalog: catalog(),
      hooks: { hooks: [], invalidCount: 0 },
      projectRules: new Map(),
      userGlobalRules: new Map(),
    });

    expect(loaded.guardian).toEqual({
      enabled: true,
      model: "custom-model",
    });
    expect(loaded.stack.explain("settings.guardian.enabled")?.origin).toBe(
      "user-settings",
    );
  });

  it("applies named profile provider, model, and mode before CLI overrides", () => {
    const local = buildConfigurationStack({
      cwd: process.cwd(),
      cli: { profile: "local" },
      env: env(),
      settings: { version: "0.1.0", createdAt: "now" },
      catalog: catalog(),
      hooks: { hooks: [], invalidCount: 0 },
      projectRules: new Map(),
      userGlobalRules: new Map(),
    });
    expect(local.provider).toBe("ollama");
    expect(local.model).toBe("llama3.2");
    expect(local.profileMode).toBe("act");

    const custom = buildConfigurationStack({
      cwd: process.cwd(),
      cli: { profile: "cheap", model: "custom-model" },
      env: env(),
      settings: {
        version: "0.1.0",
        createdAt: "now",
        profiles: {
          cheap: { provider: "custom", model: "profile-model", mode: "plan" },
        },
      },
      catalog: catalog(),
      hooks: { hooks: [], invalidCount: 0 },
      projectRules: new Map(),
      userGlobalRules: new Map(),
    });
    expect(custom.provider).toBe("custom");
    expect(custom.model).toBe("custom-model");
    expect(custom.profileMode).toBe("plan");
  });
});
