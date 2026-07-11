import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIndexFetchTool } from "../src/tools/index-fetch.js";
import type { Manifest } from "../src/tools/manifest.js";
import type { ToolContext } from "../src/tools/types.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "squad-fetch-test-"));
}

function ctx(cwd: string): ToolContext {
  return { cwd, callId: "test", signal: new AbortController().signal };
}

function fixtureManifest(): Manifest {
  return {
    manifest_version: 1,
    project: "fixture",
    generated_at: "2026-05-07T00:00:00Z",
    generator: "test/0.0.1",
    entries: [
      {
        path: "src/foo.ts",
        kind: "typescript_module",
        summary: "foo",
        signatures: [],
        tags: [],
      },
    ],
  };
}

async function writeFixture(
  cwd: string,
  rel: string,
  contents: string,
): Promise<void> {
  const full = join(cwd, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, contents, "utf-8");
}

describe("IndexFetch", () => {
  it("returns INDEXER_ABSENT when manifest is null", async () => {
    const cwd = await makeTempDir();
    const tool = createIndexFetchTool(null);
    const result = await tool.execute({ path: "src/foo.ts" }, ctx(cwd));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("INDEXER_ABSENT");
  });

  it("returns PATH_NOT_IN_MANIFEST for unknown paths", async () => {
    const cwd = await makeTempDir();
    const tool = createIndexFetchTool(fixtureManifest());
    const result = await tool.execute({ path: "src/nope.ts" }, ctx(cwd));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("PATH_NOT_IN_MANIFEST");
  });

  it("reads file contents for a path that's in the manifest", async () => {
    const cwd = await makeTempDir();
    await writeFixture(cwd, "src/foo.ts", "export const FOO = 1;\n");
    const tool = createIndexFetchTool(fixtureManifest());
    const result = await tool.execute({ path: "src/foo.ts" }, ctx(cwd));
    expect(result.ok).toBe(true);
    expect(result.content).toBe("export const FOO = 1;\n");
  });

  it("rejects path-traversal attempts even if a manifest entry claims it", async () => {
    const cwd = await makeTempDir();
    const m = fixtureManifest();
    m.entries[0]!.path = "../escape.ts";
    const tool = createIndexFetchTool(m);
    await expect(
      tool.execute({ path: "../escape.ts" }, ctx(cwd)),
    ).rejects.toThrow();
  });
});
