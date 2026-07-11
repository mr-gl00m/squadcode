import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson, fileExists, readJsonFile } from "./fs-io.js";

const STATE_DIR = join(homedir(), ".squad");
export const SETTINGS_PATH = join(STATE_DIR, "settings.json");

export interface SquadSettings {
  version: string;
  createdAt: string;
  updatedAt?: string;
  defaultProvider?: string;
  defaultModel?: string;
  review_model?: string;
  guardian?: {
    enabled?: boolean;
    model?: string;
  };
  default_profile?: string;
  profiles?: Record<string, SquadProfile>;
  projectTrust?: Record<string, ProjectTrustRecord>;
  recap?: {
    // Minutes of idle time before the REPL auto-emits a recap. 0 disables.
    // Default 5 if unset.
    idleMinutes?: number;
  };
  notifications?: {
    // Executable path. Receives one JSON TurnCompletionPayload on stdin.
    program?: string;
    terminalMode?: "off" | "unfocused" | "always";
    terminalMethod?: "osc9" | "bell";
  };
  hooks?: unknown[];
  [key: string]: unknown;
}

export interface SquadProfile {
  provider?: string;
  model?: string;
  mode?: "plan" | "act";
}

export interface ProjectTrustRecord {
  trusted: boolean;
  updatedAt: string;
}

function createSettings(): SquadSettings {
  return {
    version: "0.1.0",
    createdAt: new Date().toISOString(),
  };
}

export async function ensureSettingsFile(): Promise<boolean> {
  if (await fileExists(SETTINGS_PATH)) return false;
  await atomicWriteJson(SETTINGS_PATH, createSettings());
  return true;
}

export async function readSettings(): Promise<SquadSettings> {
  if (!(await fileExists(SETTINGS_PATH))) {
    return createSettings();
  }
  return await readJsonFile<SquadSettings>(SETTINGS_PATH);
}

export async function updateDefaultSelection(
  provider: string,
  model: string,
): Promise<void> {
  const settings = await readSettings();
  await atomicWriteJson(SETTINGS_PATH, {
    ...settings,
    defaultProvider: provider,
    defaultModel: model,
    updatedAt: new Date().toISOString(),
  });
}

export async function updateProjectTrust(
  key: string,
  trusted: boolean,
): Promise<void> {
  const settings = await readSettings();
  await atomicWriteJson(SETTINGS_PATH, {
    ...settings,
    projectTrust: {
      ...(settings.projectTrust ?? {}),
      [key]: { trusted, updatedAt: new Date().toISOString() },
    },
    updatedAt: new Date().toISOString(),
  });
}

export const DEFAULT_RECAP_IDLE_MINUTES = 5;
