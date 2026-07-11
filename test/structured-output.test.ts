import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadOutputSchema,
  validateStructuredOutput,
  writeLastMessage,
} from "../src/cli/structured-output.js";

describe("print-mode structured output", () => {
  it("loads a schema and validates the final JSON message", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "squad-output-"));
    await writeFile(
      join(cwd, "schema.json"),
      JSON.stringify({
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      }),
      "utf8",
    );
    const schema = await loadOutputSchema("schema.json", cwd);
    expect(validateStructuredOutput('{"answer":"yes"}', schema)).toEqual({
      answer: "yes",
    });
    expect(() => validateStructuredOutput('{"answer":3}', schema)).toThrow(
      "does not match",
    );
    expect(() => validateStructuredOutput("```json", schema)).toThrow(
      "not valid JSON",
    );
  });

  it("atomically writes the exact last assistant message", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "squad-output-"));
    await writeLastMessage("result/final.json", cwd, '{"ok":true}');
    expect(await readFile(join(cwd, "result", "final.json"), "utf8")).toBe(
      '{"ok":true}',
    );
  });
});
