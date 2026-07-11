import { afterEach, describe, expect, it } from "vitest";
import { FORCE_KILL_GRACE_MS, shellTool } from "../src/tools/shell.js";
import {
  isBaselineAllowed,
  isCredentialShaped,
  resolveStrict,
  sanitizeChildEnv,
} from "../src/tools/shell-env.js";
import type { ToolContext } from "../src/tools/types.js";

const IS_WINDOWS = process.platform === "win32";
const SKIP_ON_WINDOWS = IS_WINDOWS;

function ctx(): ToolContext {
  return {
    cwd: process.cwd(),
    callId: "test",
    signal: new AbortController().signal,
  };
}

describe("shell tool kill grace", () => {
  it.skipIf(SKIP_ON_WINDOWS)(
    "force-kills a process that ignores SIGTERM after the grace window",
    async () => {
      // Node child that traps SIGTERM and refuses to exit. The killTree path
      // sends SIGTERM first, waits FORCE_KILL_GRACE_MS, then escalates to
      // SIGKILL. This process should be reported with signal=SIGKILL.
      const cmd = `node -e "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"`;
      const start = Date.now();
      const result = await shellTool.execute(
        { command: cmd, timeoutMs: 100 },
        ctx(),
      );
      const elapsed = Date.now() - start;
      expect(result.ok).toBe(false);
      expect(result.error).toBe("SHELL_TIMEOUT");
      expect(result.content).toContain("signal: SIGKILL");
      expect(result.content).toContain(
        `force-killed after ${FORCE_KILL_GRACE_MS}ms grace`,
      );
      // Should have waited approximately the full grace before force-killing.
      expect(elapsed).toBeGreaterThanOrEqual(FORCE_KILL_GRACE_MS);
      expect(elapsed).toBeLessThan(FORCE_KILL_GRACE_MS + 2_000);
    },
    FORCE_KILL_GRACE_MS + 5_000,
  );

  it.skipIf(SKIP_ON_WINDOWS)(
    "lets a process that handles SIGTERM exit cleanly during the grace window",
    async () => {
      // Node child that catches SIGTERM and exits in ~50ms. SIGKILL should
      // never fire because the process is gone before the grace expires.
      const cmd = `node -e "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 50)); setInterval(() => {}, 1000);"`;
      const start = Date.now();
      const result = await shellTool.execute(
        { command: cmd, timeoutMs: 100 },
        ctx(),
      );
      const elapsed = Date.now() - start;
      expect(result.ok).toBe(false);
      expect(result.error).toBe("SHELL_TIMEOUT");
      // Process exited from its own setTimeout, not from a kill signal,
      // so the close handler reports no signal (or SIGTERM) — never SIGKILL.
      expect(result.content).not.toContain("signal: SIGKILL");
      // Should finish well before the grace window expires.
      expect(elapsed).toBeLessThan(FORCE_KILL_GRACE_MS);
    },
    FORCE_KILL_GRACE_MS + 5_000,
  );

  it("returns successfully for a process that exits before the timeout", async () => {
    const cmd = IS_WINDOWS ? "Write-Output hello" : "echo hello";
    const result = await shellTool.execute(
      { command: cmd, timeoutMs: 5_000 },
      ctx(),
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("exit_code: 0");
    expect(result.content).toContain("hello");
  });
});

describe("shell env allowlist — credential pattern", () => {
  it("flags provider keys and common secret shapes", () => {
    for (const name of [
      "DEEPSEEK_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GITHUB_TOKEN",
      "NPM_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "DB_PASSWORD",
      "MY_PASSWD",
      "SIGNING_KEY",
      "SSH_AUTH_SOCK",
      "SESSION_TOKEN",
      "PASSPHRASE",
      "API_KEY",
      "KEY",
    ]) {
      expect(isCredentialShaped(name), name).toBe(true);
    }
  });

  it("does not flag ordinary names that merely contain key/auth substrings", () => {
    for (const name of [
      "PATH",
      "MONKEY",
      "KEYBOARD_LAYOUT",
      "AUTHOR",
      "TURKEY",
      "NODE_ENV",
      "EDITOR",
      "LANG",
    ]) {
      expect(isCredentialShaped(name), name).toBe(false);
    }
  });
});

describe("shell env allowlist — baseline membership", () => {
  it("allows the cross-platform and Windows essentials, case-insensitively", () => {
    for (const name of [
      "PATH",
      "HOME",
      "TERM",
      "LANG",
      "SystemRoot",
      "ProgramFiles(x86)",
      "comspec",
      "LC_ALL",
      "LC_CTYPE",
    ]) {
      expect(isBaselineAllowed(name), name).toBe(true);
    }
  });

  it("excludes non-baseline and credential names from the baseline", () => {
    for (const name of ["NODE_ENV", "DEEPSEEK_API_KEY", "RANDOM_FLAG"]) {
      expect(isBaselineAllowed(name), name).toBe(false);
    }
  });
});

describe("shell env allowlist — strict resolution", () => {
  it("honors an explicit option over everything", () => {
    expect(resolveStrict({ CI: "true" }, { strict: false })).toBe(false);
    expect(resolveStrict({}, { strict: true })).toBe(true);
  });

  it("honors SQUAD_SHELL_ENV_STRICT over CI detection", () => {
    expect(resolveStrict({ CI: "true", SQUAD_SHELL_ENV_STRICT: "0" }, {})).toBe(
      false,
    );
    expect(resolveStrict({ SQUAD_SHELL_ENV_STRICT: "1" }, {})).toBe(true);
  });

  it("auto-engages strict under CI", () => {
    expect(resolveStrict({ CI: "true" }, {})).toBe(true);
    expect(resolveStrict({ CI: "1" }, {})).toBe(true);
    expect(resolveStrict({ CI: "false" }, {})).toBe(false);
    expect(resolveStrict({}, {})).toBe(false);
  });
});

describe("sanitizeChildEnv", () => {
  const parent: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    HOME: "/home/cid",
    NODE_ENV: "test",
    BUILD_FLAG: "on",
    DEEPSEEK_API_KEY: "sk-secret",
    GITHUB_TOKEN: "ghp_secret",
    DB_PASSWORD: "hunter2",
  };

  it("lenient: keeps normal vars, drops credential-shaped ones", () => {
    const out = sanitizeChildEnv(parent, { strict: false });
    expect(out.PATH).toBe("/usr/bin");
    expect(out.NODE_ENV).toBe("test");
    expect(out.BUILD_FLAG).toBe("on");
    expect(out.DEEPSEEK_API_KEY).toBeUndefined();
    expect(out.GITHUB_TOKEN).toBeUndefined();
    expect(out.DB_PASSWORD).toBeUndefined();
  });

  it("strict: keeps only baseline, drops normal and credential vars alike", () => {
    const out = sanitizeChildEnv(parent, { strict: true });
    expect(out.PATH).toBe("/usr/bin");
    expect(out.HOME).toBe("/home/cid");
    expect(out.NODE_ENV).toBeUndefined();
    expect(out.BUILD_FLAG).toBeUndefined();
    expect(out.DEEPSEEK_API_KEY).toBeUndefined();
  });

  it("never includes a credential-shaped var in either mode", () => {
    for (const strict of [true, false]) {
      const out = sanitizeChildEnv(parent, { strict });
      expect(Object.keys(out).some(isCredentialShaped)).toBe(false);
    }
  });
});

