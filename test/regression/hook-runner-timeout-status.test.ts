// Invariant: when a command hook exceeds its timeoutMs, the exit handler
// reports `timeout=<ms>ms` so observability can distinguish a hook that
// was killed by the timeout from one that received a manual signal.
// Violation: the runner declares `timedOut`, defines an `onTimeout`
// callback that would set it to true, but never wires `onTimeout` into
// any handler. The setTimeout callback only calls child.kill("SIGKILL")
// without flipping `timedOut`, so the exit handler always reports
// `signal=SIGKILL` instead of `timeout=...`. (See hooks/runner.ts:134-139:
// `void onTimeout;` is the giveaway — the symbol is referenced only to
// silence the unused-binding lint, not actually invoked.)
// Predicted failure: assertion that result.status starts with "timeout="
// fails because the actual status starts with "signal=" or
// "exit=null/signal=".

import { expect, it } from "vitest";
import type { CommandHook } from "../../src/hooks/config.js";
import type { HookContext } from "../../src/hooks/runner.js";
import { runCommandHook } from "../../src/hooks/runner.js";

const IS_WINDOWS = process.platform === "win32";

it("command hook timeout surfaces timeout=<ms> in status, not signal=", async () => {
  const hook: CommandHook = {
    id: "bh005",
    type: "command",
    event: "PreToolUse",
    command: IS_WINDOWS
      ? 'powershell -NoProfile -Command "Start-Sleep -Seconds 5"'
      : "sleep 5",
    timeoutMs: 250,
  };
  const ctx: HookContext = {
    event: "PreToolUse",
    sessionId: "s1",
    cwd: process.cwd(),
  };
  const result = await runCommandHook(hook, ctx);
  expect(result.ok).toBe(false);
  expect(
    result.status.startsWith("timeout="),
    `expected status to start with "timeout=", got: ${result.status}`,
  ).toBe(true);
}, 15_000);
