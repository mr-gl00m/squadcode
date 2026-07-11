import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { grepTool } from "../src/tools/grep.js";

describe("Grep hardening", () => {
  it("rejects nested quantified regexes before scanning", async () => {
    const dir = join(tmpdir(), `squad-grep-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "x.txt"), `${"a".repeat(2000)}!\n`);

    const result = await grepTool.execute(
      { pattern: "^(a+)+$" },
      { cwd: dir, signal: new AbortController().signal, callId: "c1" },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("GREP_UNSAFE_REGEX");
  });

  it("rejects repeated ambiguous alternations and backreferences", async () => {
    const dir = join(tmpdir(), `squad-grep-${Date.now()}-ambiguous`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "x.txt"), `${"a".repeat(2000)}!\n`);

    for (const pattern of ["^(a|aa)+$", "^(a+)\\1+$"]) {
      const result = await grepTool.execute(
        { pattern },
        { cwd: dir, signal: new AbortController().signal, callId: "c2" },
      );
      expect(result.ok, pattern).toBe(false);
      expect(result.error, pattern).toBe("GREP_UNSAFE_REGEX");
    }
  });

  it("caps model-supplied regex length in both schemas", () => {
    const pattern = "a".repeat(501);
    expect(grepTool.inputZod.safeParse({ pattern }).success).toBe(false);
    expect(
      (grepTool.inputSchema.properties?.pattern as { maxLength?: number })
        .maxLength,
    ).toBe(500);
  });
});
