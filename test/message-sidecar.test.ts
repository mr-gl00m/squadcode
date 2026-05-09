import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sidecarDir,
  sidecarFilename,
  writeAssistantMessageSidecar,
} from "../src/sessions/message-sidecar.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "squad-sidecar-"));
}

describe("sidecarFilename", () => {
  it("renders an ISO timestamp with colons and dots replaced by dashes", () => {
    const name = sidecarFilename(new Date("2026-05-04T02:37:12.345Z"));
    expect(name).toBe("2026-05-04T02-37-12-345Z.md");
  });

  it("filenames sort lexically in chronological order", () => {
    const a = sidecarFilename(new Date("2026-05-04T02:37:12.345Z"));
    const b = sidecarFilename(new Date("2026-05-04T02:37:12.346Z"));
    const c = sidecarFilename(new Date("2026-05-04T02:37:13.000Z"));
    expect([c, a, b].sort()).toEqual([a, b, c]);
  });
});

describe("sidecarDir", () => {
  it("returns <baseDir>/<sessionId>/messages", () => {
    expect(sidecarDir("/tmp/sessions", "abc-123")).toBe(
      join("/tmp/sessions", "abc-123", "messages"),
    );
  });
});

describe("writeAssistantMessageSidecar", () => {
  it("writes the markdown content under <baseDir>/<sessionId>/messages/", async () => {
    const baseDir = await makeTempDir();
    const sessionId = "test-session";
    const content = "# Heading\n\nSome **bold** thing.\n";
    const path = await writeAssistantMessageSidecar({
      baseDir,
      sessionId,
      content,
      now: new Date("2026-05-04T02:37:12.345Z"),
    });
    expect(path).toBe(
      join(baseDir, sessionId, "messages", "2026-05-04T02-37-12-345Z.md"),
    );
    const written = await readFile(path!, "utf-8");
    expect(written).toBe(content);
  });

  it("creates the messages directory if it does not exist", async () => {
    const baseDir = await makeTempDir();
    await writeAssistantMessageSidecar({
      baseDir,
      sessionId: "fresh",
      content: "hello",
    });
    const entries = await readdir(join(baseDir, "fresh", "messages"));
    expect(entries.length).toBe(1);
  });

  it("returns null and skips writing when content is empty", async () => {
    const baseDir = await makeTempDir();
    const path = await writeAssistantMessageSidecar({
      baseDir,
      sessionId: "empty",
      content: "",
    });
    expect(path).toBeNull();
  });

  it("returns null when content is whitespace-only", async () => {
    const baseDir = await makeTempDir();
    const path = await writeAssistantMessageSidecar({
      baseDir,
      sessionId: "ws",
      content: "   \n\t\n",
    });
    expect(path).toBeNull();
  });
});
