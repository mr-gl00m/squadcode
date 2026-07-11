import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Env, loadEnv } from "../env.js";
import { type LoadHooksResult, loadHooks } from "../hooks/config.js";
import type { NotificationConfig } from "../notifications.js";
import {
  getUserPermissionsPath,
  loadUserGlobalRules,
} from "../permissions/global.js";
import type { RuleMap } from "../permissions/policy.js";
import {
  getProjectSettingsPath,
  loadProjectRules,
} from "../permissions/project.js";
import {
  loadCatalog,
  type ModelCatalog,
  type ModelEntry,
} from "../providers/catalog.js";
import {
  DEFAULT_RECAP_IDLE_MINUTES,
  readSettings,
  type SquadProfile,
  type SquadSettings,
} from "../settings.js";

export type ConfigOrigin =
  | "schema-default"
  | "environment"
  | "user-settings"
  | "project-settings"
  | "user-permissions"
  | "catalog"
  | "cli";

export interface ConfigLayer {
  origin: ConfigOrigin;
  source: string;
  value?: unknown;
  version?: string;
  disabledReason?: string;
}

export interface EffectiveConfigEntry extends ConfigLayer {
  key: string;
  layers: ConfigLayer[];
}

export class ConfigurationStack {
  private readonly entries = new Map<string, EffectiveConfigEntry>();

  add(key: string, layers: ConfigLayer[]): void {
    const effective = [...layers]
      .reverse()
      .find((layer) => layer.value !== undefined || layer.disabledReason);
    if (!effective) return;
    this.entries.set(key, { key, ...effective, layers: [...layers] });
  }

  explain(key: string): EffectiveConfigEntry | undefined {
    return this.entries.get(key);
  }

  list(): EffectiveConfigEntry[] {
    return [...this.entries.values()].sort((a, b) =>
      a.key.localeCompare(b.key),
    );
  }
}

export interface RuntimeCliConfig {
  provider?: string;
  model?: string;
  profile?: string;
  mode?: string;
  allowedTools?: string;
  disallowedTools?: string;
  dangerouslySkipPermissions?: boolean;
  dangerouslySkipReadPermissions?: boolean;
  dangerouslyAllowDeletes?: boolean;
  yolo?: boolean;
}

export interface LoadedConfiguration {
  stack: ConfigurationStack;
  env: Env;
  settings: SquadSettings;
  catalog: ModelCatalog;
  hooks: LoadHooksResult;
  projectRules: RuleMap;
  userGlobalRules: RuleMap;
  provider: string;
  model: string;
  reviewModel: string;
  guardian: { enabled: boolean; model: string };
  profileName?: string;
  profileMode?: "plan" | "act";
  recapIdleMinutes: number;
  notifications: NotificationConfig;
}

export async function loadConfigurationStack(args: {
  cwd: string;
  cli?: RuntimeCliConfig;
}): Promise<LoadedConfiguration> {
  const env = loadEnv();
  const settings = await readSettings();
  const catalog = loadCatalog();
  const hooks = await loadHooks();
  const projectRules = await loadProjectRules(args.cwd);
  const userGlobalRules = await loadUserGlobalRules();
  const projectVersion = await readOptionalVersion(
    getProjectSettingsPath(args.cwd),
  );
  const userPermissionsVersion = await readOptionalVersion(
    getUserPermissionsPath(),
  );
  return buildConfigurationStack({
    cwd: args.cwd,
    cli: args.cli ?? {},
    env,
    settings,
    catalog,
    hooks,
    projectRules,
    userGlobalRules,
    envSources: environmentSources(env),
    ...(projectVersion !== undefined && { projectVersion }),
    ...(userPermissionsVersion !== undefined && { userPermissionsVersion }),
  });
}

