// Invariant: ApplyPatch is conventionally atomic — either every file in the
// patch lands, or none do. Quote (apply-patch.ts:148-151 description):
// "Apply a unified-diff patch covering one or more files."
// Violation: when an early file applies but a later file's hunk fails to
// match, the early file remains modified on disk. The error path returns
// PATCH_APPLY_FAILED but does not roll back the writes already committed.
// Predicted failure: assertion that file_a.txt content is unchanged after a
// 2-file patch whose 2nd file fails. file_a will have been mutated.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { applyPatchTool } from "../../src/tools/apply-patch.js";

let workDir: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), "bh001-"));
  await fs.writeFile(
    join(workDir, "file_a.txt"),
    "alpha\nbeta\ngamma\n",
    "utf-8",
  );
  await fs.writeFile(join(workDir, "file_b.txt"), "actual content\n", "utf-8");
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

it("applyPatch leaves earlier files untouched when a later file's hunk fails to match", async () => {
  const patch = [
    "--- a/file_a.txt",
    "+++ b/file_a.txt",
    "@@ -1,3 +1,3 @@",
    " alpha",
    "-beta",
    "+BETA",
    " gamma",
    "--- a/file_b.txt",
    "+++ b/file_b.txt",
    "@@ -1,1 +1,1 @@",
    "-this content does not exist in file_b",
    "+replacement",
    "",
  ].join("\n");

  const ctx = {
    cwd: workDir,
    signal: new AbortController().signal,
    callId: "test-001",
  };

  const result = await applyPatchTool.execute({ patch }, ctx, undefined);

  expect(result.ok).toBe(false);

  const fileA = await fs.readFile(join(workDir, "file_a.txt"), "utf-8");
  // Invariant: file_a is unchanged because the patch as a whole failed.
  expect(fileA).toBe("alpha\nbeta\ngamma\n");
});
