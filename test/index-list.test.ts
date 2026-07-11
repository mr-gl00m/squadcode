import { describe, expect, it } from "vitest";
import { createIndexListTool } from "../src/tools/index-list.js";
import type { Manifest } from "../src/tools/manifest.js";
import type { ToolContext } from "../src/tools/types.js";

const MANIFEST: Manifest = {
  manifest_version: 1,
  project: "fixture",
  generated_at: "2026-05-07T00:00:00Z",
  generator: "test/0.0.1",
  entries: [
    {
      path: "src/engine/loop.ts",
      kind: "typescript_module",
      summary: "agent loop",
      signatures: [],
      tags: ["core", "agent-loop"],
    },
    {
      path: "src/engine/auto-compact.ts",
      kind: "typescript_module",
      summary: "context compaction",
      signatures: [],
      tags: ["core", "context"],
    },
    {
      path: "docs/PROVIDER_ROUTING.md",
      kind: "markdown_doc",
      summary: "routing rules",
      signatures: [],
      tags: ["docs", "routing"],
    },
  ],
};

function ctx(): ToolContext {
  return {
    cwd: process.cwd(),
    callId: "test",
    signal: new AbortController().signal,
  };
}

describe("IndexList", () => {
  it("reports indexer_present=false when manifest is null", async () => {
    const tool = createIndexListTool(null);
    const result = await tool.execute({}, ctx());
    expect(result.ok).toBe(true);
    const body = JSON.parse(result.content);
    expect(body.indexer_present).toBe(false);
  });

  it("returns all entries when no filter is given", async () => {
    const tool = createIndexListTool(MANIFEST);
    const result = await tool.execute({}, ctx());
    const body = JSON.parse(result.content);
    expect(body.indexer_present).toBe(true);
    expect(body.returned).toBe(3);
    expect(body.total).toBe(3);
  });

  it("filters by kind", async () => {
    const tool = createIndexListTool(MANIFEST);
    const result = await tool.execute({ kind: "markdown_doc" }, ctx());
    const body = JSON.parse(result.content);
    expect(body.returned).toBe(1);
    expect(body.entries[0].path).toBe("docs/PROVIDER_ROUTING.md");
  });

  it("filters by tags (all must match)", async () => {
    const tool = createIndexListTool(MANIFEST);
    const result = await tool.execute({ tags: ["core", "context"] }, ctx());
    const body = JSON.parse(result.content);
    expect(body.returned).toBe(1);
    expect(body.entries[0].path).toBe("src/engine/auto-compact.ts");
  });

  it("filters by path glob", async () => {
    const tool = createIndexListTool(MANIFEST);
    const result = await tool.execute({ path: "src/engine/**" }, ctx());
    const body = JSON.parse(result.content);
    expect(body.returned).toBe(2);
  });

  it("rejects unknown filter keys via zod", async () => {
    const tool = createIndexListTool(MANIFEST);
    await expect(
      tool.execute({ tags: "not-an-array" }, ctx()),
    ).rejects.toThrow();
  });
});
