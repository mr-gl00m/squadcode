import { describe, expect, it } from "vitest";
import {
  bashArityPrefix,
  compilePattern,
  deriveScopePattern,
  extractMatchKey,
  specificity,
} from "../src/permissions/match.js";
import {
  appendRule,
  buildPolicyFromCli,
  decideAction,
  mergeRules,
  type RuleMap,
} from "../src/permissions/policy.js";

describe("compilePattern", () => {
  it("treats * as non-separator wildcard for paths", () => {
    const re = compilePattern("src/*.ts", "path");
    expect(re.test("src/foo.ts")).toBe(true);
    expect(re.test("src/sub/foo.ts")).toBe(false);
  });

  it("treats ** as cross-separator wildcard for paths", () => {
    const re = compilePattern("src/**", "path");
    expect(re.test("src/foo.ts")).toBe(true);
    expect(re.test("src/sub/deep/foo.ts")).toBe(true);
  });

  it("normalizes backslash to forward slash for paths", () => {
    const re = compilePattern("src/*.ts", "path");
    expect(re.test("src\\foo.ts".replace(/\\/g, "/"))).toBe(true);
  });

  it("treats * as everything for commands", () => {
    const re = compilePattern("git status *", "command");
    expect(re.test("git status -u")).toBe(true);
    expect(re.test("git status main other arg")).toBe(true);
    expect(re.test("git checkout main")).toBe(false);
  });

  it("anchors patterns at start and end", () => {
    const re = compilePattern("foo", "command");
    expect(re.test("foo")).toBe(true);
    expect(re.test("foobar")).toBe(false);
    expect(re.test("xfoo")).toBe(false);
  });
});

describe("specificity", () => {
  it("counts non-wildcard chars", () => {
    expect(specificity("*")).toBe(0);
    expect(specificity("git status *")).toBe(11);
    expect(specificity("src/**/*.ts")).toBe(8);
    expect(specificity("exact-match")).toBe(11);
  });
});

describe("bashArityPrefix", () => {
  it("uses arity 2 for 'git'", () => {
    expect(bashArityPrefix("git checkout main")).toBe("git checkout *");
    expect(bashArityPrefix("git status")).toBe("git status *");
  });

  it("uses arity 3 for 'git stash'", () => {
    expect(bashArityPrefix("git stash pop foo")).toBe("git stash pop *");
  });

  it("uses arity 3 for 'npm run'", () => {
    expect(bashArityPrefix("npm run dev --turbo")).toBe("npm run dev *");
  });

  it("uses arity 2 for 'npm install'", () => {
    expect(bashArityPrefix("npm install zod")).toBe("npm install *");
  });

  it("uses arity 3 for 'docker compose'", () => {
    expect(bashArityPrefix("docker compose up -d")).toBe("docker compose up *");
  });

  it("falls back to first-token-* for unknown commands", () => {
    expect(bashArityPrefix("rg foo bar")).toBe("rg *");
    expect(bashArityPrefix("custom-tool --flag")).toBe("custom-tool *");
  });

  it("returns * for empty input", () => {
    expect(bashArityPrefix("")).toBe("*");
    expect(bashArityPrefix("   ")).toBe("*");
  });
});

describe("extractMatchKey and deriveScopePattern", () => {
  it("extracts the path arg for Read/Edit/Write", () => {
    expect(extractMatchKey("Read", { path: "src/foo.ts" })).toEqual({
      kind: "path",
      key: "src/foo.ts",
    });
    expect(extractMatchKey("Edit", { path: "src\\foo.ts" })).toEqual({
      kind: "path",
      key: "src/foo.ts",
    });
  });

  it("extracts the command arg for Shell", () => {
    expect(extractMatchKey("Shell", { command: "git status" })).toEqual({
      kind: "command",
      key: "git status",
    });
  });

  it("returns kind=any with empty key for tools without a known field", () => {
    expect(extractMatchKey("TodoWrite", { todos: [] })).toEqual({
      kind: "any",
      key: "",
    });
  });

  it("derives scope pattern as the parent directory glob for nested file tools", () => {
    expect(deriveScopePattern("Read", { path: "src/foo/bar.ts" })).toBe(
      "src/foo/*",
    );
    expect(deriveScopePattern("Edit", { path: "src/foo.ts" })).toBe(
      "src/*",
    );
  });

  it("keeps repo-root files as literal paths so [A]/[P] doesn't widen to '*'", () => {
    expect(deriveScopePattern("Read", { path: "README.md" })).toBe(
      "README.md",
    );
  });

  it("derives scope pattern via arity for Shell", () => {
    expect(deriveScopePattern("Shell", { command: "git checkout main" })).toBe(
      "git checkout *",
    );
  });

  it("derives * as fallback for tools with no match key", () => {
    expect(deriveScopePattern("TodoWrite", { todos: [] })).toBe("*");
  });
});

