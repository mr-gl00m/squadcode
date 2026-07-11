import { describe, expect, it } from "vitest";
import {
  loadCatalog,
  type ModelEntry,
  resolveEntry,
} from "../src/providers/catalog.js";
import {
  formatResolveChain,
  resolveEntryTraced,
} from "../src/providers/dispatch.js";

const ENTRIES: ModelEntry[] = [
  {
    id: "deepseek-chat",
    provider_id: "deepseek",
    kind: "llm-chat",
    base_url: "https://api.deepseek.com",
    env_key_var: "DEEPSEEK_API_KEY",
    aliases: ["ds"],
  },
  {
    id: "deepseek-reasoner",
    provider_id: "deepseek",
    kind: "llm-chat",
    base_url: "https://api.deepseek.com",
    env_key_var: "DEEPSEEK_API_KEY",
  },
  {
    id: "claude-sonnet-4-6",
    provider_id: "anthropic",
    kind: "llm-message",
    base_url: "https://api.anthropic.com",
    env_key_var: "ANTHROPIC_API_KEY",
  },
];

// Isolate from the on-disk default + user catalogs by pointing both at paths
// that don't exist (loadFile returns [] on a missing file).
function fixtureCatalog() {
  return loadCatalog({
    defaultPath: "/no-such-default-catalog.json",
    userPath: "/no-such-user-catalog.json",
    extraEntries: ENTRIES,
  });
}

describe("resolveEntryTraced", () => {
  const catalog = fixtureCatalog();

  it("records a direct model-id hit", () => {
    const t = resolveEntryTraced(catalog, "deepseek", "deepseek-chat");
    expect(t.entry?.id).toBe("deepseek-chat");
    expect(t.chain).toEqual([
      {
        stage: "model_id",
        query: "deepseek-chat",
        outcome: "hit",
        matchedId: "deepseek-chat",
      },
    ]);
  });

  it("classifies an alias hit as the alias stage", () => {
    const t = resolveEntryTraced(catalog, undefined, "ds");
    expect(t.entry?.id).toBe("deepseek-chat");
    expect(t.chain[0]).toMatchObject({
      stage: "alias",
      query: "ds",
      outcome: "hit",
      matchedId: "deepseek-chat",
    });
    expect(t.reason).toContain("alias of deepseek-chat");
  });

  it("records the provider default when no model is given", () => {
    const t = resolveEntryTraced(catalog, "deepseek", undefined);
    expect(t.entry?.id).toBe("deepseek-chat");
    expect(t.chain[0]).toMatchObject({
      stage: "provider_default",
      query: "deepseek",
      outcome: "hit",
      matchedId: "deepseek-chat",
    });
  });

  it("reports a missing model id with no entry", () => {
    const t = resolveEntryTraced(catalog, "deepseek", "ghost-model");
    expect(t.entry).toBeUndefined();
    expect(t.chain[0]).toMatchObject({ stage: "model_id", outcome: "miss" });
    expect(t.reason).toContain("not in the catalog");
  });

  it("reports a provider/model mismatch and stays strict (no entry)", () => {
    const t = resolveEntryTraced(catalog, "anthropic", "deepseek-chat");
    expect(t.entry).toBeUndefined();
    expect(t.chain[0]).toMatchObject({
      stage: "model_id",
      outcome: "provider_mismatch",
      matchedId: "deepseek-chat",
    });
    expect(t.reason).toContain('belongs to provider "deepseek"');
  });

  it("reports an unknown provider with no entry", () => {
    const t = resolveEntryTraced(catalog, "ghost", undefined);
    expect(t.entry).toBeUndefined();
    expect(t.chain[0]).toMatchObject({
      stage: "provider_default",
      outcome: "miss",
    });
  });

  it("handles neither provider nor model specified", () => {
    const t = resolveEntryTraced(catalog, undefined, undefined);
    expect(t.entry).toBeUndefined();
    expect(t.chain).toEqual([]);
    expect(t.reason).toContain("neither");
  });
});

describe("formatResolveChain", () => {
  const catalog = fixtureCatalog();

  it("renders a hit chain compactly", () => {
    const t = resolveEntryTraced(catalog, undefined, "ds");
    expect(formatResolveChain(t)).toBe("alias(ds):hit->deepseek-chat");
  });

  it("renders the empty chain", () => {
    const t = resolveEntryTraced(catalog, undefined, undefined);
    expect(formatResolveChain(t)).toBe("(no lookup performed)");
  });
});

describe("resolveEntryTraced parity with resolveEntry", () => {
  const catalog = fixtureCatalog();
  const combos: Array<[string | undefined, string | undefined]> = [
    ["deepseek", "deepseek-chat"],
    [undefined, "ds"],
    ["deepseek", undefined],
    ["deepseek", "ghost-model"],
    ["anthropic", "deepseek-chat"],
    ["ghost", undefined],
    [undefined, undefined],
    [undefined, "claude-sonnet-4-6"],
  ];

  it("returns the same entry resolveEntry would for every combo", () => {
    for (const [provider, model] of combos) {
      const traced = resolveEntryTraced(catalog, provider, model).entry?.id;
      const direct = resolveEntry(catalog, provider, model)?.id;
      expect(traced, `${provider}/${model}`).toBe(direct);
    }
  });
});
