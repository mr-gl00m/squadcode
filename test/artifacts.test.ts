import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_TAIL_BYTES,
  ARTIFACT_THRESHOLD_BYTES,
  artifactDir,
  artifactPath,
  composeOffloadedContent,
  isUnderSessionsRoot,
  makeOffloadLargeOutput,
  maybeOffload,
  tailPreview,
  writeArtifact,
} from "../src/sessions/artifacts.js";

async function tempBaseDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "squad-artifacts-"));
}

function sha256Of(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "utf-8")).digest("hex");
}

describe("artifact helpers", () => {
  it("writeArtifact persists full content and returns a matching sha256", async () => {
    const baseDir = await tempBaseDir();
    const content = "line one\nline two\nline three\n";
    const ref = await writeArtifact({
      sessionId: "abc",
      callId: "call_x1",
      content,
      baseDir,
    });
    expect(ref.path).toBe(artifactPath("abc", "call_x1", baseDir));
    expect(ref.sha256).toBe(sha256Of(content));
    expect(ref.fullSizeBytes).toBe(Buffer.byteLength(content, "utf-8"));
    const onDisk = await readFile(ref.path, "utf-8");
    expect(onDisk).toBe(content);
  });

  it("writeArtifact sanitizes filename-unsafe characters in callId", async () => {
    const baseDir = await tempBaseDir();
    const ref = await writeArtifact({
      sessionId: "s",
      callId: "../escape/with spaces",
      content: "x",
      baseDir,
    });
    // Slashes and spaces collapse to underscores; the resulting basename is
    // a single path segment, so even with embedded dots there's no directory
    // traversal risk. The id-hash disambiguator is appended after the safe
    // prefix to prevent long-id collisions.
    const dir = join(baseDir, "s", "artifacts");
    const basename = ref.path.slice(dir.length + 1);
    expect(ref.path.startsWith(dir + sep)).toBe(true);
    expect(basename.startsWith(".._escape_with_spaces_")).toBe(true);
    expect(basename.endsWith(".txt")).toBe(true);
  });

  it("artifactDir and artifactPath compose the canonical layout", () => {
    const base = "/tmp/x";
    expect(artifactDir("sess1", base)).toBe(join(base, "sess1", "artifacts"));
    const p = artifactPath("sess1", "callA", base);
    expect(p.startsWith(join(base, "sess1", "artifacts") + sep)).toBe(true);
    expect(p.endsWith(".txt")).toBe(true);
    // Distinct ids must produce distinct paths even when their sanitized
    // prefixes collide on the 80-char truncation boundary (BH-2026-05-20-002).
    const prefix = "a".repeat(80);
    expect(artifactPath("sess1", `${prefix}x`, base)).not.toBe(
      artifactPath("sess1", `${prefix}y`, base),
    );
  });
});

describe("tailPreview", () => {
  it("returns content unchanged when smaller than the tail budget", () => {
    expect(tailPreview("short text", 1000)).toBe("short text");
  });

  it("returns roughly the last N bytes for oversized content", () => {
    const long = "x".repeat(10_000) + "\nFINAL_LINE";
    const tail = tailPreview(long, 200);
    expect(tail.endsWith("FINAL_LINE")).toBe(true);
    expect(Buffer.byteLength(tail, "utf-8")).toBeLessThanOrEqual(200);
  });

  it("starts the tail at a newline boundary so it doesn't slice mid-line", () => {
    const head = "A".repeat(500);
    const middle = "MIDDLE_TOKEN";
    const tail = "tail line";
    const content = `${head}\n${middle}\n${tail}`;
    const result = tailPreview(content, 30);
    // The result must not begin in the middle of the leading A-run; the
    // function should advance past the first newline in its byte slice.
    expect(result.startsWith("A")).toBe(false);
    expect(result.includes("tail line")).toBe(true);
  });
});

describe("composeOffloadedContent", () => {
  it("includes the tail, the on-disk path, and a sha256 prefix", () => {
    const ref = {
      path: "/abs/foo.txt",
      sha256: "deadbeef".repeat(8),
      fullSizeBytes: 12345,
    };
    const out = composeOffloadedContent("hello tail", ref);
    expect(out).toContain("hello tail");
    expect(out).toContain("/abs/foo.txt");
    expect(out).toContain("sha256=deadbeefdead");
    expect(out).toContain("12.1KB");
  });
});

describe("maybeOffload", () => {
  it("returns null when content is under the threshold", async () => {
    const baseDir = await tempBaseDir();
    const out = await maybeOffload({
      sessionId: "s",
      callId: "c1",
      content: "small",
      baseDir,
    });
    expect(out).toBeNull();
  });

  it("writes a sidecar and returns substituted content when over the threshold", async () => {
    const baseDir = await tempBaseDir();
    const big = "L".repeat(ARTIFACT_THRESHOLD_BYTES + 100) + "\nTAIL_MARKER";
    const out = await maybeOffload({
      sessionId: "s2",
      callId: "c2",
      content: big,
      baseDir,
    });
    expect(out).not.toBeNull();
    expect(out!.artifact.fullSizeBytes).toBe(Buffer.byteLength(big, "utf-8"));
    expect(out!.artifact.sha256).toBe(sha256Of(big));
    const onDisk = await readFile(out!.artifact.path, "utf-8");
    expect(onDisk).toBe(big);
    // Substituted content is the tail + bookkeeping line, much smaller than original.
    expect(Buffer.byteLength(out!.content, "utf-8")).toBeLessThan(
      ARTIFACT_TAIL_BYTES + 500,
    );
    expect(out!.content).toContain("TAIL_MARKER");
    expect(out!.content).toContain(out!.artifact.path);
  });

  it("respects a custom threshold override", async () => {
    const baseDir = await tempBaseDir();
    const out = await maybeOffload({
      sessionId: "s3",
      callId: "c3",
      content: "0123456789",
      threshold: 5,
      baseDir,
    });
    expect(out).not.toBeNull();
    expect(out!.artifact.fullSizeBytes).toBe(10);
  });
});

describe("makeOffloadLargeOutput", () => {
  it("produces a closure that captures sessionId and forwards to maybeOffload", async () => {
    const baseDir = await tempBaseDir();
    const fn = makeOffloadLargeOutput({
      sessionId: "bound",
      baseDir,
      threshold: 4,
    });
    const small = await fn({ callId: "c", toolName: "Read", content: "hi" });
    expect(small).toBeNull();
    const big = await fn({
      callId: "c2",
      toolName: "Read",
      content: "hello world",
    });
    expect(big).not.toBeNull();
    expect(big!.artifact.path).toBe(artifactPath("bound", "c2", baseDir));
  });
});

describe("isUnderSessionsRoot", () => {
  it("returns true for paths under the sessions tree", () => {
    const base = "/home/u/.squad/sessions";
    expect(
      isUnderSessionsRoot("/home/u/.squad/sessions/abc/artifacts/x.txt", base),
    ).toBe(true);
    expect(isUnderSessionsRoot(base, base)).toBe(true);
  });

  it("returns false for sibling paths with a shared prefix", () => {
    const base = "/home/u/.squad/sessions";
    expect(
      isUnderSessionsRoot("/home/u/.squad/sessions-other/x.txt", base),
    ).toBe(false);
    expect(isUnderSessionsRoot("/home/u/.squad/audit.db", base)).toBe(false);
  });
});
