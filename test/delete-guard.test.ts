import { describe, expect, it } from "vitest";
import {
  makeDeletedDir,
  rewriteDeleteCommand,
} from "../src/tools/delete-guard.js";

const FIXED_NOW = new Date("2026-05-05T12:34:56.000Z");
const ARCHIVE = ".deleted/2026-05-05T12-34-56-000Z";

const posixOpts = { archiveDir: ARCHIVE, isWindows: false, cwd: "/work/repo" };
const winOpts = { archiveDir: ARCHIVE, isWindows: true, cwd: "C:\\work\\repo" };

describe("makeDeletedDir", () => {
  it("uses an ISO timestamp with safe separators under .deleted/", () => {
    expect(makeDeletedDir(FIXED_NOW)).toBe(ARCHIVE);
  });
});

describe("rewriteDeleteCommand — simple deletes rewrite to a move", () => {
  it("rewrites rm into mv (POSIX)", () => {
    const r = rewriteDeleteCommand("rm src/foo.ts", posixOpts);
    expect(r.kind).toBe("rewritten");
    if (r.kind === "rewritten") {
      expect(r.command).toContain("mkdir -p");
      expect(r.command).toContain(ARCHIVE);
      expect(r.command).toContain("mv 'src/foo.ts'");
    }
  });

  it("strips flags like -rf and keeps positional args", () => {
    const r = rewriteDeleteCommand("rm -rf node_modules dist", posixOpts);
    expect(r.kind).toBe("rewritten");
    if (r.kind === "rewritten") {
      expect(r.command).toContain("mv 'node_modules' 'dist'");
      expect(r.command).not.toContain("-rf");
    }
  });

  it("rewrites unlink", () => {
    expect(rewriteDeleteCommand("unlink stale.lock", posixOpts).kind).toBe(
      "rewritten",
    );
  });

  it("rewrites Remove-Item to Move-Item (Windows)", () => {
    const r = rewriteDeleteCommand(
      "Remove-Item -Recurse -Force node_modules",
      winOpts,
    );
    expect(r.kind).toBe("rewritten");
    if (r.kind === "rewritten") {
      expect(r.command).toContain("New-Item -ItemType Directory");
      expect(r.command).toContain("Move-Item -Path 'node_modules'");
      expect(r.command).toContain("-Destination '.deleted/");
    }
  });

  it("rewrites the rm alias and del on Windows", () => {
    expect(rewriteDeleteCommand("rm dist", winOpts).kind).toBe("rewritten");
    expect(rewriteDeleteCommand("del foo.tmp", winOpts).kind).toBe("rewritten");
  });

  it("leaves non-delete commands alone", () => {
    expect(rewriteDeleteCommand("ls -la src/", posixOpts).kind).toBe("ok");
    expect(rewriteDeleteCommand("git status", posixOpts).kind).toBe("ok");
  });
});

describe("rewriteDeleteCommand — blocks deletes it can't safely rewrite", () => {
  const blocked = (cmd: string, opts = posixOpts): void => {
    const r = rewriteDeleteCommand(cmd, opts);
    expect(r.kind).toBe("rejected");
  };

  it("rejects a delete inside a pipeline", () => {
    blocked("Get-ChildItem *.log | Remove-Item", winOpts);
    blocked("rm tmp.txt | tee log");
  });

  it("rejects a delete driven by xargs", () => {
    blocked("find . -name '*.log' | xargs rm");
  });

  it("rejects .NET / object delete methods", () => {
    blocked("[System.IO.File]::Delete('secret.txt')", winOpts);
    blocked("(Get-Item foo.txt).Delete()", winOpts);
  });

  it("rejects git clean and rimraf", () => {
    blocked("git clean -fdx");
    blocked("rimraf dist");
    blocked("npx rimraf dist");
  });

  it("rejects a delete run through another interpreter", () => {
    blocked("cmd /c del foo.txt", winOpts);
  });

  it("rejects find with built-in deletion", () => {
    blocked("find . -name '*.tmp' -delete");
    blocked("find . -type f -exec rm {} ;");
  });

  it("rejects a delete with no explicit path to archive", () => {
    blocked("Remove-Item -Recurse -Force", winOpts);
  });
});

describe("rewriteDeleteCommand — recovery folder can still be emptied", () => {
  it("lets a real delete through when the target is inside the recovery folder", () => {
    expect(
      rewriteDeleteCommand("rm -rf .deleted/2026-old", posixOpts).kind,
    ).toBe("ok");
    expect(
      rewriteDeleteCommand("Remove-Item -Recurse .deleted/2026-old", winOpts)
        .kind,
    ).toBe("ok");
  });
});

describe("rewriteDeleteCommand — avoids false positives", () => {
  it("does not treat a delete word as an argument as a delete", () => {
    expect(rewriteDeleteCommand("grep rm src/foo.ts", posixOpts).kind).toBe(
      "ok",
    );
    expect(rewriteDeleteCommand("echo rm", posixOpts).kind).toBe("ok");
    expect(
      rewriteDeleteCommand("cat a.txt | grep delete", posixOpts).kind,
    ).toBe("ok");
  });
});
