import { join } from "node:path";
import { atomicWriteText } from "../fs-io.js";
import { logger } from "../logger.js";
import { redactSecrets } from "../redact.js";

export function sidecarFilename(
  now: Date = new Date(),
  counter?: number,
): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  if (counter === undefined) return `${stamp}.md`;
  return `${stamp}-${counter.toString().padStart(6, "0")}.md`;
}

export function sidecarDir(baseDir: string, sessionId: string): string {
  return join(baseDir, sessionId, "messages");
}

// Per-session monotonic counter so two assistant messages emitted within the
// same millisecond produce distinct sidecar paths. atomicWriteText would
// otherwise overwrite the first sidecar with the second message's body. The
// counter is process-local; sessions across process restarts pick up at the
// next ms naturally, which is the granularity sidecars already document.
const sessionSidecarCounters = new Map<string, number>();

function nextSidecarCounter(sessionId: string): number {
  const next = (sessionSidecarCounters.get(sessionId) ?? 0) + 1;
  sessionSidecarCounters.set(sessionId, next);
  return next;
}

export async function writeAssistantMessageSidecar(args: {
  baseDir: string;
  sessionId: string;
  content: string;
  now?: Date;
}): Promise<string | null> {
  const { baseDir, sessionId, content } = args;
  if (content.trim().length === 0) return null;
  const path = join(
    sidecarDir(baseDir, sessionId),
    sidecarFilename(args.now, nextSidecarCounter(sessionId)),
  );
  try {
    await atomicWriteText(path, redactSecrets(content));
    return path;
  } catch (err: unknown) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        sessionId,
        path,
      },
      "assistant message sidecar write failed",
    );
    return null;
  }
}
