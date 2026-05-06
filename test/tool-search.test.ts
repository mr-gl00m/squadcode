import { describe, expect, it } from "vitest";
import { defaultSystemPrompt } from "../src/cli/program.js";
import { createToolRegistry } from "../src/tools/registry.js";
import {
  createToolSearchTool,
  parseSelectQuery,
  scoreMatch,
  tokenize,
  type ToolSearchRegistryView,
} from "../src/tools/tool-search.js";
import type { ToolContext } from "../src/tools/types.js";

function ctx(): ToolContext {
  return {
    cwd: process.cwd(),
    callId: "test",
    signal: new AbortController().signal,
  };
}

function makeView(opts: {
  entries: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>;
  loaded?: Set<string>;
}): { view: ToolSearchRegistryView; loaded: Set<string> } {
  const loaded = opts.loaded ?? new Set<string>();
  const entries = opts.entries.map((e) => ({
    name: e.name,
    description: e.description,
    inputSchema: e.inputSchema ?? { type: "object", properties: {}, required: [] },
  }));
  const view: ToolSearchRegistryView = {
    deferredEntries: () => entries,
    isLoaded: (n) => loaded.has(n),
    markLoaded: (n) => {
      loaded.add(n);
      return true;
    },
  };
  return { view, loaded };
}

describe("registry deferral", () => {
  it("hides deferred tool schemas from toCanonicalSpecs but lists them in deferredCatalog", () => {
    const reg = createToolRegistry();
    const eager = reg.toCanonicalSpecs().map((t) => t.name);
    const catalog = reg.deferredCatalog().map((e) => e.name);
    expect(eager).toContain("Read");
    expect(eager).toContain("ToolSearch");
    expect(eager).not.toContain("ApplyPatch");
    expect(catalog).toEqual(["ApplyPatch"]);
  });

  it("ToolSearch itself is always eager (never deferred)", () => {
    const reg = createToolRegistry();
    expect(reg.deferredCatalog().some((e) => e.name === "ToolSearch")).toBe(false);
  });

  it("markLoaded promotes a deferred tool into toCanonicalSpecs", () => {
    const reg = createToolRegistry();
    expect(reg.toCanonicalSpecs().some((t) => t.name === "ApplyPatch")).toBe(false);
    expect(reg.markLoaded("ApplyPatch")).toBe(true);
    expect(reg.isLoaded("ApplyPatch")).toBe(true);
    expect(reg.toCanonicalSpecs().some((t) => t.name === "ApplyPatch")).toBe(true);
  });

  it("markLoaded refuses unknown or eager tools", () => {
    const reg = createToolRegistry();
    expect(reg.markLoaded("Read")).toBe(false);
    expect(reg.markLoaded("NoSuchTool")).toBe(false);
  });

  it("markLoadedFromMessages picks up deferred tool calls in a resumed history", () => {
    const reg = createToolRegistry();
    expect(reg.isLoaded("ApplyPatch")).toBe(false);
    reg.markLoadedFromMessages([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "Read", args: {} },
          { id: "c2", name: "ApplyPatch", args: { patch: "..." } },
        ],
      },
    ]);
    expect(reg.isLoaded("ApplyPatch")).toBe(true);
    expect(reg.loadedDeferredNames()).toEqual(["ApplyPatch"]);
  });
});

describe("ToolSearch query parsing", () => {
  it("tokenize splits on non-alphanumerics and drops single chars", () => {
    expect(tokenize("apply-patch v1.0")).toEqual(["apply", "patch", "v1"]);
    expect(tokenize("a b cd")).toEqual(["cd"]);
  });

  it("parseSelectQuery returns null for non-select queries", () => {
    expect(parseSelectQuery("just keywords")).toBeNull();
    expect(parseSelectQuery("")).toBeNull();
  });

  it("parseSelectQuery splits comma-separated names and trims", () => {
    expect(parseSelectQuery("select:Read, Edit ,ApplyPatch")).toEqual([
      "Read",
      "Edit",
      "ApplyPatch",
    ]);
  });

  it("parseSelectQuery accepts case-insensitive prefix", () => {
    expect(parseSelectQuery("Select:X")).toEqual(["X"]);
    expect(parseSelectQuery("SELECT:X,Y")).toEqual(["X", "Y"]);
  });

  it("scoreMatch awards higher weight to name hits than description hits", () => {
    const entry = {
      name: "ApplyPatch",
      description: "Apply a unified-diff patch covering one or more files.",
      inputSchema: {},
    };
    const nameOnly = scoreMatch(entry, ["applypatch"]);
    const descOnly = scoreMatch(entry, ["files"]);
    const both = scoreMatch(entry, ["patch", "diff"]);
    expect(nameOnly).toBeGreaterThan(descOnly);
    expect(both).toBeGreaterThan(nameOnly);
  });
});

