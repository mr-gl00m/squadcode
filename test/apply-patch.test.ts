import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyHunkToContent,
  applyPatchTool,
  parseUnifiedDiff,
} from "../src/tools/apply-patch.js";
import type { ToolContext } from "../src/tools/types.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "squad-patch-"));
}

function ctx(cwd: string): ToolContext {
  return { cwd, callId: "test", signal: new AbortController().signal };
}

describe("parseUnifiedDiff", () => {
  it("parses a single-file modify patch", () => {
    const patch = [
      "--- a/foo.txt",
      "+++ b/foo.txt",
      "@@ -1,3 +1,3 @@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "",
    ].join("\n");
    const out = parseUnifiedDiff(patch);
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("foo.txt");
    expect(out[0]!.isNew).toBe(false);
    expect(out[0]!.hunks).toEqual([
      { oldString: "alpha\nbeta\ngamma", newString: "alpha\nBETA\ngamma" },
    ]);
  });

  it("parses a new-file patch via /dev/null source", () => {
    const patch = [
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+hello",
      "+world",
      "",
    ].join("\n");
    const out = parseUnifiedDiff(patch);
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("new.txt");
    expect(out[0]!.isNew).toBe(true);
    expect(out[0]!.hunks[0]).toEqual({
      oldString: "",
      newString: "hello\nworld",
    });
  });

  it("parses multiple files in one patch", () => {
    const patch = [
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "",
    ].join("\n");
    const out = parseUnifiedDiff(patch);
    expect(out).toHaveLength(2);
    expect(out[0]!.path).toBe("a.txt");
    expect(out[1]!.path).toBe("b.txt");
  });

  it("handles multiple hunks in a single file", () => {
    const patch = [
      "--- a/m.txt",
      "+++ b/m.txt",
      "@@ -1 +1 @@",
      "-one",
      "+ONE",
      "@@ -5 +5 @@",
      "-five",
      "+FIVE",
      "",
    ].join("\n");
    const out = parseUnifiedDiff(patch);
    expect(out[0]!.hunks).toHaveLength(2);
  });

  it("strips a/ and b/ git-style path prefixes", () => {
    const patch = [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "",
    ].join("\n");
    expect(parseUnifiedDiff(patch)[0]!.path).toBe("src/foo.ts");
  });

  it("throws on a --- line not followed by a +++ line", () => {
    const patch = [
      "--- a/foo.txt",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n");
    expect(() => parseUnifiedDiff(patch)).toThrow(/expected '\+\+\+ '/);
  });
});

describe("applyHunkToContent", () => {
  it("applies an exact-matching hunk", () => {
    const result = applyHunkToContent("alpha\nbeta\ngamma\n", {
      oldString: "alpha\nbeta\ngamma",
      newString: "alpha\nBETA\ngamma",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe("alpha\nBETA\ngamma\n");
  });

  it("falls back to line-trimmed match when trailing whitespace differs", () => {
    // Source has trailing whitespace on a line; hunk's oldString does not.
    const source = "alpha   \nbeta\ngamma\n";
    const result = applyHunkToContent(source, {
      oldString: "alpha\nbeta\ngamma",
      newString: "X\nY\nZ",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe("X\nY\nZ\n");
  });

  it("returns reason when no match found", () => {
    const result = applyHunkToContent("totally\ndifferent\ncontent\n", {
      oldString: "alpha\nbeta",
      newString: "BETA",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("hunk did not match");
  });
});

describe("ApplyPatch tool", () => {
  it("applies a single-file modify patch", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "foo.txt");
    await writeFile(path, "alpha\nbeta\ngamma\n", "utf-8");
    const patch = [
      "--- a/foo.txt",
      "+++ b/foo.txt",
      "@@ -1,3 +1,3 @@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "",
    ].join("\n");
    const result = await applyPatchTool.execute({ patch }, ctx(dir));
    expect(result.ok).toBe(true);
    expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
  });

  it("preserves CRLF line endings on the destination file", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "crlf.txt");
    await writeFile(path, "a\r\nb\r\nc\r\n", "utf-8");
    const patch = [
      "--- a/crlf.txt",
      "+++ b/crlf.txt",
      "@@ -1,3 +1,3 @@",
      " a",
      "-b",
      "+B",
      " c",
      "",
    ].join("\n");
    const result = await applyPatchTool.execute({ patch }, ctx(dir));
    expect(result.ok).toBe(true);
    expect(await readFile(path, "utf-8")).toBe("a\r\nB\r\nc\r\n");
  });

  it("creates a new file from a /dev/null patch", async () => {
    const dir = await makeTempDir();
    const patch = [
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+hello",
      "+world",
      "",
    ].join("\n");
    const result = await applyPatchTool.execute({ patch }, ctx(dir));
    expect(result.ok).toBe(true);
    expect(await readFile(join(dir, "new.txt"), "utf-8")).toBe(
      "hello\nworld",
    );
  });

  it("refuses to overwrite an existing file via new-file form", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "x.txt");
    await writeFile(path, "existing", "utf-8");
    const patch = [
      "--- /dev/null",
      "+++ b/x.txt",
      "@@ -0,0 +1,1 @@",
      "+new content",
      "",
    ].join("\n");
    const result = await applyPatchTool.execute({ patch }, ctx(dir));
    expect(result.ok).toBe(false);
    expect(result.content).toContain("already exists");
  });

  it("reports the failing hunk and stops on first failure", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "a.txt"), "alpha\n", "utf-8");
    await writeFile(join(dir, "b.txt"), "beta\n", "utf-8");
    const patch = [
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-totally not present",
      "+x",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1 +1 @@",
      "-beta",
      "+BETA",
      "",
    ].join("\n");
    const result = await applyPatchTool.execute({ patch }, ctx(dir));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("PATCH_APPLY_FAILED");
    expect(await readFile(join(dir, "b.txt"), "utf-8")).toBe("beta\n");
  });

  it("returns a stale-mtime error if metadata mtime doesn't match", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "race.txt");
    await writeFile(path, "alpha\nbeta\n", "utf-8");
    const patch = [
      "--- a/race.txt",
      "+++ b/race.txt",
      "@@ -1,2 +1,2 @@",
      " alpha",
      "-beta",
      "+BETA",
      "",
    ].join("\n");
    const preview = await applyPatchTool.preview!({ patch }, ctx(dir));
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(path, "alpha\nbeta\nzeta\n", "utf-8");
    const result = await applyPatchTool.execute(
      { patch },
      ctx(dir),
      preview.metadata,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("PATCH_STALE_MTIME");
  });
});
