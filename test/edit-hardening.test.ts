import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectAndStripBom, restoreBom } from "../src/bom.js";
import { withFileLock } from "../src/file-mutex.js";
import {
  detectLineEnding,
  normalizeToLf,
  restoreLineEnding,
} from "../src/line-endings.js";
import { editTool, makeEditDiffPreview } from "../src/tools/edit.js";
import type { ToolContext } from "../src/tools/types.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "squad-edit-test-"));
}

function ctx(cwd: string): ToolContext {
  return { cwd, callId: "test", signal: new AbortController().signal };
}

describe("bom utility", () => {
  const BOM = String.fromCharCode(0xfeff);

  it("strips the UTF-8 BOM and reports it back", () => {
    const { content, bom } = detectAndStripBom(`${BOM}hello`);
    expect(content).toBe("hello");
    expect(bom).toBe(BOM);
  });

  it("returns empty bom when none is present", () => {
    const { content, bom } = detectAndStripBom("hello");
    expect(content).toBe("hello");
    expect(bom).toBe("");
  });

  it("restores the BOM by prepending", () => {
    expect(restoreBom("hello", BOM)).toBe(`${BOM}hello`);
    expect(restoreBom("hello", "")).toBe("hello");
  });
});

describe("line-endings utility", () => {
  it("detects CRLF when CRLF dominates", () => {
    expect(detectLineEnding("a\r\nb\r\nc")).toBe("\r\n");
  });

  it("detects LF when LF dominates", () => {
    expect(detectLineEnding("a\nb\nc")).toBe("\n");
  });

  it("defaults to LF when there are no line breaks", () => {
    expect(detectLineEnding("single line")).toBe("\n");
  });

  it("normalizes CRLF to LF", () => {
    expect(normalizeToLf("a\r\nb\r\nc")).toBe("a\nb\nc");
  });

  it("restores CRLF from LF", () => {
    expect(restoreLineEnding("a\nb\nc", "\r\n")).toBe("a\r\nb\r\nc");
  });

  it("leaves LF content alone when restoring LF", () => {
    expect(restoreLineEnding("a\nb\nc", "\n")).toBe("a\nb\nc");
  });
});

