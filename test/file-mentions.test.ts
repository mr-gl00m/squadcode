import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  expandFileMentions,
  fileMentionSuggestion,
} from "../src/cli/file-mentions.js";

describe("composer file mentions", () => {
  it("completes paths from the repomap file list", () => {
    const files = ["src/alpha.ts", "src/beta.ts"];
    expect(fileMentionSuggestion("inspect @src/al", 15, files)).toBe("pha.ts");
    expect(fileMentionSuggestion("inspect @missing", 16, files)).toBe("");
  });

  it("expands only indexed files as bounded untrusted context", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "squad-mentions-"));
    await mkdir(join(cwd, "src"));
    await writeFile(
      join(cwd, "src", "alpha.ts"),
      "const x = '<unsafe>';",
      "utf8",
    );
    const expanded = await expandFileMentions(
      "inspect @src/alpha.ts and @secret.txt",
      cwd,
      ["src/alpha.ts"],
    );
    expect(expanded).toContain('type="file_mention"');
    expect(expanded).toContain("&lt;unsafe&gt;");
    expect(expanded).toContain("@secret.txt");
  });
});
