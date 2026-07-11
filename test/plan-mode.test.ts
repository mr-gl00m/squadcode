import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { permissionModeConflict } from "../src/cli/program.js";
import { specificity } from "../src/permissions/match.js";
import {
  applyModeAddendums,
  classifyShellCommand as classifyParsedShellCommand,
  planSystemPromptAddendum,
  planVerdict,
} from "../src/permissions/plan.js";
import {
  appendRule,
  buildPolicyFromCli,
  decideAction,
  type PermissionRule,
  type RuleMap,
} from "../src/permissions/policy.js";
import type { ShellSafetyOptions } from "../src/permissions/shell-safety.js";

let safeBin = "";
const fakeExecutables = [
  "base64",
  "cat",
  "diff",
  "find",
  "git",
  "grep",
  "head",
  "ls",
  "pwd",
  "rg",
  "sed",
  "sort",
  "uniq",
  "wc",
  "yq",
];

beforeAll(() => {
  safeBin = mkdtempSync(join(tmpdir(), "squad-shell-safe-"));
  for (const name of fakeExecutables) {
    if (process.platform === "win32") {
      writeFileSync(join(safeBin, `${name}.exe`), "");
    } else {
      writeFileSync(join(safeBin, name), "");
      writeFileSync(join(safeBin, `${name}.exe`), "");
    }
  }
});

afterAll(() => {
  if (safeBin) rmSync(safeBin, { recursive: true, force: true });
});

function bashOptions(overrides: ShellSafetyOptions = {}): ShellSafetyOptions {
  return {
    platform: "linux",
    cwd: process.cwd(),
    env: {
      PATH: safeBin,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    },
    ...overrides,
  };
}

function classifyShellCommand(
  command: string,
  opts: ShellSafetyOptions = {},
): "allow" | "ask" {
  return classifyParsedShellCommand(command, bashOptions(opts));
}

function baseCfg(overrides: { mode?: "act" | "plan" } = {}) {
  return {
    defaultMode: "ask" as const,
    rules: new Map() as RuleMap,
    dangerouslySkipPermissions: false,
    mode: overrides.mode ?? ("act" as const),
  };
}

describe("planVerdict", () => {
  it("denies the mutating tools outright", () => {
    expect(planVerdict("Edit")).toBe("deny");
    expect(planVerdict("Write")).toBe("deny");
    expect(planVerdict("ApplyPatch")).toBe("deny");
    expect(planVerdict("NotebookEdit")).toBe("deny");
  });

  it("allows the read-only tools", () => {
    expect(planVerdict("Read")).toBe("allow");
    expect(planVerdict("Glob")).toBe("allow");
    expect(planVerdict("Grep")).toBe("allow");
    expect(planVerdict("IndexList")).toBe("allow");
    expect(planVerdict("IndexFetch")).toBe("allow");
    expect(planVerdict("TodoWrite")).toBe("allow");
    expect(planVerdict("ToolSearch")).toBe("allow");
  });

  it("asks on Shell with no command (can't classify)", () => {
    expect(planVerdict("Shell")).toBe("ask");
  });

  it("classifies Shell by command: read-only allows, mutating asks", () => {
    expect(planVerdict("Shell", { command: "git status" })).toBe("allow");
    expect(planVerdict("Shell", { command: "rm -rf build" })).toBe("ask");
  });

  it("asks on unknown / user-defined tools (conservative)", () => {
    expect(planVerdict("SomeCustomTool")).toBe("ask");
  });
});