describe("ToolSearch execute", () => {
  it("loads exact tools listed in a select: query", async () => {
    const { view, loaded } = makeView({
      entries: [
        { name: "ApplyPatch", description: "Apply a diff" },
        { name: "Other", description: "another deferred" },
      ],
    });
    const tool = createToolSearchTool(view);
    const result = await tool.execute({ query: "select:ApplyPatch" }, ctx());
    expect(result.ok).toBe(true);
    expect(loaded.has("ApplyPatch")).toBe(true);
    expect(loaded.has("Other")).toBe(false);
    expect(result.content).toContain("ApplyPatch");
    expect(result.content).toContain("inputSchema");
  });

  it("reports unknown names alongside successful loads", async () => {
    const { view, loaded } = makeView({
      entries: [{ name: "ApplyPatch", description: "Apply a diff" }],
    });
    const tool = createToolSearchTool(view);
    const result = await tool.execute(
      { query: "select:ApplyPatch,NoSuch" },
      ctx(),
    );
    expect(result.ok).toBe(true);
    expect(loaded.has("ApplyPatch")).toBe(true);
    expect(result.content).toContain("Unknown tool names: NoSuch");
  });

  it("scores keyword queries and loads top matches", async () => {
    const { view, loaded } = makeView({
      entries: [
        { name: "ApplyPatch", description: "Apply a unified-diff patch" },
        { name: "Other", description: "completely unrelated tool" },
      ],
    });
    const tool = createToolSearchTool(view);
    const result = await tool.execute({ query: "patch diff" }, ctx());
    expect(result.ok).toBe(true);
    expect(loaded.has("ApplyPatch")).toBe(true);
    expect(loaded.has("Other")).toBe(false);
  });

  it("returns a no-match notice when keywords miss everything", async () => {
    const { view, loaded } = makeView({
      entries: [{ name: "ApplyPatch", description: "Apply a unified-diff patch" }],
    });
    const tool = createToolSearchTool(view);
    const result = await tool.execute({ query: "completely irrelevant" }, ctx());
    expect(result.ok).toBe(true);
    expect(loaded.size).toBe(0);
    expect(result.content).toContain("No deferred tools matched");
    expect(result.content).toContain("ApplyPatch");
  });

  it("handles the empty-deferred-catalog case gracefully", async () => {
    const { view } = makeView({ entries: [] });
    const tool = createToolSearchTool(view);
    const result = await tool.execute({ query: "anything" }, ctx());
    expect(result.ok).toBe(true);
    expect(result.content).toContain("No deferred tools are registered");
  });

  it("respects max_results cap when ranking keyword matches", async () => {
    const { view, loaded } = makeView({
      entries: [
        { name: "PatchA", description: "Apply a patch" },
        { name: "PatchB", description: "Apply a patch" },
        { name: "PatchC", description: "Apply a patch" },
      ],
    });
    const tool = createToolSearchTool(view);
    await tool.execute({ query: "patch", max_results: 2 }, ctx());
    expect(loaded.size).toBe(2);
  });
});

describe("default system prompt with deferred catalog", () => {
  it("appends a deferred-catalog block when the registry has deferred tools", () => {
    const reg = createToolRegistry();
    const prompt = defaultSystemPrompt(reg);
    expect(prompt).toContain("Deferred tools");
    expect(prompt).toContain("ApplyPatch");
    expect(prompt).toContain("ToolSearch");
  });

  it("omits the deferred-catalog block when no registry is passed", () => {
    const prompt = defaultSystemPrompt();
    expect(prompt).not.toContain("Deferred tools");
  });
});

describe("ToolSearch loop integration through the registry", () => {
  it("a select: load via ToolSearch makes the schema appear in toCanonicalSpecs", async () => {
    const reg = createToolRegistry();
    const search = reg.get("ToolSearch");
    expect(search).toBeDefined();
    const result = await search!.execute({ query: "select:ApplyPatch" }, ctx());
    expect(result.ok).toBe(true);
    const eager = reg.toCanonicalSpecs().map((t) => t.name);
    expect(eager).toContain("ApplyPatch");
  });
});
