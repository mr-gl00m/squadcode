import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  openExternalEditor,
  splitEditorCommand,
} from "../src/cli/external-editor.js";

describe("external prompt editor", () => {
  it("parses quoted executable paths and arguments", () => {
    expect(
      splitEditorCommand('"C:\\Program Files\\Editor\\edit.exe" --wait'),
    ).toEqual(["C:\\Program Files\\Editor\\edit.exe", "--wait"]);
    expect(() => splitEditorCommand('"broken')).toThrow(/unterminated/);
  });

  it("round trips the draft through the configured editor", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "squad-editor-test-"));
    const script = join(cwd, "editor.mjs");
    await writeFile(
      script,
      'import {appendFile} from "node:fs/promises"; await appendFile(process.argv[2], "\\nchanged");',
      "utf8",
    );
    const command = `"${process.execPath}" "${script}"`;
    await expect(openExternalEditor("draft", cwd, command)).resolves.toBe(
      "draft\nchanged",
    );
  });
});
