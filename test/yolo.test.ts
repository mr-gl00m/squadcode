import { describe, expect, it } from "vitest";
import {
  applyYoloShellGuard,
  createYoloSession,
  makeArchiveDir,
  yoloSystemPromptAddendum,
  type YoloSession,
} from "../src/yolo/index.js";

const FIXED_NOW = new Date("2026-05-05T12:34:56.000Z");

function posixSession(overrides: Partial<YoloSession> = {}): YoloSession {
  return {
    cwd: "/work/repo",
    archiveDir: ".archive/2026-05-05T12-34-56-000Z",
    isWindows: false,
    checklistPath: null,
    ...overrides,
  };
}

function winSession(overrides: Partial<YoloSession> = {}): YoloSession {
  return {
    cwd: "C:\\work\\repo",
    archiveDir: ".archive/2026-05-05T12-34-56-000Z",
    isWindows: true,
    checklistPath: null,
    ...overrides,
  };
}

describe("makeArchiveDir", () => {
  it("uses an ISO timestamp with safe separators", () => {
    expect(makeArchiveDir(FIXED_NOW)).toBe(".archive/2026-05-05T12-34-56-000Z");
  });
});

describe("createYoloSession", () => {
  it("populates archive dir, platform flag, and checklist path", () => {
    const s = createYoloSession({
      cwd: "/foo",
      isWindows: false,
      checklistPath: "checklist.txt",
      now: FIXED_NOW,
    });
    expect(s).toEqual({
      cwd: "/foo",
      archiveDir: ".archive/2026-05-05T12-34-56-000Z",
      isWindows: false,
      checklistPath: "checklist.txt",
    });
  });
});

describe("applyYoloShellGuard sandbox", () => {
  it("passes through commands with relative paths", () => {
    const r = applyYoloShellGuard("ls src/", posixSession());
    expect(r.kind).toBe("ok");
  });

  it("rejects unix absolute paths outside cwd", () => {
    const r = applyYoloShellGuard("cat /etc/passwd", posixSession());
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") {
      expect(r.reason).toContain("/etc/passwd");
    }
  });

  it("allows unix absolute paths under cwd", () => {
    const r = applyYoloShellGuard("cat /work/repo/src/foo.ts", posixSession());
    expect(r.kind).toBe("ok");
  });

  it("rejects windows absolute paths outside cwd", () => {
    const r = applyYoloShellGuard("Get-Content C:\\Windows\\System32\\hosts", winSession());
    expect(r.kind).toBe("rejected");
  });

  it("rejects cd that walks outside cwd", () => {
    const r = applyYoloShellGuard("cd ..; ls", posixSession());
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") {
      expect(r.reason).toContain("cd");
    }
  });

  it("allows cd into a subdirectory", () => {
    const r = applyYoloShellGuard("cd src && ls", posixSession());
    expect(r.kind).toBe("ok");
  });

  it("rejects Set-Location to absolute path outside cwd", () => {
    const r = applyYoloShellGuard("Set-Location C:\\Windows", winSession());
    expect(r.kind).toBe("rejected");
  });
});

describe("applyYoloShellGuard delete rewrites — POSIX", () => {
  it("rewrites rm to mv into archive", () => {
    const r = applyYoloShellGuard("rm src/foo.ts", posixSession());
    expect(r.kind).toBe("rewritten");
    if (r.kind === "rewritten") {
      expect(r.command).toContain("mkdir -p");
      expect(r.command).toContain(".archive/2026-05-05T12-34-56-000Z");
      expect(r.command).toContain("mv 'src/foo.ts'");
    }
  });

  it("strips flags like -rf and keeps positional args", () => {
    const r = applyYoloShellGuard("rm -rf node_modules dist", posixSession());
    expect(r.kind).toBe("rewritten");
    if (r.kind === "rewritten") {
      expect(r.command).toContain("mv 'node_modules' 'dist'");
      expect(r.command).not.toContain("-rf");
    }
  });

  it("rewrites unlink", () => {
    const r = applyYoloShellGuard("unlink stale.lock", posixSession());
    expect(r.kind).toBe("rewritten");
  });

  it("leaves non-delete commands alone", () => {
    const r = applyYoloShellGuard("ls -la src/", posixSession());
    expect(r.kind).toBe("ok");
  });
});

describe("applyYoloShellGuard delete rewrites — Windows", () => {
  it("rewrites Remove-Item to Move-Item with PowerShell list syntax", () => {
    const r = applyYoloShellGuard(
      "Remove-Item -Recurse -Force node_modules",
      winSession(),
    );
    expect(r.kind).toBe("rewritten");
    if (r.kind === "rewritten") {
      expect(r.command).toContain("New-Item -ItemType Directory");
      expect(r.command).toContain("Move-Item -Path 'node_modules'");
      expect(r.command).toContain("-Destination '.archive/");
    }
  });

  it("rewrites rm alias on windows to PowerShell Move-Item", () => {
    const r = applyYoloShellGuard("rm dist", winSession());
    expect(r.kind).toBe("rewritten");
    if (r.kind === "rewritten") {
      expect(r.command).toContain("Move-Item");
    }
  });

  it("rewrites del", () => {
    const r = applyYoloShellGuard("del foo.tmp", winSession());
    expect(r.kind).toBe("rewritten");
  });
});

describe("yoloSystemPromptAddendum", () => {
  it("mentions cwd, archive dir, and checklist path when set", () => {
    const s = posixSession({ checklistPath: "checklist.txt" });
    const text = yoloSystemPromptAddendum(s);
    expect(text).toContain(s.cwd);
    expect(text).toContain(s.archiveDir);
    expect(text).toContain("checklist.txt");
    expect(text).toContain("YOLO mode");
  });

  it("notes when no checklist is loaded", () => {
    const s = posixSession({ checklistPath: null });
    const text = yoloSystemPromptAddendum(s);
    expect(text).toContain("No checklist");
  });
});