export function buildConfigurationStack(input: {
  cwd: string;
  cli: RuntimeCliConfig;
  env: Env;
  settings: SquadSettings;
  catalog: ModelCatalog;
  hooks: LoadHooksResult;
  projectRules: RuleMap;
  userGlobalRules: RuleMap;
  envSources?: Partial<Record<keyof Env, string>>;
  projectVersion?: string;
  userPermissionsVersion?: string;
}): LoadedConfiguration {
  const stack = new ConfigurationStack();
  addEnvironmentEntries(stack, input.env, input.envSources ?? {});
  addSettingsEntries(stack, input.settings, input.hooks);
  addCatalogEntries(stack, input.catalog, input.env);
  addRuleEntries(stack, "permissions.project", input.projectRules, {
    origin: "project-settings",
    source: getProjectSettingsPath(input.cwd),
    ...(input.projectVersion && { version: input.projectVersion }),
    ...(!input.env.SQUAD_PROJECT_PERMS && {
      disabledReason: "SQUAD_PROJECT_PERMS is false",
    }),
  });
  addRuleEntries(stack, "permissions.user", input.userGlobalRules, {
    origin: "user-permissions",
    source: getUserPermissionsPath(),
    ...(input.userPermissionsVersion && {
      version: input.userPermissionsVersion,
    }),
  });

  const profileName = input.cli.profile ?? input.settings.default_profile;
  const profile = profileName
    ? resolveProfile(profileName, input.settings, input.env, input.catalog)
    : undefined;
  if (profileName) {
    stack.add("runtime.profile", [
      profile
        ? settingsLayer(profileName, input.settings)
        : {
            origin: "user-settings",
            source: "profile selection",
            disabledReason: `unknown profile ${profileName}`,
          },
    ]);
  }
  const providerLayers: ConfigLayer[] = [
    envLayer(
      "AI_DEFAULT_PROVIDER",
      input.env.AI_DEFAULT_PROVIDER,
      input.envSources,
    ),
  ];
  if (input.settings.defaultProvider) {
    providerLayers.push(
      settingsLayer(input.settings.defaultProvider, input.settings),
    );
  }
  if (profile?.provider) {
    providerLayers.push(settingsLayer(profile.provider, input.settings));
  }
  if (input.cli.provider) {
    providerLayers.push(cliLayer("--provider", input.cli.provider));
  }
  stack.add("runtime.provider", providerLayers);
  const provider = providerLayers.at(-1)?.value as string;

  const modelResolution = resolveModel(input, provider, profile?.model);
  stack.add("runtime.model", modelResolution.layers);
  const reviewModel = input.settings.review_model ?? input.env.OLLAMA_MODEL;
  const guardian = {
    enabled: input.settings.guardian?.enabled === true,
    model: input.settings.guardian?.model ?? input.env.OLLAMA_MODEL,
  };
  stack.add("settings.review_model", [
    {
      origin: "schema-default",
      source: "OLLAMA_MODEL local review default",
      value: input.env.OLLAMA_MODEL,
    },
    ...(input.settings.review_model
      ? [settingsLayer(input.settings.review_model, input.settings)]
      : []),
  ]);
  stack.add("settings.guardian.enabled", [
    {
      origin: "schema-default",
      source: "guardian opt-in default",
      value: false,
    },
    ...(input.settings.guardian?.enabled !== undefined
      ? [settingsLayer(guardian.enabled, input.settings)]
      : []),
  ]);
  stack.add("settings.guardian.model", [
    {
      origin: "schema-default",
      source: "OLLAMA_MODEL local guardian default",
      value: input.env.OLLAMA_MODEL,
    },
    ...(input.settings.guardian?.model
      ? [settingsLayer(guardian.model, input.settings)]
      : []),
  ]);
  stack.add("runtime.mode", [
    { origin: "schema-default", source: "mode default", value: "act" },
    ...(input.cli.mode ? [cliLayer("--mode", input.cli.mode)] : []),
  ]);
  for (const [key, value] of Object.entries(input.cli)) {
    if (
      value === undefined ||
      key === "provider" ||
      key === "model" ||
      key === "mode"
    ) {
      continue;
    }
    stack.add(`cli.${key}`, [cliLayer(`--${toKebabCase(key)}`, value)]);
  }

  const recapIdleMinutes = validRecapMinutes(input.settings.recap?.idleMinutes);
  stack.add("settings.recap.idleMinutes", [
    {
      origin: "schema-default",
      source: "built-in recap default",
      value: DEFAULT_RECAP_IDLE_MINUTES,
    },
    ...(input.settings.recap?.idleMinutes !== undefined
      ? [settingsLayer(recapIdleMinutes, input.settings)]
      : []),
  ]);
  const notifications = normalizeNotifications(input.settings);
  stack.add("settings.notifications.program", [
    {
      origin: "schema-default",
      source: "notifications disabled by default",
      disabledReason: "no notification program configured",
    },
    ...(notifications.program
      ? [settingsLayer(notifications.program, input.settings)]
      : []),
  ]);
  stack.add("settings.notifications.terminalMode", [
    {
      origin: "schema-default",
      source: "built-in notification default",
      value: "off",
    },
    ...(input.settings.notifications?.terminalMode !== undefined
      ? [settingsLayer(notifications.terminalMode, input.settings)]
      : []),
  ]);
  stack.add("settings.notifications.terminalMethod", [
    {
      origin: "schema-default",
      source: "built-in notification default",
      value: "osc9",
    },
    ...(input.settings.notifications?.terminalMethod !== undefined
      ? [settingsLayer(notifications.terminalMethod, input.settings)]
      : []),
  ]);

  return {
    stack,
    env: input.env,
    settings: input.settings,
    catalog: input.catalog,
    hooks: input.hooks,
    projectRules: input.projectRules,
    userGlobalRules: input.userGlobalRules,
    provider,
    model: modelResolution.model,
    reviewModel,
    guardian,
    ...(profileName && profile && { profileName }),
    ...(profile?.mode && { profileMode: profile.mode }),
    recapIdleMinutes,
    notifications,
  };
}

