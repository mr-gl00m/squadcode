import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadCatalog,
  type ModelEntry,
  resolveEntry,
} from "../src/providers/catalog.js";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "squad-catalog-test-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function writeCatalog(path: string, models: ModelEntry[]): void {
  writeFileSync(path, JSON.stringify({ version: "1", models }, null, 2));
}

describe("loadCatalog", () => {
  it("loads the default catalog seed", () => {
    const cat = loadCatalog({ userPath: join(scratch, "missing.json") });
    expect(cat.list().length).toBeGreaterThan(0);
    expect(cat.get("deepseek-chat")).toBeDefined();
    expect(cat.get("claude-sonnet-4-6")?.kind).toBe("llm-message");
  });

  it("treats a missing user override as no override", () => {
    const cat = loadCatalog({
      defaultPath: join(scratch, "default.json"),
      userPath: join(scratch, "user.json"),
    });
    expect(cat.list()).toEqual([]);
  });

  it("returns aliases via get()", () => {
    const cat = loadCatalog({ userPath: join(scratch, "missing.json") });
    expect(cat.get("deepseek-v4-flash")?.id).toBe("deepseek-chat");
    expect(cat.get("deepseek-v4-pro")?.id).toBe("deepseek-reasoner");
  });

  it("user overrides win over defaults by id", () => {
    const defaultPath = join(scratch, "default.json");
    const userPath = join(scratch, "user.json");
    writeCatalog(defaultPath, [
      {
        id: "shared",
        provider_id: "deepseek",
        kind: "llm-chat",
        base_url: "https://api.deepseek.com",
      },
    ]);
    writeCatalog(userPath, [
      {
        id: "shared",
        provider_id: "deepseek",
        kind: "llm-chat",
        base_url: "https://override.example",
      },
    ]);
    const cat = loadCatalog({ defaultPath, userPath });
    expect(cat.get("shared")?.base_url).toBe("https://override.example");
  });

  it("user overrides extend defaults with new entries", () => {
    const defaultPath = join(scratch, "default.json");
    const userPath = join(scratch, "user.json");
    writeCatalog(defaultPath, [
      {
        id: "a",
        provider_id: "deepseek",
        kind: "llm-chat",
        base_url: "https://api.deepseek.com",
      },
    ]);
    writeCatalog(userPath, [
      {
        id: "b",
        provider_id: "groq",
        kind: "llm-chat",
        base_url: "https://api.groq.com/openai/v1",
      },
    ]);
    const cat = loadCatalog({ defaultPath, userPath });
    expect(
      cat
        .list()
        .map((e) => e.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("ignores a malformed user override but keeps defaults", () => {
    const defaultPath = join(scratch, "default.json");
    const userPath = join(scratch, "user.json");
    writeCatalog(defaultPath, [
      {
        id: "a",
        provider_id: "deepseek",
        kind: "llm-chat",
        base_url: "https://api.deepseek.com",
      },
    ]);
    writeFileSync(userPath, "{not json");
    const cat = loadCatalog({ defaultPath, userPath });
    expect(cat.list().map((e) => e.id)).toEqual(["a"]);
  });

  it("rejects an unknown kind via zod", () => {
    const userPath = join(scratch, "user.json");
    writeFileSync(
      userPath,
      JSON.stringify({
        version: "1",
        models: [
          {
            id: "bad",
            provider_id: "x",
            kind: "made-up-kind",
            base_url: "https://example.com",
          },
        ],
      }),
    );
    const cat = loadCatalog({
      defaultPath: join(scratch, "missing-default.json"),
      userPath,
    });
    expect(cat.list()).toEqual([]);
  });

  it("byProvider and byKind filter as expected", () => {
    const cat = loadCatalog({ userPath: join(scratch, "missing.json") });
    const anthropic = cat.byProvider("anthropic");
    expect(anthropic.length).toBeGreaterThan(0);
    expect(anthropic.every((e) => e.kind === "llm-message")).toBe(true);
    const responses = cat.byKind("llm-response");
    expect(responses.every((e) => e.provider_id === "openai")).toBe(true);
  });

  it("extraEntries wins over both defaults and user overrides", () => {
    const userPath = join(scratch, "user.json");
    writeCatalog(userPath, [
      {
        id: "deepseek-chat",
        provider_id: "deepseek",
        kind: "llm-chat",
        base_url: "https://user-override.example",
      },
    ]);
    const cat = loadCatalog({
      userPath,
      extraEntries: [
        {
          id: "deepseek-chat",
          provider_id: "deepseek",
          kind: "llm-chat",
          base_url: "https://test-extra.example",
        },
      ],
    });
    expect(cat.get("deepseek-chat")?.base_url).toBe(
      "https://test-extra.example",
    );
  });
});

describe("resolveEntry", () => {
  it("returns the entry when model id matches", () => {
    const cat = loadCatalog({ userPath: join(scratch, "missing.json") });
    const entry = resolveEntry(cat, "deepseek", "deepseek-chat");
    expect(entry?.id).toBe("deepseek-chat");
  });

  it("uses provider when only provider is given", () => {
    const cat = loadCatalog({ userPath: join(scratch, "missing.json") });
    const entry = resolveEntry(cat, "anthropic", undefined);
    expect(entry?.provider_id).toBe("anthropic");
  });

  it("returns undefined when nothing matches", () => {
    const cat = loadCatalog({ userPath: join(scratch, "missing.json") });
    expect(resolveEntry(cat, "nonexistent", undefined)).toBeUndefined();
  });

  it("rejects model+provider mismatch", () => {
    const cat = loadCatalog({ userPath: join(scratch, "missing.json") });
    const entry = resolveEntry(cat, "anthropic", "deepseek-chat");
    expect(entry).toBeUndefined();
  });
});
