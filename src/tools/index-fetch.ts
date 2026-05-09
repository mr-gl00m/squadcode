import { promises as fs } from "node:fs";
import { z } from "zod";
import type { Manifest } from "./manifest.js";
import { resolveAndValidate } from "./path.js";
import { defineTool } from "./types.js";

const INDEX_FETCH_INPUT = z.object({
  path: z.string().min(1),
});

const HARD_BYTE_CAP = 1_000_000;

export function createIndexFetchTool(manifest: Manifest | null) {
  return defineTool({
    name: "IndexFetch",
    description:
      "Fetch the contents of a file by exact path from the project manifest at .crabmeat/index.json. Use AFTER IndexList — pass a path that came back from IndexList. Returns the full file body. Path must be an exact match for an entry in the manifest; for arbitrary paths, use Read instead.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
    inputZod: INDEX_FETCH_INPUT,
    defaultPermission: "auto-allow",
    isReadOnly: true,
    execute: async (input, ctx) => {
      if (!manifest) {
        return {
          ok: false,
          error: "INDEXER_ABSENT",
          content:
            "no manifest at .crabmeat/index.json — use Read for arbitrary paths",
        };
      }
      const entry = manifest.entries.find((e) => e.path === input.path);
      if (!entry) {
        return {
          ok: false,
          error: "PATH_NOT_IN_MANIFEST",
          content:
            `"${input.path}" is not an entry in the manifest. ` +
            `Call IndexList first to see available paths, or use Read for arbitrary paths.`,
        };
      }
      const target = await resolveAndValidate(entry.path, {
        root: ctx.cwd,
        mustExist: true,
      });
      const raw = await fs.readFile(target, "utf-8");
      const bytes = Buffer.byteLength(raw, "utf-8");
      if (bytes > HARD_BYTE_CAP) {
        const buf = Buffer.from(raw, "utf-8").subarray(0, HARD_BYTE_CAP);
        const body = buf.toString("utf-8");
        return {
          ok: true,
          content:
            `${body}\n(file exceeded ${HARD_BYTE_CAP} bytes; tail elided — use Read with offset/limit for the full file)`,
        };
      }
      return { ok: true, content: raw };
    },
    summarize: (input, result) => {
      if (!result.ok) return `IndexFetch ${input.path} (failed)`;
      const lines = result.content.split("\n").length;
      return `IndexFetch ${input.path} (${lines} lines)`;
    },
  });
}
