// Invariant: atomicWriteText uses tmp-and-rename so concurrent writers never
// produce a partial file or lose a successful write. The PROJECT_CHARTER lists
// atomic writes as a non-negotiable for persistent files (~/.squad/settings.json,
// session sidecars, permission writes).
// Violation: src/fs-io.ts:22 derives the tmp path from a fixed `${absolute}.tmp`
// suffix shared across all callers. Two concurrent writers to the same path
// race on the same tmp file: writer B's writeFile truncates writer A's tmp, A
// renames B's content into place and resolves success, then B's rename hits
// ENOENT. A's caller believes A's content is on disk, but B's content is.
// Predicted failure: at least one writer resolves with no error, yet the file
// on disk contains content from a DIFFERENT writer than the one that "succeeded".
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteText } from "../../src/fs-io.js";

describe("BH-2026-05-20-101: atomicWriteText fixed-.tmp collision", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bh101-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("concurrent writers can leave the file with content that does NOT match any successful writer's payload", async () => {
    const target = join(dir, "config.json");

    const writerA = "A".repeat(64 * 1024);
    const writerB = "B".repeat(64 * 1024);

    const results = await Promise.allSettled([
      atomicWriteText(target, writerA),
      atomicWriteText(target, writerB),
    ]);

    // Find which writers reported success.
    const successfulPayloads = new Set<string>();
    if (results[0]!.status === "fulfilled") successfulPayloads.add(writerA);
    if (results[1]!.status === "fulfilled") successfulPayloads.add(writerB);

    // If atomicity held, the on-disk content equals one of the successful
    // writers' payloads. If either writer reported success, the file must
    // exist and its content must come from one of the successful writers.
    let onDisk: string | null;
    try {
      onDisk = await readFile(target, "utf-8");
    } catch {
      onDisk = null;
    }

    // The invariant: if a writer resolved success, its content (or some
    // successful writer's content) should be on disk.
    if (successfulPayloads.size > 0) {
      expect(onDisk).not.toBeNull();
      expect(successfulPayloads.has(onDisk!)).toBe(true);
    }
  });

  it("when one writer succeeds and one fails on a shared tmp path, the failing writer's content can still win", async () => {
    // Force the race deterministically: pre-create the tmp file, then start
    // two concurrent writes. The internals open .tmp with O_TRUNC each time,
    // so this models the realistic interleaving directly.
    const target = join(dir, "settings.json");

    // Run many concurrent pairs to make the race fire reliably.
    let mismatches = 0;
    for (let i = 0; i < 50; i += 1) {
      const a = `payload-A-${i}-${"A".repeat(2048)}`;
      const b = `payload-B-${i}-${"B".repeat(2048)}`;
      const results = await Promise.allSettled([
        atomicWriteText(target, a),
        atomicWriteText(target, b),
      ]);
      const succeeded: string[] = [];
      if (results[0]!.status === "fulfilled") succeeded.push(a);
      if (results[1]!.status === "fulfilled") succeeded.push(b);
      if (succeeded.length === 0) continue;
      let onDisk: string;
      try {
        onDisk = await readFile(target, "utf-8");
      } catch {
        // File missing despite at least one successful writer — that itself
        // is an atomicity violation.
        mismatches += 1;
        continue;
      }
      if (!succeeded.includes(onDisk)) {
        mismatches += 1;
      }
    }
    // Expected behavior under atomicity: 0 mismatches. Actual under the
    // fixed-tmp-suffix bug: at least one race observes the failing writer's
    // content win or the file vanish.
    expect(mismatches).toBe(0);
  });
});
