import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRepoMap } from "../src/repomap/index.js";

// Four tiny files, each with one exported symbol, so every file is
// parse-eligible and shows up in fileMentions once cached.
async function fixtureRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "squad-parse-cap-"));
  for (const n of ["a", "b", "c", "d"]) {
    await writeFile(
      join(dir, `${n}.ts`),
      `export function ${n}fn(): number { return 1; }\n`,
    );
  }
  return dir;
}

describe("repomap parse cap", () => {
  it("caps uncached parses per build and warms progressively", async () => {
    const cwd = await fixtureRepo();
    const cacheDir = await mkdtemp(join(tmpdir(), "squad-parse-cap-cache-"));

    const first = await buildRepoMap({
      cwd,
      tokenBudget: 512,
      cacheDir,
      parseCap: 2,
    });
    expect(first.parsesSkipped).toBe(2);
    expect(first.fileMentions).toHaveLength(2);

    // Second build: the two cached files hit, the two skipped ones are the
    // only misses, and they fit under the cap.
    const second = await buildRepoMap({
      cwd,
      tokenBudget: 512,
      cacheDir,
      parseCap: 2,
    });
    expect(second.parsesSkipped).toBe(0);
    expect(second.fileMentions).toHaveLength(4);

    const third = await buildRepoMap({
      cwd,
      tokenBudget: 512,
      cacheDir,
      parseCap: 2,
    });
    expect(third.parsesSkipped).toBe(0);
    expect(third.fileMentions).toHaveLength(4);
  });

  it("skips nothing when the repo fits under the default cap", async () => {
    const cwd = await fixtureRepo();
    const cacheDir = await mkdtemp(join(tmpdir(), "squad-parse-cap-cache2-"));
    const result = await buildRepoMap({ cwd, tokenBudget: 512, cacheDir });
    expect(result.parsesSkipped).toBe(0);
    expect(result.fileMentions).toHaveLength(4);
  });
});
