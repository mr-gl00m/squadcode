import { join } from "node:path";
import { atomicWriteJson, fileExists, readJsonFile } from "../fs-io.js";
import { logger } from "../logger.js";

export interface ProjectSettings {
  version?: string;
  permissions?: {
    alwaysAllowed?: string[];
  };
  [key: string]: unknown;
}

const SETTINGS_VERSION = "0.1.0";

export function getProjectSettingsPath(cwd: string): string {
  return join(cwd, ".squad", "settings.json");
}

export async function loadProjectAllow(cwd: string): Promise<Set<string>> {
  const path = getProjectSettingsPath(cwd);
  if (!(await fileExists(path))) return new Set();
  try {
    const data = await readJsonFile<ProjectSettings>(path);
    const list = data.permissions?.alwaysAllowed;
    if (!Array.isArray(list)) return new Set();
    return new Set(list.filter((x): x is string => typeof x === "string"));
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), path },
      "failed to read project settings; treating as empty",
    );
    return new Set();
  }
}

export async function persistProjectAllow(
  cwd: string,
  toolName: string,
): Promise<void> {
  const path = getProjectSettingsPath(cwd);
  let existing: ProjectSettings = {};
  if (await fileExists(path)) {
    try {
      existing = await readJsonFile<ProjectSettings>(path);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), path },
        "project settings unreadable; will overwrite",
      );
    }
  }
  const allowed = new Set<string>(
    (existing.permissions?.alwaysAllowed ?? []).filter(
      (x): x is string => typeof x === "string",
    ),
  );
  if (allowed.has(toolName)) return;
  allowed.add(toolName);
  const next: ProjectSettings = {
    ...existing,
    version: existing.version ?? SETTINGS_VERSION,
    permissions: {
      ...(existing.permissions ?? {}),
      alwaysAllowed: [...allowed].sort(),
    },
  };
  await atomicWriteJson(path, next);
}
