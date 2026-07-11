import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fitToBudget } from "../src/repomap/budget.js";
import type { Candidate } from "../src/repomap/render.js";
import { estimateTokens } from "../src/repomap/render.js";
import type { FileSymbols } from "../src/repomap/types.js";

async function makeFixture(): Promise<{
  cwd: string;
  candidates: Candidate[];
}> {
  const cwd = await mkdtemp(join(tmpdir(), "squad-budget-test-"));
  const candidates: Candidate[] = [];
  for (let i = 0; i < 10; i++) {
    const path = join(cwd, `file${i}.ts`);
    const lines = [
      `// file ${i}`,
      `export function fn${i}() {`,
      `  return ${i};`,
      `}`,
    ];
    await writeFile(path, lines.join("\n"), "utf-8");
    const file: FileSymbols = {
      path,
      lang: "typescript",
      mtimeMs: 0,
      size: 0,
      defs: [{ name: `fn${i}`, kind: "function", line: 1, endLine: 3 }],
      refs: [],
    };
    candidates.push({
      file,
      def: file.defs[0]!,
      score: 10 - i,
    });
  }
  return { cwd, candidates };
}

describe("fitToBudget", () => {
  it("returns empty for no candidates", async () => {
    const r = await fitToBudget([], 1000, "/tmp");
    expect(r.text).toBe("");
    expect(r.included).toBe(0);
    expect(r.estimatedTokens).toBe(0);
  });

  it("lands at or below the budget", async () => {
    const { cwd, candidates } = await makeFixture();
    const budgets = [50, 100, 200, 500, 1000];
    for (const budget of budgets) {
      const r = await fitToBudget(candidates, budget, cwd);
      // When budget is below the cheapest single-candidate render, we still
      // return that minimal render — but otherwise we should fit.
      const minRender = await fitToBudget(candidates.slice(0, 1), 999999, cwd);
      if (minRender.estimatedTokens <= budget) {
        expect(r.estimatedTokens).toBeLessThanOrEqual(budget);
      }
    }
  });

  it("never exceeds candidate count", async () => {
    const { cwd, candidates } = await makeFixture();
    const r = await fitToBudget(candidates, 999999, cwd);
    expect(r.included).toBeLessThanOrEqual(candidates.length);
  });

  it("includes more candidates as the budget grows", async () => {
    const { cwd, candidates } = await makeFixture();
    const small = await fitToBudget(candidates, 100, cwd);
    const big = await fitToBudget(candidates, 10000, cwd);
    expect(big.included).toBeGreaterThanOrEqual(small.included);
  });
});

describe("estimateTokens", () => {
  it("returns 0 for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("scales linearly with length", () => {
    const a = estimateTokens("x".repeat(40));
    const b = estimateTokens("x".repeat(80));
    expect(b).toBeGreaterThanOrEqual(a * 1.8);
  });
});
