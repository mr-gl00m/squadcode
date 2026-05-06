import { join } from "node:path";
import { atomicWriteText } from "../fs-io.js";
import { logger } from "../logger.js";

export function sidecarFilename(now: Date = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}.md`;
}

export function sidecarDir(baseDir: string, sessionId: string): string {
  return join(baseDir, sessionId, "messages");
}

export async function writeAssistantMessageSidecar(args: {
  baseDir: string;
  sessionId: string;
  content: string;
  now?: Date;
}): Promise<string | null> {
  const { baseDir, sessionId, content } = args;
  if (content.trim().length === 0) return null;
  const path = join(sidecarDir(baseDir, sessionId), sidecarFilename(args.now));
  try {
    await atomicWriteText(path, content);
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
