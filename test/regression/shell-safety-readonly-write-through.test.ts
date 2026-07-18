import { describe, expect, it } from "vitest";
import { classifyShellCommand } from "../../src/permissions/shell-safety.js";

// BH-2026-07-12: gitIsReadOnly only inspected git's *global* options and the
// subcommand name; it never looked at the subcommand's own options. So
// `git diff --output=<file>` (which opens and truncates the file even on an
// empty diff) and `git grep --open-files-in-pager=<cmd>` (which runs a command)
// were classified read-only. The `find` write-action denylist also omitted the
// GNU siblings `-fprintf` and `-fprint0`.
describe("shell-safety: write-capable options of read-only verbs are not auto-allowed", () => {
  it("does not auto-allow git diff --output= (a file write)", () => {
    expect(classifyShellCommand("git diff --output=out.txt")).toBe("ask");
  });

  it("does not auto-allow git diff --output <file> (space form)", () => {
    expect(classifyShellCommand("git diff --output out.txt")).toBe("ask");
  });

  it("does not auto-allow git grep --open-files-in-pager= (command execution)", () => {
    expect(
      classifyShellCommand("git grep --open-files-in-pager=touch TODO"),
    ).toBe("ask");
  });

  it("does not auto-allow find -fprintf (a file write)", () => {
    expect(classifyShellCommand("find . -fprintf out.txt fmt")).toBe("ask");
  });

  it("does not auto-allow find -fprint0 (a file write)", () => {
    expect(classifyShellCommand("find . -fprint0 out.txt")).toBe("ask");
  });

  it("still auto-allows a plain git diff", () => {
    expect(classifyShellCommand("git diff")).toBe("allow");
  });

  it("still auto-allows a plain find name search", () => {
    expect(classifyShellCommand("find . -name x.ts")).toBe("allow");
  });
});
