import type { FileSymbols } from "./types.js";

export interface FileGraph {
  // node index → file path
  files: string[];
  // outgoing weighted edges per node: refs from files[i] to files[j]
  edges: Array<Map<number, number>>;
  // symbols defined by each file, used for ranking later
  defsByFile: Map<string, FileSymbols>;
  // identifier → set of node indices defining it
  definers: Map<string, Set<number>>;
}

export function buildGraph(symbols: FileSymbols[]): FileGraph {
  const files: string[] = [];
  const indexByPath = new Map<string, number>();
  const defsByFile = new Map<string, FileSymbols>();
  const definers = new Map<string, Set<number>>();

  for (const fs of symbols) {
    const idx = files.length;
    files.push(fs.path);
    indexByPath.set(fs.path, idx);
    defsByFile.set(fs.path, fs);
    for (const d of fs.defs) {
      let set = definers.get(d.name);
      if (!set) {
        set = new Set();
        definers.set(d.name, set);
      }
      set.add(idx);
    }
  }

  const edges: Array<Map<number, number>> = files.map(() => new Map());
  for (let i = 0; i < symbols.length; i++) {
    const fs = symbols[i];
    if (!fs) continue;
    // Count refs by name within this file
    const refCounts = new Map<string, number>();
    for (const r of fs.refs) {
      refCounts.set(r.name, (refCounts.get(r.name) ?? 0) + 1);
    }
    for (const [name, count] of refCounts) {
      const dset = definers.get(name);
      if (!dset) continue;
      // Dampen weight by how many files define this name — common names
      // (e.g. `log`, `init`) shouldn't dominate the graph.
      const damp = 1 / Math.sqrt(dset.size);
      for (const j of dset) {
        if (j === i) continue;
        const w = count * damp;
        edges[i]!.set(j, (edges[i]!.get(j) ?? 0) + w);
      }
    }
  }

  return { files, edges, defsByFile, definers };
}
