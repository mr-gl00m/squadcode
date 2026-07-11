import { describe, expect, it } from "vitest";
import {
  appendRule,
  decideAction,
  type PermissionRule,
  type PolicyConfig,
  type RuleMap,
  sensitiveLayer,
  sortRulesInPlace,
} from "../src/permissions/policy.js";

function layer(tool: string, ...rules: PermissionRule[]): RuleMap {
  const m: RuleMap = new Map();
  for (const r of rules) appendRule(m, tool, r);
  sortRulesInPlace(m);
  return m;
}

const empty = (): RuleMap => new Map();

// Stack order the engine builds: sensitive > session > project > user-global > cli.
function stack(
  parts: {
    sensitive?: RuleMap;
    session?: RuleMap;
    project?: RuleMap;
    userGlobal?: RuleMap;
    cli?: RuleMap;
  },
  over: Partial<PolicyConfig> = {},
): PolicyConfig {
  return {
    defaultMode: "ask",
    rules: new Map(),
    layers: [
      parts.sensitive ?? empty(),
      parts.session ?? empty(),
      parts.project ?? empty(),
      parts.userGlobal ?? empty(),
      parts.cli ?? empty(),
    ],
    dangerouslySkipPermissions: false,
    mode: "act",
    ...over,
  };
}

describe("user-global permission layer", () => {
  it("auto-allows when only the user-global layer matches", () => {
    const cfg = stack({
      userGlobal: layer("Read", { pattern: "N:/proj_*/**", action: "allow" }),
    });
    expect(
      decideAction("Read", "ask", { path: "N:/proj_x/src/a.ts" }, cfg),
    ).toBe("allow");
  });

  it("does not match a path outside the granted pattern", () => {
    const cfg = stack({
      userGlobal: layer("Read", { pattern: "N:/proj_*/**", action: "allow" }),
    });
    // No layer matches → falls through to the tool default.
    expect(decideAction("Read", "ask", { path: "C:/other/a.ts" }, cfg)).toBe(
      "ask",
    );
  });
});

describe("precedence stack", () => {
  it("sensitive defaults are the floor — user-global allow cannot override .env", () => {
    const cfg = stack({
      sensitive: sensitiveLayer(),
      userGlobal: layer("Read", { pattern: "**", action: "allow" }),
    });
    // sensitive `**/.env` ask wins over the broad user-global allow.
    expect(decideAction("Read", "ask", { path: "N:/proj_x/.env" }, cfg)).toBe(
      "ask",
    );
    // ...but a non-sensitive in-project path still rides the user-global allow.
    expect(decideAction("Read", "ask", { path: "N:/proj_x/a.ts" }, cfg)).toBe(
      "allow",
    );
  });

  it("project rules beat user-global rules", () => {
    const cfg = stack({
      project: layer("Read", { pattern: "src/**", action: "deny" }),
      userGlobal: layer("Read", { pattern: "src/**", action: "allow" }),
    });
    expect(decideAction("Read", "ask", { path: "src/secret.ts" }, cfg)).toBe(
      "deny",
    );
  });

  it("session grants beat project and user-global", () => {
    const cfg = stack({
      session: layer("Shell", { pattern: "*", action: "allow" }),
      project: layer("Shell", { pattern: "*", action: "deny" }),
    });
    expect(decideAction("Shell", "ask", { command: "rm -rf x" }, cfg)).toBe(
      "allow",
    );
  });
});

describe("deny wins within a layer", () => {
  it("a deny beats a more-specific allow in the same layer", () => {
    const cfg = stack({
      userGlobal: layer(
        "Read",
        { pattern: "src/**", action: "allow" },
        { pattern: "src/secrets/**", action: "deny" },
      ),
    });
    expect(
      decideAction("Read", "ask", { path: "src/secrets/key.txt" }, cfg),
    ).toBe("deny");
    expect(decideAction("Read", "ask", { path: "src/app.ts" }, cfg)).toBe(
      "allow",
    );
  });
});

describe("plan mode interaction", () => {
  it("plan mode overrides a user-global allow on a mutating tool", () => {
    const cfg = stack(
      { userGlobal: layer("Edit", { pattern: "**", action: "allow" }) },
      { mode: "plan" },
    );
    expect(decideAction("Edit", "ask", { path: "src/a.ts" }, cfg)).toBe("deny");
  });

  it("a user-global allow on a read tool survives plan mode", () => {
    const cfg = stack(
      { userGlobal: layer("Read", { pattern: "**", action: "allow" }) },
      { mode: "plan" },
    );
    expect(decideAction("Read", "ask", { path: "src/a.ts" }, cfg)).toBe(
      "allow",
    );
  });
});
