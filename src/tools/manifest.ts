import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { logger } from "../logger.js";

export const MANIFEST_REL_PATH = ".crabmeat/index.json";

const ManifestEntrySchema = z.object({
  path: z.string().min(1),
  kind: z.string().min(1),
  summary: z.string(),
  signatures: z.array(z.string()).optional().default([]),
  tags: z.array(z.string()).optional().default([]),
  size_bytes: z.number().int().nonnegative().optional(),
  size_tokens_est: z.number().int().nonnegative().optional(),
  mtime: z.string().optional(),
  content_hash: z.string().optional(),
});

const ManifestSchema = z.object({
  manifest_version: z.literal(1),
  project: z.string(),
  generated_at: z.string(),
  generator: z.string(),
  entries: z.array(ManifestEntrySchema),
});

export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;
export type Manifest = z.infer<typeof ManifestSchema>;

export function loadManifest(cwd: string): Manifest | null {
  const full = join(cwd, MANIFEST_REL_PATH);
  if (!existsSync(full)) return null;
  let raw: string;
  try {
    raw = readFileSync(full, "utf-8");
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), path: full },
      "indexer manifest read failed",
    );
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), path: full },
      "indexer manifest JSON parse failed",
    );
    return null;
  }
  const parsed = ManifestSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn(
      { issues: parsed.error.issues, path: full },
      "indexer manifest schema validation failed",
    );
    return null;
  }
  return parsed.data;
}
