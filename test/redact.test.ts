import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteText } from "../src/fs-io.js";
import { redactSecrets, redactSecretsInValue } from "../src/redact.js";
import { writeArtifact } from "../src/sessions/artifacts.js";
import { SessionWriter } from "../src/sessions/writer.js";

const SYNTHETIC_KEY = "sk-test_1234567890abcdef";
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "squad-sinks-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("secret redaction", () => {
  it("redacts common key, bearer, and assignment forms", () => {
    const input = [
      SYNTHETIC_KEY,
      "AKIA1234567890ABCDEF",
      "Authorization: Bearer abc.def.ghi12345",
      "password = hunter2",
      "api_key: 'value123'",
    ].join("\n");
    const redacted = redactSecrets(input);
    expect(redacted).not.toContain(SYNTHETIC_KEY);
    expect(redacted).not.toContain("AKIA1234567890ABCDEF");
    expect(redacted).not.toContain("abc.def.ghi12345");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("value123");
    expect(redacted.match(/\[REDACTED_SECRET\]/g)?.length).toBe(5);
  });

  it("redacts nested values used by log serializers", () => {
    expect(
      redactSecretsInValue({
        request: { authorization: `Bearer ${SYNTHETIC_KEY}` },
      }),
    ).toEqual({
      request: { authorization: "Bearer [REDACTED_SECRET]" },
    });
  });

  it("never writes a synthetic key into a session transcript", async () => {
    const path = join(dir, "session.jsonl");
    const writer = new SessionWriter(path);
    await writer.open();
    await writer.append({
      ts: new Date().toISOString(),
      sessionId: "S1",
      type: "user_message",
      payload: { content: `use ${SYNTHETIC_KEY}` },
    });
    await writer.close();

    const disk = await readFile(path, "utf8");
    expect(disk).not.toContain(SYNTHETIC_KEY);
    expect(disk).toContain("[REDACTED_SECRET]");
  });

  it("redacts artifact content before hashing and writing", async () => {
    const ref = await writeArtifact({
      sessionId: "S1",
      callId: "call-1",
      content: `output ${SYNTHETIC_KEY}`,
      baseDir: dir,
    });
    const disk = await readFile(ref.path, "utf8");
    expect(disk).toBe("output [REDACTED_SECRET]");
    expect(ref.sha256).toBe(createHash("sha256").update(disk).digest("hex"));
  });
});

describe("recoverable persistence", () => {
  it("leaves the previous file intact when failure is injected before rename", async () => {
    const target = join(dir, "record.json");
    await atomicWriteText(target, "old-record\n");
    await expect(
      atomicWriteText(target, "new-record\n", {
        beforeRename: async () => {
          throw new Error("injected crash");
        },
      }),
    ).rejects.toThrow("injected crash");
    expect(await readFile(target, "utf8")).toBe("old-record\n");
  });

  it.runIf(process.platform !== "win32")(
    "preserves an existing file mode across atomic replacement",
    async () => {
      const target = join(dir, "mode.txt");
      await atomicWriteText(target, "before");
      await chmod(target, 0o640);
      await atomicWriteText(target, "after");
      expect((await stat(target)).mode & 0o777).toBe(0o640);
    },
  );

  it("keeps a queued record buffered, reopens, and retries after a failed handle", async () => {
    const target = join(dir, "retry.jsonl");
    const writer = new SessionWriter(target, {
      afterWriteBeforeSync: async ({ attempt }) => {
        if (attempt === 1) throw new Error("transient fsync failure");
      },
    });
    await writer.open();
    await writer.append({
      ts: new Date().toISOString(),
      sessionId: "S1",
      type: "user_message",
      payload: { content: "once" },
    });
    await writer.close();
    const lines = (await readFile(target, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      payload: { content: "once" },
    });
  });

  it("surfaces terminal writer failure through append, flush, and close", async () => {
    const target = join(dir, "terminal.jsonl");
    const writer = new SessionWriter(target, {
      maxWriteAttempts: 2,
      beforeWrite: async () => {
        throw new Error("disk unavailable");
      },
    });
    await writer.open();
    await expect(
      writer.append({
        ts: new Date().toISOString(),
        sessionId: "S1",
        type: "user_message",
        payload: { content: "not lost silently" },
      }),
    ).rejects.toThrow("disk unavailable");
    await expect(writer.flush()).rejects.toThrow("disk unavailable");
    await expect(writer.close()).rejects.toThrow("disk unavailable");
  });

  it("keeps the original transcript and reopens after a failed rewrite", async () => {
    const target = join(dir, "rewrite.jsonl");
    let failRewrite = true;
    const writer = new SessionWriter(target, {
      beforeRewriteRename: async () => {
        if (failRewrite) {
          failRewrite = false;
          throw new Error("injected rewrite failure");
        }
      },
    });
    await writer.open();
    const first = {
      ts: "2026-07-10T00:00:00.000Z",
      sessionId: "S1",
      type: "user_message" as const,
      payload: { content: "first" },
    };
    await writer.append(first);
    await expect(
      writer.rewrite([
        {
          ...first,
          payload: { content: "replacement" },
        },
      ]),
    ).rejects.toThrow("injected rewrite failure");
    await writer.append({
      ...first,
      ts: "2026-07-10T00:01:00.000Z",
      payload: { content: "after failure" },
    });
    await writer.close();

    const records = (await readFile(target, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.payload.content)).toEqual([
      "first",
      "after failure",
    ]);
  });
});
