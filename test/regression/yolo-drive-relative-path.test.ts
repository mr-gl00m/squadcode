import { describe, expect, it } from "vitest";
import { checkYoloPathGuard, type YoloSession } from "../../src/yolo/index.js";

function winSession(overrides: Partial<YoloSession> = {}): YoloSession {
  return {
    cwd: "C:\\work\\repo",
    archiveDir: ".archive/2026-07-12",
    isWindows: true,
    checklistPath: null,
    ...overrides,
  };
}

// BH-2026-07-12: the path guard only flagged tokens that win32.isAbsolute()
// accepted or that contained `..`. A Windows drive-relative path like
// `D:secrets.txt` (drive letter, no separator) is NOT absolute per isAbsolute
// and has no climb, so it slipped through and let a command read/write another
// drive outside cwd. The fully-qualified form `D:\secrets.txt` was already
// rejected.
describe("checkYoloPathGuard: drive-relative Windows paths", () => {
  it("rejects a drive-relative path on another drive", () => {
    expect(
      checkYoloPathGuard("Get-Content D:secrets.txt", winSession())?.kind,
    ).toBe("rejected");
  });

  it("rejects a drive-relative Set-Location", () => {
    expect(checkYoloPathGuard("Set-Location D:work", winSession())?.kind).toBe(
      "rejected",
    );
  });

  it("still allows an in-cwd relative path", () => {
    expect(
      checkYoloPathGuard("Get-Content src/foo.ts", winSession()),
    ).toBeNull();
  });

  it("still rejects the fully-qualified cross-drive path", () => {
    expect(
      checkYoloPathGuard("Get-Content D:\\secrets.txt", winSession())?.kind,
    ).toBe("rejected");
  });
});
