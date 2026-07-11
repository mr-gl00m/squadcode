import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendInputHistory,
  findHistoryMatch,
  loadInputHistory,
} from "../src/cli/input-history.js";

describe("input history", () => {
  it("persists redacted entries without adjacent duplicates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squad-history-"));
    const path = join(dir, "history.json");
    await appendInputHistory("use token sk-12345678901234567890", path);
    await appendInputHistory("use token sk-12345678901234567890", path);
    const history = await loadInputHistory(path);
    expect(history).toHaveLength(1);
    expect(history[0]).not.toContain("sk-12345678901234567890");
    expect(await readFile(path, "utf8")).not.toContain(
      "sk-12345678901234567890",
    );
  });

  it("searches backward case-insensitively", () => {
    const history = ["fix parser", "write docs", "Fix renderer"];
    expect(findHistoryMatch(history, "fix")).toBe(2);
    expect(findHistoryMatch(history, "fix", 2)).toBe(0);
    expect(findHistoryMatch(history, "missing")).toBeNull();
  });
});
