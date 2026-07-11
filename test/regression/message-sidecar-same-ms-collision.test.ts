// Invariant: writeAssistantMessageSidecar writes each assistant message's
// content to a distinct file on disk so the transcript sidecar is a complete
// per-message record (one file per assistant turn).
// Violation: src/sessions/message-sidecar.ts:5 builds the filename from
// `new Date().toISOString()` with `:` and `.` replaced — millisecond
// resolution. Two assistant messages written within the same millisecond
// produce the same filename. The second write goes through atomicWriteText
// which overwrites the first, silently losing the first sidecar.
// Predicted failure: two writes with the same `now` Date return the same
// path string, and reading that path returns only the second message's body.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeAssistantMessageSidecar } from "../../src/sessions/message-sidecar.js";

describe("BH-2026-05-20-102: assistant message sidecars collide at ms resolution", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "bh102-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("two assistant messages emitted in the same millisecond overwrite the first sidecar", async () => {
    const now = new Date("2026-05-20T12:00:00.000Z");
    const sessionId = "session-abc";

    const firstPath = await writeAssistantMessageSidecar({
      baseDir,
      sessionId,
      content: "first message body",
      now,
    });
    const secondPath = await writeAssistantMessageSidecar({
      baseDir,
      sessionId,
      content: "second message body",
      now,
    });

    expect(firstPath).not.toBeNull();
    expect(secondPath).not.toBeNull();

    // Invariant: distinct messages should produce distinct sidecar files.
    expect(secondPath).not.toBe(firstPath);

    // And the first message's content should still be readable on disk after
    // the second write — sidecars persist the transcript.
    const firstOnDisk = await readFile(firstPath!, "utf-8");
    expect(firstOnDisk).toBe("first message body");
  });
});
