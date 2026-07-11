import { describe, expect, it } from "vitest";
import {
  checkYoloPathGuard,
  createYoloSession,
  makeArchiveDir,
  type YoloSession,
  yoloSystemPromptAddendum,
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

describe("checkYoloPathGuard", () => {
  it("returns null for commands with relative paths", () => {
    expect(checkYoloPathGuard("ls src/", posixSession())).toBeNull();
  });

  it("rejects unix absolute paths outside cwd", () => {
    const r = checkYoloPathGuard("cat /etc/passwd", posixSession());
    expect(r?.kind).toBe("rejected");
    expect(r?.reason).toContain("/etc/passwd");
  });

  it("parses quoted paths instead of splitting on whitespace", () => {
    const r = checkYoloPathGuard(
      'cat "/outside directory/secret.txt"',
      posixSession(),
    );
    expect(r?.kind).toBe("rejected");
    expect(r?.reason).toContain("/outside directory/secret.txt");
  });

  it("allows unix absolute paths under cwd", () => {
    expect(
      checkYoloPathGuard("cat /work/repo/src/foo.ts", posixSession()),
    ).toBeNull();
  });

  it("rejects windows absolute paths outside cwd", () => {
    const r = checkYoloPathGuard(
      "Get-Content C:\\Windows\\System32\\hosts",
      winSession(),
    );
    expect(r?.kind).toBe("rejected");
  });

  it("rejects cd that walks outside cwd", () => {
    const r = checkYoloPathGuard("cd ..; ls", posixSession());
    expect(r?.kind).toBe("rejected");
    expect(r?.reason).toContain("cd");
  });

  it("rejects relative path climbs and option-embedded absolute paths", () => {
    expect(
      checkYoloPathGuard("cat ../secret.txt", posixSession()),
    ).toMatchObject({ kind: "rejected" });
    expect(
      checkYoloPathGuard("rg foo --file=/etc/passwd", posixSession()),
    ).toMatchObject({ kind: "rejected" });
  });

  it("allows cd into a subdirectory", () => {
    expect(checkYoloPathGuard("cd src && ls", posixSession())).toBeNull();
  });

  it("fails closed on substitutions, redirects, assignments, and subshells", () => {
    for (const command of [
      "cat $(pwd)",
      "cat `pwd`",
      "cat x > out",
      "FOO=bar ls",
      "(ls)",
    ]) {
      expect(
        checkYoloPathGuard(command, posixSession()),
        command,
      ).toMatchObject({ kind: "rejected" });
    }
  });

  it("uses the conservative PowerShell word ceiling", () => {
    expect(
      checkYoloPathGuard("Get-Content $env:USERPROFILE", winSession()),
    ).toMatchObject({ kind: "rejected" });
    expect(
      checkYoloPathGuard(
        'Get-Content "C:\\work\\repo\\file with spaces.txt"',
        winSession(),
      ),
    ).toBeNull();
  });

  it("rejects Set-Location to absolute path outside cwd", () => {
    const r = checkYoloPathGuard("Set-Location C:\\Windows", winSession());
    expect(r?.kind).toBe("rejected");
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
    expect(text).toContain("not OS isolation");
  });

  it("notes when no checklist is loaded", () => {
    const s = posixSession({ checklistPath: null });
    const text = yoloSystemPromptAddendum(s);
    expect(text).toContain("No checklist");
  });
});
