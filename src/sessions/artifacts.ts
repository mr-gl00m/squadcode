import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, normalize, sep } from "node:path";
import { atomicWriteText, readText } from "../fs-io.js";
import { logger } from "../logger.js";

// Threshold above which a tool result spills to a sidecar instead of being
// embedded inline. Below this, the cost of opening another file is worse
// than just keeping the content in the JSONL transcript and the next-turn
// prompt. 10KB is roughly 100-200 lines of typical text — anything larger
// usually wants paging anyway.
export const ARTIFACT_THRESHOLD_BYTES = 10_000;

// Bytes of the tail to keep inline when an artifact is written. Long enough
// to surface the actual interesting result line (test failure summary, last
// grep hits, error message at end of stderr) while small enough that 5-10
// oversized calls in a turn don't reconstruct the original blowup.
export const ARTIFACT_TAIL_BYTES = 2_000;

const STATE_DIR = join(homedir(), ".squad");
const SESSIONS_ROOT = join(STATE_DIR, "sessions");

export interface ArtifactRef {
  path: string;
  sha256: string;
  fullSizeBytes: number;
}

export function artifactDir(sessionId: string, baseDir: string = SESSIONS_ROOT): string {
  return join(baseDir, sessionId, "artifacts");
}

export function artifactsRoot(baseDir: string = SESSIONS_ROOT): string {
  return baseDir;
}

function safeCallIdSegment(callId: string): string {
  // Tool call ids come from providers and are usually opaque tokens
  // (call_abc123, toolu_…). Strip anything that isn't filename-safe so a
  // weird id can't escape the artifact directory or crash the writer.
  const cleaned = callId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return cleaned.length > 0 ? cleaned.slice(0, 80) : "call";
}

export function artifactPath(
  sessionId: string,
  callId: string,
  baseDir: string = SESSIONS_ROOT,
): string {
  return join(artifactDir(sessionId, baseDir), `${safeCallIdSegment(callId)}.txt`);
}

export async function writeArtifact(args: {
  sessionId: string;
  callId: string;
  content: string;
  baseDir?: string;
}): Promise<ArtifactRef> {
  const { sessionId, callId, content } = args;
  const baseDir = args.baseDir ?? SESSIONS_ROOT;
  const path = artifactPath(sessionId, callId, baseDir);
  const buf = Buffer.from(content, "utf-8");
  const sha256 = createHash("sha256").update(buf).digest("hex");
  await atomicWriteText(path, content);
  return { path, sha256, fullSizeBytes: buf.byteLength };
}

export async function readArtifact(path: string): Promise<string> {
  return readText(path);
}

export function tailPreview(content: string, tailBytes: number = ARTIFACT_TAIL_BYTES): string {
  const buf = Buffer.from(content, "utf-8");
  if (buf.byteLength <= tailBytes) return content;
  const slice = buf.subarray(buf.byteLength - tailBytes).toString("utf-8");
  // Cut to the next newline so we don't start mid-line on a partial token.
  const newlineIdx = slice.indexOf("\n");
  if (newlineIdx >= 0 && newlineIdx < slice.length - 1) {
    return slice.slice(newlineIdx + 1);
  }
  return slice;
}

export function composeOffloadedContent(content: string, ref: ArtifactRef): string {
  const tail = tailPreview(content);
  const sizeKB = (ref.fullSizeBytes / 1024).toFixed(1);
  return (
    `${tail}\n` +
    `... (output truncated; full ${sizeKB}KB saved to ${ref.path})\n` +
    `Read that file directly to see the rest. sha256=${ref.sha256.slice(0, 12)}`
  );
}

export interface OffloadResult {
  content: string;
  artifact: ArtifactRef;
}

export async function maybeOffload(args: {
  sessionId: string;
  callId: string;
  content: string;
  threshold?: number;
  baseDir?: string;
}): Promise<OffloadResult | null> {
  const threshold = args.threshold ?? ARTIFACT_THRESHOLD_BYTES;
  const byteLength = Buffer.byteLength(args.content, "utf-8");
  if (byteLength <= threshold) return null;
  try {
    const artifact = await writeArtifact({
      sessionId: args.sessionId,
      callId: args.callId,
      content: args.content,
      ...(args.baseDir !== undefined && { baseDir: args.baseDir }),
    });
    return { content: composeOffloadedContent(args.content, artifact), artifact };
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), callId: args.callId },
      "artifact write failed; falling back to inline content",
    );
    return null;
  }
}

// Bound offload helper for the agent loop. Captures sessionId so callers
// don't have to thread it through every call site, and matches the
// OffloadLargeOutputFn shape from src/engine/loop.ts.
export function makeOffloadLargeOutput(args: {
  sessionId: string;
  baseDir?: string;
  threshold?: number;
}): (call: {
  callId: string;
  toolName: string;
  content: string;
}) => Promise<{ content: string; artifact: ArtifactRef } | null> {
  return async (call) => {
    return await maybeOffload({
      sessionId: args.sessionId,
      callId: call.callId,
      content: call.content,
      ...(args.threshold !== undefined && { threshold: args.threshold }),
      ...(args.baseDir !== undefined && { baseDir: args.baseDir }),
    });
  };
}

// Used by the path validator to whitelist artifact reads. The check accepts
// any session's artifact subtree — the model is meant to read its own
// sidecars, but cross-session reads are harmless (everything's under the
// user's own ~/.squad).
export function isUnderSessionsRoot(
  absolutePath: string,
  baseDir: string = SESSIONS_ROOT,
): boolean {
  const root = normalize(baseDir);
  const candidate = normalize(absolutePath);
  if (candidate === root) return true;
  return candidate.startsWith(root + sep);
}