describe("decideAction with patterns", () => {
  const baseCfg = {
    defaultMode: "ask" as const,
    rules: new Map(),
    dangerouslySkipPermissions: false,
  };

  it("dangerouslySkipPermissions short-circuits to allow", () => {
    expect(
      decideAction(
        "Shell",
        "ask",
        { command: "rm -rf /" },
        { ...baseCfg, dangerouslySkipPermissions: true },
      ),
    ).toBe("allow");
  });

  it("returns rule action for the most specific matching rule", () => {
    const rules = new Map();
    appendRule(rules, "Shell", { pattern: "*", action: "ask" });
    appendRule(rules, "Shell", { pattern: "git status *", action: "allow" });
    rules.get("Shell")!.sort(
      (a: { pattern: string }, b: { pattern: string }) =>
        specificity(b.pattern) - specificity(a.pattern),
    );
    const cfg = { ...baseCfg, rules };
    expect(
      decideAction("Shell", "ask", { command: "git status -u" }, cfg),
    ).toBe("allow");
    expect(
      decideAction("Shell", "ask", { command: "rm -rf /" }, cfg),
    ).toBe("ask");
  });

  it("longer pattern wins over shorter when both match", () => {
    const rules = new Map();
    appendRule(rules, "Read", { pattern: "**/.env", action: "ask" });
    appendRule(rules, "Read", { pattern: "**/.env.example", action: "allow" });
    rules.get("Read")!.sort(
      (a: { pattern: string }, b: { pattern: string }) =>
        specificity(b.pattern) - specificity(a.pattern),
    );
    const cfg = { ...baseCfg, rules };
    expect(decideAction("Read", "ask", { path: ".env.example" }, cfg)).toBe(
      "allow",
    );
    expect(decideAction("Read", "ask", { path: ".env" }, cfg)).toBe("ask");
  });

  it("falls back to tool default when no rule matches", () => {
    expect(
      decideAction("Read", "auto-allow", { path: "src/foo.ts" }, baseCfg),
    ).toBe("allow");
    expect(decideAction("X", "auto-deny", null, baseCfg)).toBe("deny");
  });

  it("falls back to policy defaultMode when nothing else applies", () => {
    expect(
      decideAction(
        "Shell",
        "ask",
        { command: "x" },
        { ...baseCfg, defaultMode: "deny" },
      ),
    ).toBe("deny");
  });
});

describe("buildPolicyFromCli", () => {
  it("converts allowedTools list into per-tool wildcard-allow rules", () => {
    const cfg = buildPolicyFromCli({
      defaultMode: "ask",
      allowedTools: "Read,Glob",
    });
    expect(cfg.rules.get("Read")?.some(
      (r) => r.pattern === "*" && r.action === "allow",
    )).toBe(true);
    expect(cfg.rules.get("Glob")?.some(
      (r) => r.pattern === "*" && r.action === "allow",
    )).toBe(true);
  });

  it("converts disallowedTools list into per-tool wildcard-deny rules", () => {
    const cfg = buildPolicyFromCli({
      defaultMode: "ask",
      disallowedTools: "Shell",
    });
    const shellRules = cfg.rules.get("Shell") ?? [];
    expect(shellRules.some((r) => r.pattern === "*" && r.action === "deny"))
      .toBe(true);
  });

  it("bakes in sensitive-file defaults under Read/Edit/Write", () => {
    const cfg = buildPolicyFromCli({ defaultMode: "ask" });
    expect(decideAction("Read", "auto-allow", { path: "/x/.env" }, cfg)).toBe(
      "ask",
    );
    expect(
      decideAction("Read", "auto-allow", { path: "/x/.env.example" }, cfg),
    ).toBe("allow");
    expect(decideAction("Read", "auto-allow", { path: "/x/id_rsa" }, cfg)).toBe(
      "deny",
    );
    expect(
      decideAction("Edit", "ask", { path: "/x/.ssh/config" }, cfg),
    ).toBe("deny");
  });
});

describe("mergeRules", () => {
  it("combines multiple rule sources and resorts by specificity", () => {
    const a: RuleMap = new Map();
    appendRule(a, "Shell", { pattern: "*", action: "ask" });
    const b: RuleMap = new Map();
    appendRule(b, "Shell", { pattern: "git status *", action: "allow" });
    const merged = mergeRules(a, b);
    const list = merged.get("Shell")!;
    expect(list[0]!.pattern).toBe("git status *");
    expect(list[1]!.pattern).toBe("*");
  });

  it("preserves rules from both sources without dedup", () => {
    const a: RuleMap = new Map();
    appendRule(a, "Read", { pattern: "**/*.md", action: "allow" });
    const b: RuleMap = new Map();
    appendRule(b, "Read", { pattern: "**/.env", action: "ask" });
    const merged = mergeRules(a, b);
    expect(merged.get("Read")?.length).toBe(2);
  });
});
