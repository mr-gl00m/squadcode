import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson, atomicWriteText } from "../fs-io.js";
import type { CanonicalEvent } from "../providers/types.js";
import type { TrajectoryDiff, TrajectorySummary } from "./trajectory-diff.js";

// Persists a shootout run under <base>/shootouts/<run-id>/ — a manifest.json
// plus one <label>.jsonl transcript per slot. baseDir is injectable so tests
// don't write to the user's real ~/.squad.
export interface ShootoutManifest {
  runId: string;
  prompt: string;
  createdAt: string;
  cwd: string;
  models: string[];
  worktrees: Record<string, string>;
  summaries: TrajectorySummary[];
  diffs: TrajectoryDiff[];
}

function defaultBase(): string {
  const env = process.env["CLI_SESSION_DIR"];
  return env && env.length > 0 ? env : join(homedir(), ".squad");
}

export function shootoutsRoot(baseDir?: string): string {
  return join(baseDir ?? defaultBase(), "shootouts");
}

export function shootoutDir(runId: string, baseDir?: string): string {
  return join(shootoutsRoot(baseDir), runId);
}

function safeLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9._-]/g, "_");
}

export async function saveShootoutRun(
  manifest: ShootoutManifest,
  perSlotEvents: Map<string, CanonicalEvent[]>,
  baseDir?: string,
): Promise<string> {
  const dir = shootoutDir(manifest.runId, baseDir);
  // atomicWriteText/Json mkdir their parent, so writing the manifest creates dir.
  await atomicWriteJson(join(dir, "manifest.json"), manifest);
  for (const [label, events] of perSlotEvents) {
    const jsonl = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
    await atomicWriteText(join(dir, `${safeLabel(label)}.jsonl`), jsonl);
  }
  return dir;
}

export async function loadShootoutManifest(
  runId: string,
  baseDir?: string,
): Promise<ShootoutManifest | null> {
  try {
    const raw = await readFile(
      join(shootoutDir(runId, baseDir), "manifest.json"),
      "utf-8",
    );
    return JSON.parse(raw) as ShootoutManifest;
  } catch {
    return null;
  }
}

export async function listShootoutRuns(baseDir?: string): Promise<string[]> {
  const items = await readdir(shootoutsRoot(baseDir), {
    withFileTypes: true,
  }).catch(() => []);
  return items
    .filter((i) => i.isDirectory())
    .map((i) => i.name)
    .sort();
}
