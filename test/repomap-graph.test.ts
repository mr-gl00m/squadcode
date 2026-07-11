import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/repomap/graph.js";
import { pagerank, personalizationFor } from "../src/repomap/pagerank.js";
import type { FileSymbols } from "../src/repomap/types.js";

function fs(
  path: string,
  defs: Array<{ name: string; kind?: string }>,
  refs: string[],
): FileSymbols {
  return {
    path,
    lang: "typescript",
    mtimeMs: 0,
    size: 0,
    defs: defs.map((d, i) => ({
      name: d.name,
      kind: d.kind ?? "function",
      line: i,
      endLine: i,
    })),
    refs: refs.map((name, i) => ({ name, line: i })),
  };
}

describe("buildGraph", () => {
  it("creates an edge from referencing file to defining file", () => {
    const a = fs("a.ts", [{ name: "foo" }], []);
    const b = fs("b.ts", [], ["foo"]);
    const g = buildGraph([a, b]);
    expect(g.files).toEqual(["a.ts", "b.ts"]);
    // b → a (b references foo, defined in a)
    expect(g.edges[1]!.get(0)).toBeGreaterThan(0);
    expect(g.edges[0]!.size).toBe(0);
  });

  it("indexes definers by symbol name", () => {
    const a = fs("a.ts", [{ name: "foo" }, { name: "bar" }], []);
    const b = fs("b.ts", [{ name: "foo" }], []);
    const g = buildGraph([a, b]);
    expect(g.definers.get("foo")?.size).toBe(2);
    expect(g.definers.get("bar")?.size).toBe(1);
  });

  it("dampens weight when many files define the same name", () => {
    const a = fs("a.ts", [{ name: "log" }], []);
    const b = fs("b.ts", [{ name: "log" }], []);
    const c = fs("c.ts", [], ["log"]);
    const g = buildGraph([a, b, c]);
    const wA = g.edges[2]!.get(0)!;
    expect(wA).toBeLessThan(1);
  });

  it("ignores self-references", () => {
    const a = fs("a.ts", [{ name: "foo" }], ["foo"]);
    const g = buildGraph([a]);
    expect(g.edges[0]!.size).toBe(0);
  });
});

describe("pagerank", () => {
  it("returns an empty array for an empty graph", () => {
    const g = buildGraph([]);
    expect(pagerank(g)).toEqual([]);
  });

  it("is deterministic for the same input", () => {
    const a = fs("a.ts", [{ name: "foo" }], []);
    const b = fs("b.ts", [], ["foo"]);
    const c = fs("c.ts", [], ["foo"]);
    const g = buildGraph([a, b, c]);
    const s1 = pagerank(g);
    const s2 = pagerank(g);
    expect(s1).toEqual(s2);
  });

  it("ranks the heavily-referenced file higher than its referencers", () => {
    const a = fs("a.ts", [{ name: "foo" }], []);
    const b = fs("b.ts", [], ["foo"]);
    const c = fs("c.ts", [], ["foo"]);
    const d = fs("d.ts", [], ["foo"]);
    const g = buildGraph([a, b, c, d]);
    const scores = pagerank(g);
    expect(scores[0]).toBeGreaterThan(scores[1]!);
    expect(scores[0]).toBeGreaterThan(scores[2]!);
    expect(scores[0]).toBeGreaterThan(scores[3]!);
  });

  it("scores sum to ~1 (probability distribution)", () => {
    const a = fs("a.ts", [{ name: "foo" }], []);
    const b = fs("b.ts", [], ["foo"]);
    const g = buildGraph([a, b]);
    const total = pagerank(g).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 5);
  });
});

describe("personalizationFor", () => {
  it("boosts files listed in chatFiles", () => {
    const a = fs("a.ts", [{ name: "foo" }], []);
    const b = fs("b.ts", [], ["foo"]);
    const g = buildGraph([a, b]);
    const p = personalizationFor(g, ["a.ts"], [], "/");
    expect(p[0]).toBeGreaterThan(p[1]!);
  });

  it("boosts files defining mentioned identifiers", () => {
    const a = fs("a.ts", [{ name: "magicSymbol" }], []);
    const b = fs("b.ts", [{ name: "other" }], []);
    const g = buildGraph([a, b]);
    const p = personalizationFor(g, [], ["magicSymbol"], "/");
    expect(p[0]).toBeGreaterThan(p[1]!);
  });
});
