import { z } from "zod";
import type { Manifest, ManifestEntry } from "./manifest.js";
import { matchesGlob } from "./scan.js";
import { defineTool } from "./types.js";

const INDEX_LIST_INPUT = z.object({
  tags: z.array(z.string()).optional(),
  kind: z.string().optional(),
  path: z.string().optional(),
});

function filterEntries(
  entries: ManifestEntry[],
  input: {
    tags?: string[] | undefined;
    kind?: string | undefined;
    path?: string | undefined;
  },
): ManifestEntry[] {
  return entries.filter((e) => {
    if (input.kind && e.kind !== input.kind) return false;
    if (input.tags && input.tags.length > 0) {
      const have = new Set(e.tags);
      for (const t of input.tags) if (!have.has(t)) return false;
    }
    if (input.path && !matchesGlob(e.path, input.path)) return false;
    return true;
  });
}

export function createIndexListTool(manifest: Manifest | null) {
  return defineTool({
    name: "IndexList",
    description:
      "List entries from the project's deterministic file manifest at .crabmeat/index.json. Returns paths, summaries, signatures, tags, and sizes — no file contents. Use this BEFORE Grep/Glob/Read to find the right file by metadata, then call IndexFetch for the contents. Supports optional filters: tags (all must match), kind (exact match), path (glob).",
    inputSchema: {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        kind: { type: "string" },
        path: { type: "string" },
      },
      required: [],
    },
    inputZod: INDEX_LIST_INPUT,
    defaultPermission: "auto-allow",
    isReadOnly: true,
    execute: async (input) => {
      if (!manifest) {
        return {
          ok: true,
          content: JSON.stringify(
            {
              indexer_present: false,
              reason:
                "no manifest at .crabmeat/index.json — fall through to Glob/Grep/Read",
            },
            null,
            2,
          ),
        };
      }
      const entries = filterEntries(manifest.entries, input);
      const body = {
        indexer_present: true,
        project: manifest.project,
        generated_at: manifest.generated_at,
        total: manifest.entries.length,
        returned: entries.length,
        entries,
      };
      return { ok: true, content: JSON.stringify(body, null, 2) };
    },
    summarize: (input, result) => {
      if (!result.ok) return "IndexList (failed)";
      const filters: string[] = [];
      if (input.kind) filters.push(`kind=${input.kind}`);
      if (input.tags && input.tags.length > 0) {
        filters.push(`tags=[${input.tags.join(",")}]`);
      }
      if (input.path) filters.push(`path=${input.path}`);
      const suffix = filters.length > 0 ? ` (${filters.join(", ")})` : "";
      return `IndexList${suffix}`;
    },
  });
}
