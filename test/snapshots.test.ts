import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureWorkspaceSnapshot,
  restoreWorkspaceSnapshot,
} from "../src/sessions/snapshots.js";

describe("isolated workspace snapshots", () => {
  it("restores workspace state without touching user git or secrets", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "squad-snapshot-work-"));
    const baseDir = await mkdtemp(join(tmpdir(), "squad-snapshot-state-"));
    execFileSync("git", ["init", "-q"], { cwd });
    const gitConfigPath = join(cwd, ".git", "config");
    const gitConfigBefore = await readFile(gitConfigPath, "utf8");
    await writeFile(join(cwd, "tracked.txt"), "one\n", "utf8");
    await writeFile(join(cwd, ".env"), "SECRET=first\n", "utf8");

    const first = await captureWorkspaceSnapshot({
      cwd,
      sessionId: "session-1",
      turnId: "turn-1",
      baseDir,
    });
    await writeFile(join(cwd, "tracked.txt"), "two\n", "utf8");
    await writeFile(join(cwd, "added.txt"), "later\n", "utf8");
    await writeFile(join(cwd, ".env"), "SECRET=second\n", "utf8");
    const second = await captureWorkspaceSnapshot({
      cwd,
      sessionId: "session-1",
      turnId: "turn-2",
      baseDir,
    });

    expect(second).not.toBe(first);
    await restoreWorkspaceSnapshot({
      cwd,
      sessionId: "session-1",
      snapshot: first,
      baseDir,
    });

    expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("one\n");
    await expect(
      readFile(join(cwd, "added.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe("SECRET=second\n");
    expect(await readFile(gitConfigPath, "utf8")).toBe(gitConfigBefore);
  });
});
