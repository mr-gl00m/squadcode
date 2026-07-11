import type { FileGraph } from "./graph.js";

interface PagerankOptions {
  damping?: number;
  iterations?: number;
  tolerance?: number;
  personalization?: number[];
}

export function pagerank(
  graph: FileGraph,
  opts: PagerankOptions = {},
): number[] {
  const n = graph.files.length;
  if (n === 0) return [];

  const damping = opts.damping ?? 0.85;
  const iterations = opts.iterations ?? 100;
  const tolerance = opts.tolerance ?? 1e-6;

  let personalization = opts.personalization;
  if (!personalization || personalization.length !== n) {
    personalization = new Array(n).fill(1 / n);
  } else {
    const total = personalization.reduce((a, b) => a + b, 0);
    if (total > 0) {
      personalization = personalization.map((v) => v / total);
    } else {
      personalization = new Array(n).fill(1 / n);
    }
  }

  // Precompute outbound weight sums for normalization. Dangling nodes
  // (no outbound edges) redistribute their score across all nodes per
  // personalization.
  const outSums = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (const w of graph.edges[i]!.values()) {
      outSums[i] += w;
    }
  }

  let scores = new Array(n).fill(1 / n);
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Array(n).fill(0);
    let danglingMass = 0;
    for (let i = 0; i < n; i++) {
      if (outSums[i] === 0) {
        danglingMass += scores[i];
      } else {
        for (const [j, w] of graph.edges[i]!) {
          next[j] += (scores[i] * w) / outSums[i];
        }
      }
    }

    let delta = 0;
    for (let i = 0; i < n; i++) {
      next[i] =
        (1 - damping) * personalization[i]! +
        damping * (next[i] + danglingMass * personalization[i]!);
      delta += Math.abs(next[i] - scores[i]);
    }
    scores = next;
    if (delta < tolerance) break;
  }

  return scores;
}

export function personalizationFor(
  graph: FileGraph,
  chatFiles: string[] = [],
  mentionedIdentifiers: string[] = [],
  cwd: string,
): number[] {
  const n = graph.files.length;
  const personalization = new Array(n).fill(1);
  const chatSet = new Set(chatFiles.map((f) => normalizePath(f, cwd)));
  for (let i = 0; i < n; i++) {
    if (chatSet.has(normalizePath(graph.files[i]!, cwd))) {
      personalization[i] += 10;
    }
  }
  for (const name of mentionedIdentifiers) {
    const definers = graph.definers.get(name);
    if (!definers) continue;
    for (const idx of definers) {
      personalization[idx] += 5;
    }
  }
  return personalization;
}

function normalizePath(p: string, cwd: string): string {
  const norm = p.replace(/\\/g, "/");
  const cwdNorm = cwd.replace(/\\/g, "/");
  if (norm.startsWith(cwdNorm + "/")) {
    return norm.slice(cwdNorm.length + 1);
  }
  return norm;
}
