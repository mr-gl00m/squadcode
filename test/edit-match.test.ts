import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { editTool } from "../src/tools/edit.js";
import { countOccurrences, resolveEditMatch } from "../src/tools/edit-match.js";
import type { ToolContext } from "../src/tools/types.js";

function ctx(cwd: string): ToolContext {
  return { cwd, callId: "test", signal: new AbortController().signal };
}

describe("resolveEditMatch ladder", () => {
  it("stage 1: exact match wins and reports exact", () => {
    const content = "alpha\nbeta\ngamma\n";
    const m = resolveEditMatch(content, "beta");
    expect(m).toEqual({ ok: true, matched: "beta", stage: "exact" });
  });

  it("stage 2: line-trimmed matches when per-line indentation differs", () => {
    const content = "function f() {\n    return 1;\n}\n";
    const m = resolveEditMatch(content, "function f() {\nreturn 1;\n}");
    expect(m.ok).toBe(true);
    if (m.ok) {
      expect(m.stage).toBe("line-trimmed");
      // The matched text is the original, indentation intact.
      expect(m.matched).toBe("function f() {\n    return 1;\n}");
    }
  });

  it("stage 2: trailing newline on old_string is tolerated", () => {
    const content = "one\n  two\nthree\n";
    const m = resolveEditMatch(content, "\ttwo\n");
    expect(m.ok).toBe(true);
    if (m.ok) expect(m.matched).toBe("  two");
  });

  it("stage 3: whitespace-normalized matches collapsed internal spacing", () => {
    const content = "const x    =    1;\n";
    const m = resolveEditMatch(content, "const x = 1;");
    expect(m.ok).toBe(true);
    if (m.ok) {
      expect(m.stage).toBe("whitespace-normalized");
      expect(m.matched).toBe("const x    =    1;");
    }
  });

  it("stage 3: single-line fragment inside a longer line resolves to the actual slice", () => {
    const content = "if (a  &&  b) { doThing(); }\n";
    const m = resolveEditMatch(content, "a && b");
    expect(m.ok).toBe(true);
    if (m.ok) expect(m.matched).toBe("a  &&  b");
  });

  it("stage 4: indentation-flexible matches a block quoted at the wrong depth", () => {
    const content = [
      "class A {",
      "  method() {",
      "    if (x) {",
      "      go();",
      "    }",
      "  }",
      "}",
    ].join("\n");
    // Model quoted the if-block dedented by one level, but per-line relative
    // indentation is intact — line-trimmed can't see relative indent, this can.
    const find = ["  if (x) {", "    go();", "  }"].join("\n");
    const m = resolveEditMatch(content, find);
    expect(m.ok).toBe(true);
    if (m.ok) {
      expect(m.matched).toBe(
        ["    if (x) {", "      go();", "    }"].join("\n"),
      );
    }
  });

  it('stage 5: escape-normalized recovers literal \\n and \\" sequences', () => {
    const content = 'console.log("a\tb");\n';
    const m = resolveEditMatch(content, 'console.log(\\"a\\tb\\");');
    expect(m.ok).toBe(true);
    if (m.ok) {
      expect(m.stage).toBe("escape-normalized");
      expect(m.matched).toBe('console.log("a\tb");');
    }
  });

  it("stage 6: trimmed-boundary strips stray whole-block boundary whitespace", () => {
    const content = "alpha\nunique_line\ngamma\n";
    const m = resolveEditMatch(content, "\nunique_line\n\n");
    expect(m.ok).toBe(true);
    if (m.ok) expect(m.matched).toBe("unique_line");
  });

  it("stage 7: block-anchor matches on first/last line when the middle drifted", () => {
    const content = [
      "export function parse(input) {",
      "  const trimmed = input.trim();",
      "  return JSON.parse(trimmed);",
      "}",
    ].join("\n");
    const find = [
      "export function parse(input) {",
      "  const t = input.trim(); // slightly misquoted middle",
      "  return JSON.parse(t);",
      "}",
    ].join("\n");
    const m = resolveEditMatch(content, find);
    expect(m.ok).toBe(true);
    if (m.ok) {
      expect(m.stage).toBe("block-anchor");
      expect(m.matched).toBe(content);
    }
  });

  it("stage 7: multiple anchor candidates pick the most similar middle", () => {
    const content = [
      "function a() {",
      "  return alphaValue;",
      "}",
      "",
      "function b() {",
      "  return betaValue;",
      "}",
    ]
      .join("\n")
      .replace(/function a\(\) \{/, "wrap {")
      .replace(/function b\(\) \{/, "wrap {");
    const find = ["wrap {", "  return betaValue; // note", "}"].join("\n");
    const m = resolveEditMatch(content, find);
    expect(m.ok).toBe(true);
    if (m.ok) {
      expect(m.matched).toContain("betaValue");
      expect(m.matched).not.toContain("alphaValue");
    }
  });

  it("refuses ambiguous matches instead of guessing", () => {
    const content = "dup\nother\ndup\n";
    const m = resolveEditMatch(content, "dup");
    expect(m).toEqual({ ok: false, reason: "not_unique" });
  });

  it("refuses ambiguity found only by a fuzzy stage", () => {
    const content = "  x = 1\nmid\n  x = 1\n";
    const m = resolveEditMatch(content, "x = 1");
    expect(m).toEqual({ ok: false, reason: "not_unique" });
  });

  it("reports no_match when nothing on the ladder hits", () => {
    const m = resolveEditMatch("alpha\nbeta\n", "does not exist anywhere");
    expect(m).toEqual({ ok: false, reason: "no_match" });
  });

  it("replaceAll accepts a multi-occurrence candidate", () => {
    const content = "dup\nother\ndup\n";
    const m = resolveEditMatch(content, "dup", { replaceAll: true });
    expect(m.ok).toBe(true);
    if (m.ok) expect(m.matched).toBe("dup");
  });

  it("counts occurrences", () => {
    expect(countOccurrences("aXbXc", "X")).toBe(2);
    expect(countOccurrences("aaa", "aa")).toBe(1);
    expect(countOccurrences("abc", "")).toBe(0);
  });
});

describe("edit tool with fallback ladder", () => {
  it("applies a line-trimmed fallback edit and reports the stage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squad-edit-match-"));
    const path = join(dir, "f.ts");
    await writeFile(path, "function f() {\n    return 1;\n}\n", "utf-8");
    const result = await editTool.execute(
      {
        path,
        old_string: "function f() {\nreturn 1;\n}",
        new_string: "function f() {\n    return 2;\n}",
      },
      ctx(dir),
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("line-trimmed fallback");
    const after = await readFile(path, "utf-8");
    expect(after).toBe("function f() {\n    return 2;\n}\n");
  });

  it("exact edits stay silent about the ladder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squad-edit-match-"));
    const path = join(dir, "g.txt");
    await writeFile(path, "alpha\nbeta\n", "utf-8");
    const result = await editTool.execute(
      { path, old_string: "beta", new_string: "BETA" },
      ctx(dir),
    );
    expect(result.ok).toBe(true);
    expect(result.content).not.toContain("fallback");
  });

  it("still refuses non-unique old_string through the ladder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squad-edit-match-"));
    const path = join(dir, "h.txt");
    await writeFile(path, "dup\nmid\ndup\n", "utf-8");
    const result = await editTool.execute(
      { path, old_string: "dup", new_string: "D" },
      ctx(dir),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("EDIT_NOT_UNIQUE");
  });

  it("records touched files into a diagnostics tracker on success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squad-edit-match-"));
    const path = join(dir, "t.txt");
    await writeFile(path, "alpha\n", "utf-8");
    const touched: string[] = [];
    const c: ToolContext = {
      ...ctx(dir),
      diagnostics: {
        recordTouched: (p: string) => {
          touched.push(p);
        },
        drainTouched: () => [],
        hasPending: () => false,
      },
    };
    const result = await editTool.execute(
      { path, old_string: "alpha", new_string: "ALPHA" },
      c,
    );
    expect(result.ok).toBe(true);
    expect(touched).toHaveLength(1);
    expect(touched[0]!.toLowerCase()).toContain("t.txt");
  });
});
