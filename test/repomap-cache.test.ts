import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCached, writeCached } from "../src/repomap/cache.js";
import type { FileSymbols } from "../src/repomap/types.js";

function makeSymbols(mtimeMs: number, size: number): FileSymbols {
  return {
    path: "/tmp/x.ts",
    lang: "typescript",
    mtimeMs,
    size,
    defs: [{ name: "foo", kind: "function", line: 0, endLine: 0 }],
    refs: [],
  };
}

describe("repomap cache", () => {
  it("returns null when no entry exists", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "squad-repomap-cache-"));
    const got = await readCached(cacheDir, "/tmp/x.ts", 1, 100);
    expect(got).toBeNull();
  });

  it("returns the cached entry when mtime + size match", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "squad-repomap-cache-"));
    const symbols = makeSymbols(1234, 567);
    await writeCached(cacheDir, "/tmp/x.ts", symbols);
    const got = await readCached(cacheDir, "/tmp/x.ts", 1234, 567);
    expect(got).not.toBeNull();
    expect(got?.defs[0]?.name).toBe("foo");
  });

  it("invalidates on mtime mismatch", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "squad-repomap-cache-"));
    const symbols = makeSymbols(1234, 567);
    await writeCached(cacheDir, "/tmp/x.ts", symbols);
    const got = await readCached(cacheDir, "/tmp/x.ts", 9999, 567);
    expect(got).toBeNull();
  });

  it("invalidates on size mismatch", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "squad-repomap-cache-"));
    const symbols = makeSymbols(1234, 567);
    await writeCached(cacheDir, "/tmp/x.ts", symbols);
    const got = await readCached(cacheDir, "/tmp/x.ts", 1234, 999);
    expect(got).toBeNull();
  });

  it("keys per-path so two files don't collide", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "squad-repomap-cache-"));
    const a = makeSymbols(1, 1);
    const b = makeSymbols(1, 1);
    a.path = "/tmp/a.ts";
    b.path = "/tmp/b.ts";
    a.defs = [{ name: "alpha", kind: "function", line: 0, endLine: 0 }];
    b.defs = [{ name: "beta", kind: "function", line: 0, endLine: 0 }];
    await writeCached(cacheDir, a.path, a);
    await writeCached(cacheDir, b.path, b);
    const gotA = await readCached(cacheDir, a.path, 1, 1);
    const gotB = await readCached(cacheDir, b.path, 1, 1);
    expect(gotA?.defs[0]?.name).toBe("alpha");
    expect(gotB?.defs[0]?.name).toBe("beta");
  });
});
