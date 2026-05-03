import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson, fileExists, readJsonFile } from "./fs-io.js";

export const STATE_DIR = join(homedir(), ".squad");
export const SETTINGS_PATH = join(STATE_DIR, "settings.json");

export interface SquadSettings {
  version: string;
  createdAt: string;
  updatedAt?: string;
  defaultProvider?: string;
  defaultModel?: string;
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

export async function readDefaultSelection(): Promise<{
  provider?: string;
  model?: string;
}> {
  const settings = await readSettings();
  return {
    ...(settings.defaultProvider ? { provider: settings.defaultProvider } : {}),
    ...(settings.defaultModel ? { model: settings.defaultModel } : {}),
  };
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