describe("classifyShellCommand", () => {
  it("allows recognized read-only commands", () => {
    for (const cmd of [
      "git status",
      "git log --oneline -5",
      "git diff HEAD~1",
      "git show HEAD",
      "ls -la",
      "cat package.json",
      "pwd",
      "rg TODO src/",
      "grep -n foo file",
      "wc -l file",
    ]) {
      expect(classifyShellCommand(cmd), cmd).toBe("allow");
    }
  });

  it("allows PowerShell read-only cmdlets and aliases", () => {
    const opts = { platform: "win32" as const, cwd: "C:\\work\\repo" };
    expect(classifyParsedShellCommand("Get-ChildItem", opts)).toBe("allow");
    expect(classifyParsedShellCommand("gci -Recurse", opts)).toBe("allow");
    expect(classifyParsedShellCommand("Get-Content README.md", opts)).toBe(
      "allow",
    );
  });

  it("normalizes canonical absolute executables and suffixes", () => {
    const nativeGit = realpathSync(
      join(safeBin, process.platform === "win32" ? "git.exe" : "git"),
    );
    expect(
      classifyParsedShellCommand(`${JSON.stringify(nativeGit)} status`, {
        platform: process.platform,
        cwd: process.cwd(),
        env: { PATH: safeBin, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      }),
    ).toBe("allow");
    expect(classifyShellCommand("git.exe status")).toBe("allow");
  });

  it("does not trust a safe-list basename resolved from the workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "squad-shell-shadow-"));
    try {
      writeFileSync(
        join(workspace, process.platform === "win32" ? "git.exe" : "git"),
        "",
      );
      expect(
        classifyParsedShellCommand("git status", {
          platform: process.platform,
          cwd: workspace,
          env: { PATH: safeBin, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
        }),
      ).toBe("ask");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("allows pipelines and sequences of only read-only commands", () => {
    expect(classifyShellCommand("cat a | grep b")).toBe("allow");
    expect(classifyShellCommand("ls; pwd")).toBe("allow");
    expect(classifyShellCommand("git log | head")).toBe("allow");
  });

  it("asks on mutating commands", () => {
    for (const cmd of [
      "rm -rf build",
      "git commit -m x",
      "git push",
      "git add .",
      "git branch -d foo",
      "git fetch",
      "npm install",
      "node script.js",
      "sed -i s/a/b/ f",
      "sudo ls",
    ]) {
      expect(classifyShellCommand(cmd)).toBe("ask");
    }
  });

  it("rejects the differential executable and rm bypass corpus", () => {
    const cases: Array<[string, ShellSafetyOptions]> = [
      ["./ls.bat", bashOptions()],
      ["./git.ps1 status", bashOptions()],
      ["C:\\repo\\ls.bat", { platform: "win32", cwd: "C:\\repo" }],
      ["../evil/ls", bashOptions()],
      ["/bin/rm -rf /", bashOptions()],
      ["rm -fr /", bashOptions()],
      ["rm -r -f /", bashOptions()],
      ["rm --recursive --force /", bashOptions()],
      ["rm /important -rf", bashOptions()],
      ["sudo /bin/rm -rf /", bashOptions()],
      ["git -c core.pager=evil log", bashOptions()],
      ["git --exec-path=/tmp/evil status", bashOptions()],
    ];
    for (const [command, opts] of cases) {
      expect(classifyParsedShellCommand(command, opts), command).toBe("ask");
    }
  });

  it("rejects unsafe flags on otherwise read-only commands", () => {
    for (const command of [
      "find . -exec rm {} \\;",
      "find . -delete",
      "sed 1p file",
      "sed -i s/a/b/ file",
      "rg --pre evil pattern .",
      "base64 -o output input",
      "git --paginate log",
      "git diff --textconv",
    ]) {
      expect(classifyShellCommand(command), command).toBe("ask");
    }
    for (const command of [
      "find . -print",
      "sed -n 1p file",
      "rg pattern .",
      "base64 input",
      "git --no-pager log",
    ]) {
      expect(classifyShellCommand(command), command).toBe("allow");
    }
  });

  it("asks when any segment of a compound command mutates", () => {
    expect(classifyShellCommand("ls && rm x")).toBe("ask");
    expect(classifyShellCommand("git status | tee out.txt")).toBe("ask");
  });

  it("asks on output redirection (a write hiding behind a read)", () => {
    expect(classifyShellCommand("cat x > out.txt")).toBe("ask");
    expect(classifyShellCommand("echo hi >> log")).toBe("ask");
  });

  it("asks when a read-only verb carries an output / in-place write flag", () => {
    expect(classifyShellCommand("sort -o out.txt in.txt")).toBe("ask");
    expect(classifyShellCommand("sort -oout.txt in.txt")).toBe("ask");
    expect(classifyShellCommand("sort --output=out.txt in.txt")).toBe("ask");
    expect(classifyShellCommand("yq -i '.a=1' f.yaml")).toBe("ask");
    expect(classifyShellCommand("yq --inplace '.a=1' f.yaml")).toBe("ask");
    // Bare reads stay allowed — the write flag is what flips them, not the verb.
    expect(classifyShellCommand("cat x | sort | uniq")).toBe("allow");
    expect(classifyShellCommand("yq '.a' f.yaml")).toBe("allow");
    expect(classifyShellCommand("yq -o json '.a' f.yaml")).toBe("allow");
  });

  it("asks on command and process substitution", () => {
    expect(classifyShellCommand("git log $(whoami)")).toBe("ask");
    expect(classifyShellCommand("cat `whoami`")).toBe("ask");
    expect(classifyShellCommand("diff <(ls a) <(ls b)")).toBe("ask");
  });

  it("asks on empty or env-prefixed commands", () => {
    expect(classifyShellCommand("")).toBe("ask");
    expect(classifyShellCommand("   ")).toBe("ask");
    expect(classifyShellCommand("FOO=bar ls")).toBe("ask");
  });

  it("conservatively asks on PowerShell syntax outside the word ceiling", () => {
    const opts = { platform: "win32" as const, cwd: "C:\\work\\repo" };
    expect(classifyParsedShellCommand("(Get-Location).Path", opts)).toBe("ask");
    expect(
      classifyParsedShellCommand(
        "(Get-Location).Path | Split-Path -Leaf",
        opts,
      ),
    ).toBe("ask");
    expect(
      classifyParsedShellCommand("(Get-ChildItem -Recurse).Count", opts),
    ).toBe("ask");
  });

  it("asks on parenthesized method calls (a mutation hiding behind a read)", () => {
    // `.Delete()` mutates; the property-only unwrap must not match a method call.
    expect(classifyShellCommand("(Get-Item foo.txt).Delete()")).toBe("ask");
    // A non-read-only inner command stays gated even with a property read.
    expect(classifyShellCommand("(Remove-Item foo.txt).Name")).toBe("ask");
  });

  it("asks on read-only commands with out-of-project path operands", () => {
    const cwd = process.cwd();
    const read = process.platform === "win32" ? "Get-Content" : "cat";
    const native = { platform: process.platform, cwd };
    expect(classifyParsedShellCommand(`${read} ../secret.txt`, native)).toBe(
      "ask",
    );
    expect(classifyParsedShellCommand(`${read} ..\\secret.txt`, native)).toBe(
      "ask",
    );
    expect(
      classifyParsedShellCommand(
        `${read} ${JSON.stringify(resolve(cwd, "..", "secret.txt"))}`,
        native,
      ),
    ).toBe("ask");
  });

  it("allows read-only commands with absolute paths inside cwd", () => {
    const cwd = process.cwd();
    const read = process.platform === "win32" ? "Get-Content" : "cat";
    expect(
      classifyParsedShellCommand(
        `${read} ${JSON.stringify(resolve(cwd, "README.md"))}`,
        { platform: process.platform, cwd },
      ),
    ).toBe("allow");
  });

  it("asks on target-bearing path-changing commands", () => {
    expect(classifyShellCommand("cd ..")).toBe("ask");
    expect(classifyShellCommand("Set-Location src")).toBe("ask");
  });
});

describe("decideAction in plan mode", () => {
  it("denies Edit even without any matching rule", () => {
    const cfg = baseCfg({ mode: "plan" });
    expect(decideAction("Edit", "ask", { path: "src/foo.ts" }, cfg)).toBe(
      "deny",
    );
  });

  it("denies Write and ApplyPatch", () => {
    const cfg = baseCfg({ mode: "plan" });
    expect(
      decideAction("Write", "ask", { path: "x.ts", content: "" }, cfg),
    ).toBe("deny");
    expect(decideAction("ApplyPatch", "ask", { patch: "" }, cfg)).toBe("deny");
  });

  it("allows read-only Shell and asks on mutating Shell", () => {
    const cfg = baseCfg({ mode: "plan" });
    expect(decideAction("Shell", "ask", { command: "git status" }, cfg)).toBe(
      "allow",
    );
    expect(decideAction("Shell", "ask", { command: "rm -rf build" }, cfg)).toBe(
      "ask",
    );
  });

  it("allows Read on a normal path", () => {
    const cfg = baseCfg({ mode: "plan" });
    expect(decideAction("Read", "ask", { path: "src/foo.ts" }, cfg)).toBe(
      "allow",
    );
  });

  it("respects sensitive denies even in plan mode (id_rsa Read stays denied)", () => {
    const cfg = buildPolicyFromCli({ defaultMode: "ask", mode: "plan" });
    expect(decideAction("Read", "auto-allow", { path: "/x/id_rsa" }, cfg)).toBe(
      "deny",
    );
  });

  it("overrides --allowed-tools Edit so the user can't accidentally enable writes in plan mode", () => {
    const cfg = buildPolicyFromCli({
      defaultMode: "ask",
      allowedTools: "Edit",
      mode: "plan",
    });
    expect(decideAction("Edit", "ask", { path: "src/foo.ts" }, cfg)).toBe(
      "deny",
    );
  });

  it("denies writes even when dangerouslySkipPermissions is also set", () => {
    const cfg = {
      ...baseCfg({ mode: "plan" }),
      dangerouslySkipPermissions: true,
    };
    expect(
      decideAction("Write", "ask", { path: "x.ts", content: "x" }, cfg),
    ).toBe("deny");
    expect(decideAction("Shell", "ask", { command: "rm -rf build" }, cfg)).toBe(
      "ask",
    );
  });

  it("act mode (default) does not deny Edit when no rule matches", () => {
    const cfg = baseCfg();
    // Default mode is "ask" — so Edit with no rule falls back to ask, not deny.
    expect(decideAction("Edit", "ask", { path: "src/foo.ts" }, cfg)).toBe(
      "ask",
    );
  });
});

describe("decideAction read-only shell in act mode", () => {
  it("auto-allows recognized read-only shell commands with no matching rule", () => {
    const cfg = baseCfg();
    expect(decideAction("Shell", "ask", { command: "git status" }, cfg)).toBe(
      "allow",
    );
    expect(
      decideAction("Shell", "ask", { command: "cat README.md" }, cfg),
    ).toBe("allow");
    expect(
      decideAction("Shell", "ask", { command: "Get-ChildItem -Recurse" }, cfg),
    ).toBe("allow");
  });

  it("still asks on mutating, unrecognized, or redirecting shell commands", () => {
    const cfg = baseCfg();
    expect(decideAction("Shell", "ask", { command: "rm -rf build" }, cfg)).toBe(
      "ask",
    );
    // python is arbitrary execution — must not be classified read-only even
    // though the PDF-extraction fallback used to reach for it.
    expect(
      decideAction("Shell", "ask", { command: "python -c 'print(1)'" }, cfg),
    ).toBe("ask");
    expect(
      decideAction("Shell", "ask", { command: "cat secrets > out.txt" }, cfg),
    ).toBe("ask");
  });

  it("asks on Shell with no command to classify", () => {
    const cfg = baseCfg();
    expect(decideAction("Shell", "ask", {}, cfg)).toBe("ask");
  });

  it("does not auto-allow read-only shell when the default mode is deny", () => {
    const cfg = { ...baseCfg(), defaultMode: "deny" as const };
    expect(decideAction("Shell", "ask", { command: "git status" }, cfg)).toBe(
      "deny",
    );
  });

  it("lets a user deny rule beat the read-only auto-allow", () => {
    const rules: RuleMap = new Map();
    appendRule(rules, "Shell", { pattern: "*", action: "deny" });
    const cfg = { ...baseCfg(), rules };
    expect(decideAction("Shell", "ask", { command: "git status" }, cfg)).toBe(
      "deny",
    );
  });

  it("does not auto-allow read-only shell commands targeting paths outside cwd", () => {
    const cwd = process.cwd();
    const cfg = buildPolicyFromCli({ defaultMode: "ask", cwd });
    expect(
      decideAction(
        "Shell",
        "ask",
        { command: `Get-Content ${resolve(cwd, "..", "secret.txt")}` },
        cfg,
      ),
    ).toBe("ask");
    expect(
      decideAction("Shell", "ask", { command: "cat ../secret.txt" }, cfg),
    ).toBe("ask");
    expect(
      decideAction(
        "Shell",
        "ask",
        { command: `Get-Content ${resolve(cwd, "README.md")}` },
        cfg,
      ),
    ).toBe("allow");
  });
});

describe("buildPolicyFromCli mode handling", () => {
  it("defaults to act mode", () => {
    const cfg = buildPolicyFromCli({ defaultMode: "ask" });
    expect(cfg.mode).toBe("act");
  });

  it("accepts mode = plan", () => {
    const cfg = buildPolicyFromCli({ defaultMode: "ask", mode: "plan" });
    expect(cfg.mode).toBe("plan");
  });
});

describe("plan mode CLI conflicts", () => {
  it("rejects permission bypass and YOLO combinations", () => {
    expect(
      permissionModeConflict({ dangerouslySkipPermissions: true }, "plan"),
    ).toContain("dangerously-skip-permissions");
    expect(permissionModeConflict({ yolo: true }, "plan")).toContain("yolo");
    expect(
      permissionModeConflict({ dangerouslySkipPermissions: true }, "act"),
    ).toBeNull();
  });
});

describe("applyModeAddendums", () => {
  it("returns the base unchanged when no flags set", () => {
    expect(applyModeAddendums("base", {})).toBe("base");
  });

  it("appends the yolo addendum when provided", () => {
    expect(applyModeAddendums("base", { yolo: "yolo!" })).toContain("yolo!");
  });

  it("appends the plan addendum when plan=true", () => {
    const out = applyModeAddendums("base", { plan: true });
    expect(out).toContain(planSystemPromptAddendum());
  });

  it("stacks yolo then plan in order", () => {
    const out = applyModeAddendums("base", { yolo: "[Y]", plan: true });
    const yi = out.indexOf("[Y]");
    const pi = out.indexOf("Plan mode");
    expect(yi).toBeGreaterThan(0);
    expect(pi).toBeGreaterThan(yi);
  });
});

describe("plan mode + existing rules interaction", () => {
  it("specific user allow on Read survives plan mode (Read is allowed anyway)", () => {
    const rules: RuleMap = new Map();
    const rule: PermissionRule = { pattern: "src/**", action: "allow" };
    appendRule(rules, "Read", rule);
    rules
      .get("Read")!
      .sort((a, b) => specificity(b.pattern) - specificity(a.pattern));
    const cfg = { ...baseCfg({ mode: "plan" }), rules };
    expect(decideAction("Read", "ask", { path: "src/foo.ts" }, cfg)).toBe(
      "allow",
    );
  });

  it("specific user allow on Edit gets overridden to deny in plan mode", () => {
    const rules: RuleMap = new Map();
    appendRule(rules, "Edit", { pattern: "src/**", action: "allow" });
    rules
      .get("Edit")!
      .sort((a, b) => specificity(b.pattern) - specificity(a.pattern));
    const cfg = { ...baseCfg({ mode: "plan" }), rules };
    expect(decideAction("Edit", "ask", { path: "src/foo.ts" }, cfg)).toBe(
      "deny",
    );
  });

  it("user-set deny on Read survives plan mode (plan would allow, but deny wins)", () => {
    const rules: RuleMap = new Map();
    appendRule(rules, "Read", { pattern: "**/secrets/**", action: "deny" });
    rules
      .get("Read")!
      .sort((a, b) => specificity(b.pattern) - specificity(a.pattern));
    const cfg = { ...baseCfg({ mode: "plan" }), rules };
    expect(
      decideAction("Read", "ask", { path: "src/secrets/key.txt" }, cfg),
    ).toBe("deny");
  });
});
