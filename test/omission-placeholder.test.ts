import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editTool, checkEditPlaceholders } from "../src/tools/edit.js";
import { detectOmissionPlaceholders } from "../src/tools/omission-placeholder.js";
import { writeTool } from "../src/tools/write.js";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "squad-omission-test-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("detectOmissionPlaceholders", () => {
  it("matches the // rest of methods ... shape", () => {
    expect(detectOmissionPlaceholders("// rest of methods ...")).toEqual([
      "rest of methods ...",
    ]);
  });

  it("matches the (rest of code ...) shape", () => {
    expect(detectOmissionPlaceholders("(rest of code ...)")).toEqual([
      "rest of code ...",
    ]);
  });

  it("matches // unchanged code ...", () => {
    expect(detectOmissionPlaceholders("// unchanged code ...")).toEqual([
      "unchanged code ...",
    ]);
  });

  it("matches without leading // when bare-line", () => {
    expect(detectOmissionPlaceholders("rest of method ...")).toEqual([
      "rest of method ...",
    ]);
  });

  it("ignores literal ellipses without an OMITTED_PREFIX", () => {
    expect(detectOmissionPlaceholders("// TODO: ...")).toEqual([]);
    expect(detectOmissionPlaceholders("foo... bar")).toEqual([]);
  });

  it("ignores ellipses followed by trailing text that is not all dots", () => {
    expect(detectOmissionPlaceholders("// rest of code ... see issue")).toEqual(
      [],
    );
  });

  it("accepts trailing extra dots after the ellipsis", () => {
    expect(detectOmissionPlaceholders("// rest of methods ......")).toEqual([
      "rest of methods ...",
    ]);
  });

  it("returns multiple placeholders from the same content", () => {
    const text = `function foo() {
// rest of code ...
}
function bar() {
// unchanged methods ...
}`;
    expect(detectOmissionPlaceholders(text)).toEqual([
      "rest of code ...",
      "unchanged methods ...",
    ]);
  });

  it("collapses internal whitespace before prefix lookup", () => {
    expect(detectOmissionPlaceholders("//   rest    of    methods   ..."))
      .toEqual(["rest of methods ..."]);
  });

  it("normalizes \\r\\n line endings", () => {
    expect(detectOmissionPlaceholders("// rest of methods ...\r\nfoo"))
      .toEqual(["rest of methods ..."]);
  });

  it("returns [] for plain text", () => {
    expect(detectOmissionPlaceholders("export function foo() { return 1; }"))
      .toEqual([]);
  });
});

describe("checkEditPlaceholders", () => {
  it("passes when neither half has a placeholder", () => {
    expect(checkEditPlaceholders({ old_string: "foo", new_string: "bar" }))
      .toEqual({ ok: true });
  });

  it("allows an old_string-only placeholder", () => {
    // The match will either succeed (file literally contains the placeholder
    // text) or fail with EDIT_NO_MATCH naturally. No special refusal.
    expect(
      checkEditPlaceholders({
        old_string: "// rest of code ...",
        new_string: "literal",
      }),
    ).toEqual({ ok: true });
  });

  it("refuses when new_string adds a new placeholder line", () => {
    const r = checkEditPlaceholders({
      old_string: "literal",
      new_string: "literal\n// rest of methods ...",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("new_string");
      expect(r.message).toContain("rest of methods");
    }
  });

  it("allows a placeholder that is in both halves (preserving an abbreviation)", () => {
    expect(
      checkEditPlaceholders({
        old_string: "// rest of code ...",
        new_string: "// rest of code ...\n// new comment",
      }),
    ).toEqual({ ok: true });
  });

  it("does not match placeholders embedded mid-line", () => {
    // The detector walks lines; an `old_string` containing 'literal + // rest
    // of methods ...' on one line does NOT match because the line starts with
    // 'literal + //', not '//'. Pin this behavior so a future regex relaxation
    // doesn't silently widen the surface.
    expect(
      checkEditPlaceholders({
        old_string: "literal",
        new_string: "literal + // rest of methods ...",
      }),
    ).toEqual({ ok: true });
  });
});

describe("Edit tool preview surfaces placeholder rejection", () => {
  it("preview returns a placeholder-aware display before file I/O", async () => {
    // No file exists at scratch/missing.ts; if preview did file I/O before
    // the placeholder check, this would throw a path-not-found error.
    const ctx = { cwd: scratch, signal: new AbortController().signal, callId: "t" };
    const result = await editTool.preview!(
      {
        path: "missing.ts",
        old_string: "literal",
        new_string: "literal\n// rest of code ...",
      },
      ctx,
    );
    expect(result.display).toContain("missing.ts");
    expect(result.display).toContain("rest of code");
  });
});

describe("Edit tool refuses placeholders end-to-end", () => {
  it("returns EDIT_OMISSION_PLACEHOLDER when new_string has a placeholder", async () => {
    const file = join(scratch, "f.ts");
    writeFileSync(file, "function a() { return 1; }\n", "utf-8");
    const ctx = { cwd: scratch, signal: new AbortController().signal, callId: "t" };
    const result = await editTool.execute(
      {
        path: "f.ts",
        old_string: "return 1;",
        new_string: "return 1;\n// rest of code ...",
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("EDIT_OMISSION_PLACEHOLDER");
    // File untouched.
    expect(readFileSync(file, "utf-8")).toBe("function a() { return 1; }\n");
  });

  it("refuses on placeholder before path resolution would fail", async () => {
    const ctx = { cwd: scratch, signal: new AbortController().signal, callId: "t" };
    const result = await editTool.execute(
      {
        path: "missing.ts",
        old_string: "literal",
        new_string: "literal\n// rest of methods ...",
      },
      ctx,
    );
    // Placeholder check happens before path resolution, so we get the
    // placeholder error rather than a file-not-found error.
    expect(result.ok).toBe(false);
    expect(result.error).toBe("EDIT_OMISSION_PLACEHOLDER");
  });
});

describe("Write tool refuses placeholders end-to-end", () => {
  it("returns WRITE_OMISSION_PLACEHOLDER when content has a placeholder", async () => {
    const ctx = { cwd: scratch, signal: new AbortController().signal, callId: "t" };
    const result = await writeTool.execute(
      {
        path: "out.ts",
        content: "function a() {\n// rest of code ...\n}",
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("WRITE_OMISSION_PLACEHOLDER");
    // Verify the file was NOT created.
    let fileExists = true;
    try {
      readFileSync(join(scratch, "out.ts"), "utf-8");
    } catch {
      fileExists = false;
    }
    expect(fileExists).toBe(false);
  });

  it("writes normally when content is literal", async () => {
    const ctx = { cwd: scratch, signal: new AbortController().signal, callId: "t" };
    const result = await writeTool.execute(
      {
        path: "out.ts",
        content: "export const x = 1;",
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(join(scratch, "out.ts"), "utf-8")).toBe(
      "export const x = 1;",
    );
  });
});
