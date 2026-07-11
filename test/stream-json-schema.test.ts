import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  generateStreamJsonSchema,
  streamJsonRecordSchema,
} from "../src/cli/stream-json-schema.js";

describe("stream-json schema contract", () => {
  it("matches the committed generated schema", async () => {
    const committed = JSON.parse(
      await readFile(resolve("schema", "stream-json.v1.json"), "utf8"),
    ) as unknown;
    expect(committed).toEqual(generateStreamJsonSchema());
  });

  it("rejects an unversioned init record", () => {
    expect(
      streamJsonRecordSchema.safeParse({
        ts: new Date().toISOString(),
        type: "init",
        sessionId: "S1",
        provider: "p",
        model: "m",
        cwd: ".",
      }).success,
    ).toBe(false);
  });
});