function addEnvironmentEntries(
  stack: ConfigurationStack,
  env: Env,
  sources: Partial<Record<keyof Env, string>>,
): void {
  for (const [key, raw] of Object.entries(env)) {
    const isSecret = /(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(key);
    const configured = raw !== undefined && raw !== "";
    stack.add(`env.${key}`, [
      {
        origin: sources[key as keyof Env] ? "environment" : "schema-default",
        source: sources[key as keyof Env] ?? "zod environment schema default",
        value: isSecret ? (configured ? "[configured]" : undefined) : raw,
        ...(isSecret && !configured && { disabledReason: "not configured" }),
      },
    ]);
  }
}

function addSettingsEntries(
  stack: ConfigurationStack,
  settings: SquadSettings,
  hooks: LoadHooksResult,
): void {
  const metadata = {
    origin: "user-settings" as const,
    source: join("~", ".squad", "settings.json"),
    version: settings.version,
  };
  for (const [key, value] of Object.entries(settings)) {
    if (key === "hooks" || key === "recap" || key === "notifications") continue;
    stack.add(`settings.${key}`, [{ ...metadata, value }]);
  }
  for (const hook of hooks.hooks) {
    stack.add(`hooks.${hook.id}`, [{ ...metadata, value: hook }]);
  }
  if (hooks.invalidCount > 0) {
    stack.add("hooks.invalid", [
      {
        ...metadata,
        disabledReason: `${hooks.invalidCount} invalid hook entr${hooks.invalidCount === 1 ? "y" : "ies"}`,
      },
    ]);
  }
}

function addCatalogEntries(
  stack: ConfigurationStack,
  catalog: ModelCatalog,
  env: Env,
): void {
  for (const model of catalog.list()) {
    const provenance = catalog.provenance(model.id);
    const missingKey =
      model.env_key_var &&
      !(env as unknown as Record<string, unknown>)[model.env_key_var];
    stack.add(`catalog.models.${model.id}`, [
      {
        origin: "catalog",
        source: provenance?.source ?? "model catalog",
        value: summarizeModel(model),
        ...(provenance?.version && { version: provenance.version }),
        ...(missingKey && {
          disabledReason: `${model.env_key_var} is not configured`,
        }),
      },
    ]);
  }
}

function addRuleEntries(
  stack: ConfigurationStack,
  prefix: string,
  rules: RuleMap,
  metadata: Omit<ConfigLayer, "value">,
): void {
  for (const [tool, list] of rules) {
    for (const rule of list) {
      stack.add(`${prefix}.${tool}.${rule.pattern}`, [
        { ...metadata, value: rule.action },
      ]);
    }
  }
}

function resolveModel(
  input: Parameters<typeof buildConfigurationStack>[0],
  provider: string,
  profileModel?: string,
): { model: string; layers: ConfigLayer[] } {
  const layers: ConfigLayer[] = [];
  const providerDefault = defaultModelFor(
    input.catalog,
    provider,
    input.env,
    input.envSources,
  );
  if (providerDefault) layers.push(providerDefault);
  if (input.env.AI_DEFAULT_MODEL) {
    layers.push(
      envLayer(
        "AI_DEFAULT_MODEL",
        input.env.AI_DEFAULT_MODEL,
        input.envSources,
      ),
    );
  }
  if (
    input.settings.defaultModel &&
    (!input.settings.defaultProvider ||
      input.settings.defaultProvider === provider)
  ) {
    layers.push(settingsLayer(input.settings.defaultModel, input.settings));
  }
  if (profileModel) {
    layers.push(settingsLayer(profileModel, input.settings));
  }
  if (input.cli.model) layers.push(cliLayer("--model", input.cli.model));
  if (layers.length === 0) {
    layers.push({
      origin: "catalog",
      source: "model catalog",
      value: "",
      disabledReason: `no model is configured for provider ${provider}`,
    });
  }
  return { model: (layers.at(-1)?.value as string) ?? "", layers };
}

function resolveProfile(
  name: string,
  settings: SquadSettings,
  env: Env,
  catalog: ModelCatalog,
): SquadProfile | undefined {
  const reviewEntry = catalog.get(settings.review_model ?? env.OLLAMA_MODEL);
  const builtIns: Record<string, SquadProfile> = {
    local: { provider: "ollama", model: env.OLLAMA_MODEL, mode: "act" },
    cloud: { provider: env.AI_DEFAULT_PROVIDER, mode: "plan" },
    review: {
      ...(reviewEntry && { provider: reviewEntry.provider_id }),
      model: settings.review_model ?? env.OLLAMA_MODEL,
      mode: "plan",
    },
  };
  return settings.profiles?.[name] ?? builtIns[name];
}

function defaultModelFor(
  catalog: ModelCatalog,
  provider: string,
  env: Env,
  sources: Partial<Record<keyof Env, string>> = {},
): ConfigLayer | undefined {
  const byProvider: Record<string, [key: keyof Env, value: string]> = {
    deepseek: ["DEEPSEEK_MODEL", env.DEEPSEEK_MODEL],
    ollama: ["OLLAMA_MODEL", env.OLLAMA_MODEL],
    openai: ["OPENAI_MODEL", env.OPENAI_MODEL],
    anthropic: ["ANTHROPIC_MODEL", env.ANTHROPIC_MODEL],
  };
  const configured = byProvider[provider];
  if (configured) return envLayer(configured[0], configured[1], sources);
  const first = catalog.byProvider(provider)[0];
  if (!first) return undefined;
  const provenance = catalog.provenance(first.id);
  return {
    origin: "catalog",
    source: provenance?.source ?? "model catalog",
    value: first.id,
    ...(provenance?.version && { version: provenance.version }),
  };
}

function envLayer(
  key: keyof Env,
  value: unknown,
  sources: Partial<Record<keyof Env, string>> = {},
): ConfigLayer {
  return {
    origin: sources[key] ? "environment" : "schema-default",
    source: sources[key] ?? `environment schema default for ${key}`,
    value,
  };
}

function settingsLayer(value: unknown, settings: SquadSettings): ConfigLayer {
  return {
    origin: "user-settings",
    source: join("~", ".squad", "settings.json"),
    version: settings.version,
    value,
  };
}

function cliLayer(source: string, value: unknown): ConfigLayer {
  return { origin: "cli", source, value };
}

function validRecapMinutes(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_RECAP_IDLE_MINUTES;
}

function normalizeNotifications(settings: SquadSettings): NotificationConfig {
  const raw = settings.notifications;
  const program =
    typeof raw?.program === "string" && raw.program.trim().length > 0
      ? raw.program.trim()
      : undefined;
  const terminalMode = ["off", "unfocused", "always"].includes(
    raw?.terminalMode ?? "",
  )
    ? (raw?.terminalMode as NotificationConfig["terminalMode"])
    : "off";
  const terminalMethod = ["osc9", "bell"].includes(raw?.terminalMethod ?? "")
    ? (raw?.terminalMethod as NotificationConfig["terminalMethod"])
    : "osc9";
  return {
    ...(program && { program }),
    terminalMode,
    terminalMethod,
  };
}

function summarizeModel(model: ModelEntry): Record<string, unknown> {
  return {
    provider: model.provider_id,
    kind: model.kind,
    baseUrl: model.base_url,
    capabilities: model.capabilities ?? {},
  };
}

async function readOptionalVersion(path: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function environmentSources(env: Env): Partial<Record<keyof Env, string>> {
  const sources: Partial<Record<keyof Env, string>> = {};
  for (const key of Object.keys(env) as Array<keyof Env>) {
    if (process.env[key] !== undefined) {
      sources[key] = "process environment or loaded .env file";
    }
  }
  return sources;
}

function toKebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