describe("shell env allowlist — end to end", () => {
  const saved = {
    normal: process.env.SQUAD_TEST_NORMAL,
    secret: process.env.SQUAD_TEST_TOKEN,
    strict: process.env.SQUAD_SHELL_ENV_STRICT,
  };
  afterEach(() => {
    restore("SQUAD_TEST_NORMAL", saved.normal);
    restore("SQUAD_TEST_TOKEN", saved.secret);
    restore("SQUAD_SHELL_ENV_STRICT", saved.strict);
  });
  function restore(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  it("a secret-shaped var does not reach the spawned child, a normal one does", async () => {
    process.env.SQUAD_TEST_NORMAL = "kept";
    process.env.SQUAD_TEST_TOKEN = "leaked";
    process.env.SQUAD_SHELL_ENV_STRICT = "0"; // force lenient regardless of CI
    const cmd = IS_WINDOWS
      ? 'Write-Output "N=$env:SQUAD_TEST_NORMAL S=$env:SQUAD_TEST_TOKEN"'
      : 'echo "N=$SQUAD_TEST_NORMAL S=$SQUAD_TEST_TOKEN"';
    const result = await shellTool.execute(
      { command: cmd, timeoutMs: 10_000 },
      ctx(),
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("N=kept");
    expect(result.content).toContain("S=");
    expect(result.content).not.toContain("leaked");
  });
});
