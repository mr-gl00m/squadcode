import { describe, expect, it } from "vitest";
import { FORCE_KILL_GRACE_MS, shellTool } from "../src/tools/shell.js";
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
    const cmd = IS_WINDOWS
      ? "Write-Output hello"
      : "echo hello";
    const result = await shellTool.execute(
      { command: cmd, timeoutMs: 5_000 },
      ctx(),
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("exit_code: 0");
    expect(result.content).toContain("hello");
  });
});
