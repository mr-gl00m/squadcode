import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { logger } from "../logger.js";

// Adapter dispatch tag. Names the wire-format family the upstream speaks,
// not the vendor — DeepSeek, Together, Groq, Fireworks, OpenRouter, and
// classic gpt-4o all share llm-chat. The kind tells the catalog which
// adapter factory to instantiate; the vendor lives in `provider_id` and
// the URL/key live in `base_url` / `env_key_var`.
export type ProviderKind = "llm-chat" | "llm-response" | "llm-message" | "llm-local";

export const PROVIDER_KINDS: readonly ProviderKind[] = [
  "llm-chat",
  "llm-response",
  "llm-message",
  "llm-local",
] as const;

const capabilitiesSchema = z
  .object({
    tool_use: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    cache_control: z.boolean().optional(),
    thinking: z.boolean().optional(),
  })
  .strict();

const modelEntrySchema = z
  .object({
    id: z.string().min(1),
    provider_id: z.string().min(1),
    kind: z.enum(PROVIDER_KINDS as unknown as [ProviderKind, ...ProviderKind[]]),
    base_url: z.string().url(),
    // Optional env var that overrides base_url when set. Lets a user keep
    // their .env-driven URL config working without editing the catalog —
    // e.g. DEEPSEEK_BASE_URL for the DeepSeek row, OLLAMA_BASE_URL for the
    // Ollama row. The catalog's base_url is the fallback.
    base_url_env_var: z.string().optional(),
    env_key_var: z.string().optional(),
    capabilities: capabilitiesSchema.optional(),
    context_window: z.number().int().positive().optional(),
    aliases: z.array(z.string()).optional(),
  })
  .strict();

const catalogFileSchema = z
  .object({
    version: z.string().optional(),
    models: z.array(modelEntrySchema),
  })
  .strict();

export type ModelEntry = z.infer<typeof modelEntrySchema>;
export type ModelCapabilities = z.infer<typeof capabilitiesSchema>;
export type CatalogFile = z.infer<typeof catalogFileSchema>;

export interface ModelCatalog {
  list(): ModelEntry[];
  get(id: string): ModelEntry | undefined;
  byProvider(providerId: string): ModelEntry[];
  byKind(kind: ProviderKind): ModelEntry[];
}

const DEFAULT_CATALOG_PATH = fileURLToPath(
  new URL("./default-models.json", import.meta.url),
);

function userCatalogPath(): string {
  return join(homedir(), ".squad", "models.json");
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function loadFile(path: string, label: string): ModelEntry[] {
  if (!existsSync(path)) return [];
  try {
    const raw = readJsonFile(path);
    const parsed = catalogFileSchema.parse(raw);
    return parsed.models;
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), path, label },
      "model catalog file failed to parse; ignoring",
    );
    return [];
  }
}

// Merge entries by id. User overrides win — both for tweaking a default
// (different base_url, capabilities) and for adding new models. The default
// catalog is read-only on disk; overrides land in ~/.squad/models.json.
function mergeById(...sources: ModelEntry[][]): ModelEntry[] {
  const byId = new Map<string, ModelEntry>();
  for (const list of sources) {
    for (const entry of list) byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

export interface LoadCatalogOptions {
  defaultPath?: string;
  userPath?: string;
  extraEntries?: ModelEntry[];
}

export function loadCatalog(opts: LoadCatalogOptions = {}): ModelCatalog {
  const defaultPath = opts.defaultPath ?? DEFAULT_CATALOG_PATH;
  const userPath = opts.userPath ?? userCatalogPath();
  const defaults = loadFile(defaultPath, "default");
  const overrides = loadFile(userPath, "user");
  const extras = opts.extraEntries ?? [];
  const merged = mergeById(defaults, overrides, extras);

  // Build alias index alongside the primary id index.
  const byId = new Map<string, ModelEntry>();
  for (const e of merged) {
    byId.set(e.id, e);
    for (const alias of e.aliases ?? []) {
      if (!byId.has(alias)) byId.set(alias, e);
    }
  }

  return {
    list: () => [...merged],
    get: (id) => byId.get(id),
    byProvider: (providerId) =>
      merged.filter((e) => e.provider_id === providerId),
    byKind: (kind) => merged.filter((e) => e.kind === kind),
  };
}

// Resolve a (provider, model) pair to a catalog entry. Used by the CLI when
// the user passes --provider and --model (or the .env defaults). Strict on
// mismatch: an explicit --model that isn't in the catalog, or a model whose
// provider_id doesn't match an explicit --provider, returns undefined so the
// caller surfaces the typo rather than silently picking something else. If
// model is omitted, returns the first entry for the provider in catalog
// order.
export function resolveEntry(
  catalog: ModelCatalog,
  providerId: string | undefined,
  modelId: string | undefined,
): ModelEntry | undefined {
  if (modelId) {
    const direct = catalog.get(modelId);
    if (!direct) return undefined;
    if (providerId && direct.provider_id !== providerId) return undefined;
    return direct;
  }
  if (providerId) {
    const candidates = catalog.byProvider(providerId);
    if (candidates.length > 0) return candidates[0];
  }
  return undefined;
}
