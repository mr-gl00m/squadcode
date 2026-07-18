import { describe, expect, it } from "vitest";
import { rewriteDeleteCommand } from "../../src/tools/delete-guard.js";

const posixOpts = {
  archiveDir: ".deleted/2026-07-12",
  isWindows: false,
  cwd: "/work/repo",
};
const winOpts = {
  archiveDir: ".deleted/2026-07-12",
  isWindows: true,
  cwd: "C:\\work\\repo",
};

// BH-2026-07-12: the shell-out guard tokenized on whitespace and only matched a
// delete verb after stripping *wrapping* quotes. `bash -c "rm -rf x"` splits to
// `["bash","-c",'"rm',"-rf",'x"']`, and `"rm` (leading quote only) never matched
// `rm`, so the interpreter shell-out ran the delete unarchived. The unquoted
// form `cmd /c del x` was already blocked; the quoted form is how these
// interpreters are normally invoked.
describe("delete-guard: quoted interpreter shell-out is blocked", () => {
  it("rejects bash -c with a double-quoted inner delete", () => {
    expect(
      rewriteDeleteCommand('bash -c "rm -rf important"', posixOpts).kind,
    ).toBe("rejected");
  });

  it("rejects sh -c with a single-quoted inner delete", () => {
    expect(rewriteDeleteCommand("sh -c 'rm important'", posixOpts).kind).toBe(
      "rejected",
    );
  });

  it("rejects powershell -Command with a quoted Remove-Item", () => {
    expect(
      rewriteDeleteCommand(
        'powershell -Command "Remove-Item -Recurse -Force src"',
        winOpts,
      ).kind,
    ).toBe("rejected");
  });

  it("rejects cmd /c with a quoted del", () => {
    expect(rewriteDeleteCommand('cmd /c "del secret.txt"', winOpts).kind).toBe(
      "rejected",
    );
  });

  it("does not over-reject a shell-out with no delete verb", () => {
    expect(rewriteDeleteCommand('bash -c "echo hello"', posixOpts).kind).toBe(
      "ok",
    );
  });
});

// BH-2026-07-12: `rd` and `rmdir` are default PowerShell aliases for Remove-Item
// (recursive with -Recurse -Force). They were absent from DELETE_VERBS_WIN, so
// they passed through and deleted without being archived.
describe("delete-guard: PowerShell rd/rmdir aliases are archived", () => {
  it("rewrites rd instead of passing it through", () => {
    expect(rewriteDeleteCommand("rd -Recurse -Force build", winOpts).kind).toBe(
      "rewritten",
    );
  });

  it("rewrites rmdir instead of passing it through", () => {
    expect(rewriteDeleteCommand("rmdir oldstuff", winOpts).kind).toBe(
      "rewritten",
    );
  });
});
