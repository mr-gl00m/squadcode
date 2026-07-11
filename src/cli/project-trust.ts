import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { SquadSettings } from "../settings.js";
import { updateProjectTrust } from "../settings.js";

export interface ProjectTrustOptions {
  interactive?: boolean;
  ask?: (question: string) => Promise<string>;
  persist?: (key: string, trusted: boolean) => Promise<void>;
}

export function projectDefaultMode(
  explicit: string | undefined,
  trusted: boolean,
  profileMode?: "plan" | "act",
): string {
  return explicit ?? (trusted ? (profileMode ?? "act") : "plan");
}

export async function ensureProjectTrust(
  cwd: string,
  settings: SquadSettings,
  opts: ProjectTrustOptions = {},
): Promise<boolean> {
  const key = await projectTrustKey(cwd);
  const existing = settings.projectTrust?.[key];
  if (existing) return existing.trusted;
  if (!(opts.interactive ?? (process.stdin.isTTY && process.stderr.isTTY))) {
    return false;
  }
  const answer = opts.ask
    ? await opts.ask(`Trust project ${key}? [y/N] `)
    : await askTerminal(`Trust project ${key}? [y/N] `);
  const trusted = /^(?:y|yes)$/i.test(answer.trim());
  await (opts.persist ?? updateProjectTrust)(key, trusted);
  return trusted;
}

export async function projectTrustKey(cwd: string): Promise<string> {
  const canonical = await realpath(cwd).catch(() => resolve(cwd));
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

async function askTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
