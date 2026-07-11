import type { HookConfig } from "../hooks/config.js";
import { createHookRunner, type HookRunner } from "../hooks/runner.js";
import { logger } from "../logger.js";
import type { SessionStore } from "../sessions/store.js";

export async function buildHookRunner(
  store: SessionStore,
  sessionId: string,
  hooks: HookConfig[],
): Promise<HookRunner> {
  return createHookRunner({
    hooks,
    audit: (result) => {
      store.recordHookFire(sessionId, {
        id: result.id,
        event: result.event,
        ok: result.ok,
        status: result.status,
        elapsedMs: result.elapsedMs,
      });
    },
  });
}

export async function fireSessionStart(
  runner: HookRunner,
  sessionId: string,
  cwd: string,
  resumed: boolean,
): Promise<void> {
  try {
    await runner.fire({
      event: "SessionStart",
      sessionId,
      cwd,
      ...(resumed ? { error: "resumed" } : {}),
    });
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "SessionStart hook fire failed",
    );
  }
}

export async function fireSessionEnd(
  runner: HookRunner,
  sessionId: string,
  cwd: string,
): Promise<void> {
  try {
    await runner.fire({ event: "SessionEnd", sessionId, cwd });
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "SessionEnd hook fire failed",
    );
  }
}

export async function fireUserPromptSubmit(
  runner: HookRunner,
  sessionId: string,
  cwd: string,
  prompt: string,
): Promise<void> {
  try {
    await runner.fire({
      event: "UserPromptSubmit",
      sessionId,
      cwd,
      prompt,
    });
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "UserPromptSubmit hook fire failed",
    );
  }
}
