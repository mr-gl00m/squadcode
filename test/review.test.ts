import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectReviewDiff,
  resolveReviewTarget,
  reviewDiffFragment,
} from "../src/cli/review.js";
import { renderContextFragment } from "../src/context/fragment.js";

async function repository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "squad-review-"));
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd,
  });
  execFileSync("git", ["config", "user.name", "Squad Test"], { cwd });
  await writeFile(join(cwd, "file.txt"), "first\n", "utf8");
  execFileSync("git", ["add", "file.txt"], { cwd });
  execFileSync("git", ["commit", "-qm", "first"], { cwd });
  await writeFile(join(cwd, "file.txt"), "second\n", "utf8");
  execFileSync("git", ["commit", "-qam", "second"], { cwd });
  return cwd;
}

describe("review presets", () => {
  it("defaults to uncommitted and rejects ambiguous or option-like revisions", () => {
    expect(resolveReviewTarget({})).toEqual({ kind: "uncommitted" });
    expect(resolveReviewTarget({ uncommitted: true, base: "main" })).toContain(
      "exactly one",
    );
    expect(resolveReviewTarget({ commit: "--output=/tmp/x" })).toContain(
      "does not start",
    );
  });

  it("collects commit, base, tracked, and untracked changes", async () => {
    const cwd = await repository();
    const commit = await collectReviewDiff(cwd, {
      kind: "commit",
      revision: "HEAD",
    });
    expect(commit).toContain("second");

    const base = await collectReviewDiff(cwd, {
      kind: "base",
      revision: "HEAD~1",
    });
    expect(base).toContain("+second");

    await writeFile(join(cwd, "file.txt"), "third\n", "utf8");
    await writeFile(join(cwd, "new.txt"), "untracked\n", "utf8");
    const uncommitted = await collectReviewDiff(cwd, {
      kind: "uncommitted",
    });
    expect(uncommitted).toContain("+third");
    expect(uncommitted).toContain("new untracked file");
    expect(uncommitted).toContain("untracked");
  });

  it("redacts secrets and marks diff text as untrusted context", () => {
    const fragment = reviewDiffFragment(
      { kind: "uncommitted" },
      "+OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    );
    const rendered = renderContextFragment(fragment).content;
    expect(fragment.trust).toBe("untrusted-environment");
    expect(rendered).toContain("[REDACTED_SECRET]");
    expect(rendered).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz123456");
  });
});
