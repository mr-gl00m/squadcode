import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadManifest, MANIFEST_REL_PATH } from "../src/tools/manifest.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "squad-manifest-test-"));
}

async function writeManifest(cwd: string, body: unknown): Promise<void> {
  const dir = join(cwd, ".crabmeat");
  await mkdir(dir, { recursive: true });
  await writeFile(join(cwd, MANIFEST_REL_PATH), JSON.stringify(body), "utf-8");
}

describe("loadManifest", () => {
  it("returns null when no manifest file exists", async () => {
    const cwd = await makeTempDir();
    expect(loadManifest(cwd)).toBeNull();
  });

  it("returns null and warns when JSON is malformed", async () => {
    const cwd = await makeTempDir();
    const dir = join(cwd, ".crabmeat");
    await mkdir(dir, { recursive: true });
    await writeFile(join(cwd, MANIFEST_REL_PATH), "{not valid", "utf-8");
    expect(loadManifest(cwd)).toBeNull();
  });

  it("returns null when schema validation fails", async () => {
    const cwd = await makeTempDir();
    await writeManifest(cwd, { manifest_version: 99, project: "x" });
    expect(loadManifest(cwd)).toBeNull();
  });

  it("parses a minimal valid manifest with defaults filled in", async () => {
    const cwd = await makeTempDir();
    await writeManifest(cwd, {
      manifest_version: 1,
      project: "test-proj",
      generated_at: "2026-05-07T00:00:00Z",
      generator: "test/0.0.1",
      entries: [
        {
          path: "src/foo.ts",
          kind: "typescript_module",
          summary: "foo",
        },
      ],
    });
    const m = loadManifest(cwd);
    expect(m).not.toBeNull();
    expect(m?.project).toBe("test-proj");
    expect(m?.entries).toHaveLength(1);
    expect(m?.entries[0]?.tags).toEqual([]);
    expect(m?.entries[0]?.signatures).toEqual([]);
  });
});
