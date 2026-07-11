// Invariant: each artifact reference returned by writeArtifact must continue
// to address the full content for that specific tool call. Provider call IDs
// are opaque, so filename derivation must not let distinct IDs collide.
// Violation: artifactPath truncates sanitized call IDs to 80 characters
// without adding a disambiguator, so two distinct long IDs with the same
// prefix write the same path and the later artifact overwrites the earlier one.
// Predicted failure: reading the first returned artifact path yields the
// second call's content.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeArtifact } from "../../src/sessions/artifacts.js";

describe("repro: artifact paths remain unique for opaque call ids", () => {
  it("does not let long call ids with a shared prefix overwrite each other", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "squad-artifact-collision-"));
    const prefix = "a".repeat(80);

    const first = await writeArtifact({
      sessionId: "session",
      callId: `${prefix}x`,
      content: "first content",
      baseDir,
    });
    await writeArtifact({
      sessionId: "session",
      callId: `${prefix}y`,
      content: "second content",
      baseDir,
    });

    expect(await readFile(first.path, "utf-8")).toBe("first content");
  });
});
