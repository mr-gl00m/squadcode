import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractSymbols } from "../src/repomap/symbols.js";

// Skip symbol-extraction tests when WASM assets aren't vendored — the runtime
// is still functional, just degraded. CI environments that don't run
// scripts/refresh-repomap-wasm.mjs will skip these and pass.
const here = dirname(fileURLToPath(import.meta.url));
const wasmDir = resolve(here, "..", "assets", "repomap", "wasm");
const hasWasm = existsSync(join(wasmDir, "tree-sitter-typescript.wasm"));

const describeWasm = hasWasm ? describe : describe.skip;

describeWasm("extractSymbols (requires vendored WASM grammars)", () => {
  it("extracts function definitions and call references from TypeScript", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "squad-repomap-symbols-"));
    const file = join(cwd, "sample.ts");
    await writeFile(
      file,
      [
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
        "",
        "export function double(n: number): number {",
        "  return add(n, n);",
        "}",
      ].join("\n"),
      "utf-8",
    );
    const result = await extractSymbols(file, "typescript", 0, 0);
    expect(result).not.toBeNull();
    const names = result!.defs.map((d) => d.name).sort();
    expect(names).toEqual(["add", "double"]);
    const refNames = result!.refs.map((r) => r.name);
    expect(refNames).toContain("add");
  });

  it("returns null on unreadable file", async () => {
    const result = await extractSymbols(
      "/nonexistent/path/xyz.ts",
      "typescript",
      0,
      0,
    );
    expect(result).toBeNull();
  });

  it("extracts python class and function defs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "squad-repomap-symbols-"));
    const file = join(cwd, "sample.py");
    await writeFile(
      file,
      [
        "class Foo:",
        "    def bar(self):",
        "        return 1",
        "",
        "def baz():",
        "    return Foo().bar()",
      ].join("\n"),
      "utf-8",
    );
    const result = await extractSymbols(file, "python", 0, 0);
    expect(result).not.toBeNull();
    const names = result!.defs.map((d) => d.name).sort();
    expect(names).toContain("Foo");
    expect(names).toContain("bar");
    expect(names).toContain("baz");
  });
});