describe("file-mutex utility", () => {
  it("serializes concurrent calls on the same path", async () => {
    const order: number[] = [];
    const work = (n: number, ms: number): Promise<void> =>
      withFileLock("/same/path", async () => {
        await new Promise((r) => setTimeout(r, ms));
        order.push(n);
      });
    await Promise.all([work(1, 30), work(2, 5), work(3, 5)]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("does not serialize calls on different paths", async () => {
    const start = Date.now();
    await Promise.all([
      withFileLock(
        "/path-a",
        () => new Promise<void>((r) => setTimeout(r, 30)),
      ),
      withFileLock(
        "/path-b",
        () => new Promise<void>((r) => setTimeout(r, 30)),
      ),
    ]);
    expect(Date.now() - start).toBeLessThan(70);
  });

  it("releases the lock when fn throws", async () => {
    await expect(
      withFileLock("/throws", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    let ran = false;
    await withFileLock("/throws", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

describe("edit tool hardening", () => {
  const BOM = String.fromCharCode(0xfeff);

  it("preserves CRLF line endings on write", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "crlf.txt");
    await writeFile(path, "alpha\r\nbeta\r\ngamma\r\n", "utf-8");
    const result = await editTool.execute(
      { path, old_string: "beta", new_string: "BETA" },
      ctx(dir),
    );
    expect(result.ok).toBe(true);
    const after = await readFile(path, "utf-8");
    expect(after).toBe("alpha\r\nBETA\r\ngamma\r\n");
  });

  it("preserves LF line endings on write", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "lf.txt");
    await writeFile(path, "alpha\nbeta\ngamma\n", "utf-8");
    const result = await editTool.execute(
      { path, old_string: "beta", new_string: "BETA" },
      ctx(dir),
    );
    expect(result.ok).toBe(true);
    const after = await readFile(path, "utf-8");
    expect(after).toBe("alpha\nBETA\ngamma\n");
  });

  it("preserves a UTF-8 BOM on write", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "bom.txt");
    await writeFile(path, `${BOM}alpha\nbeta\n`, "utf-8");
    const result = await editTool.execute(
      { path, old_string: "beta", new_string: "BETA" },
      ctx(dir),
    );
    expect(result.ok).toBe(true);
    const after = await readFile(path, "utf-8");
    expect(after).toBe(`${BOM}alpha\nBETA\n`);
  });

  it("matches old_string emitted with LF against a CRLF source file", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "match.txt");
    await writeFile(path, "alpha\r\nbeta\r\ngamma\r\n", "utf-8");
    const result = await editTool.execute(
      { path, old_string: "alpha\nbeta", new_string: "X\nY" },
      ctx(dir),
    );
    expect(result.ok).toBe(true);
    const after = await readFile(path, "utf-8");
    expect(after).toBe("X\r\nY\r\ngamma\r\n");
  });

  it("refuses to edit a file over the size cap", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "huge.txt");
    await writeFile(path, "x".repeat(5_000_001), "utf-8");
    const result = await editTool.execute(
      { path, old_string: "x", new_string: "y" },
      ctx(dir),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("EDIT_TOO_LARGE");
  });
});

describe("edit diff preview helper", () => {
  it("emits a path:line header and -/+ blocks for a single-line change", () => {
    const raw = "alpha\nbeta\ngamma\n";
    const out = makeEditDiffPreview({
      path: "x.txt",
      raw,
      oldStr: "beta",
      newStr: "BETA",
      at: raw.indexOf("beta"),
      replaceAll: false,
    });
    expect(out).toBe("x.txt:2\n- beta\n+ BETA");
  });

  it("annotates replace_all when there are multiple matches", () => {
    const raw = "x\nx\nx\n";
    const out = makeEditDiffPreview({
      path: "f.txt",
      raw,
      oldStr: "x",
      newStr: "y",
      at: 0,
      replaceAll: true,
    });
    expect(out.startsWith("f.txt:1  (replace_all — 3 matches; first shown)\n"))
      .toBe(true);
    expect(out.endsWith("- x\n+ y")).toBe(true);
  });

  it("renders multi-line old/new blocks with one prefix per line", () => {
    const raw = "a\nb\nc\n";
    const out = makeEditDiffPreview({
      path: "m.txt",
      raw,
      oldStr: "a\nb",
      newStr: "X\nY\nZ",
      at: 0,
      replaceAll: false,
    });
    expect(out).toBe("m.txt:1\n- a\n- b\n+ X\n+ Y\n+ Z");
  });
});

describe("edit tool preview()", () => {
  it("returns a diff display and mtime metadata", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "p.txt");
    await writeFile(path, "alpha\nbeta\ngamma\n", "utf-8");
    const preview = await editTool.preview!(
      { path, old_string: "beta", new_string: "BETA" },
      ctx(dir),
    );
    expect(preview.display).toContain("p.txt:2");
    expect(preview.display).toContain("- beta");
    expect(preview.display).toContain("+ BETA");
    expect(typeof (preview.metadata as { mtimeMs?: number })?.mtimeMs).toBe(
      "number",
    );
  });

  it("reports old_string-not-found in the display but still returns mtime", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "missing.txt");
    await writeFile(path, "alpha\n", "utf-8");
    const preview = await editTool.preview!(
      { path, old_string: "nope", new_string: "X" },
      ctx(dir),
    );
    expect(preview.display).toContain("old_string not found");
    expect(typeof (preview.metadata as { mtimeMs?: number })?.mtimeMs).toBe(
      "number",
    );
  });

  it("flags oversize files in the preview", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "huge.txt");
    await writeFile(path, "x".repeat(5_000_001), "utf-8");
    const preview = await editTool.preview!(
      { path, old_string: "x", new_string: "y" },
      ctx(dir),
    );
    expect(preview.display).toContain("exceeds");
  });
});

describe("edit stale-mtime check", () => {
  it("rejects when the file mtime moved between preview and execute", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "race.txt");
    await writeFile(path, "alpha\nbeta\n", "utf-8");
    const preview = await editTool.preview!(
      { path, old_string: "beta", new_string: "BETA" },
      ctx(dir),
    );
    // Simulate the user editing the file in another window while the prompt sits.
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(path, "alpha\nbeta\nzeta\n", "utf-8");
    const result = await editTool.execute(
      { path, old_string: "beta", new_string: "BETA" },
      ctx(dir),
      preview.metadata,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("EDIT_STALE_MTIME");
  });

  it("accepts when mtime matches what preview captured", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "fresh.txt");
    await writeFile(path, "alpha\nbeta\n", "utf-8");
    const preview = await editTool.preview!(
      { path, old_string: "beta", new_string: "BETA" },
      ctx(dir),
    );
    const result = await editTool.execute(
      { path, old_string: "beta", new_string: "BETA" },
      ctx(dir),
      preview.metadata,
    );
    expect(result.ok).toBe(true);
    const after = await readFile(path, "utf-8");
    expect(after).toBe("alpha\nBETA\n");
  });

  it("accepts when no metadata is provided (auto-allowed path)", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "auto.txt");
    await writeFile(path, "alpha\nbeta\n", "utf-8");
    const result = await editTool.execute(
      { path, old_string: "beta", new_string: "BETA" },
      ctx(dir),
    );
    expect(result.ok).toBe(true);
  });
});
