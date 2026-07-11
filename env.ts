import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { z } from "zod";

const emptyToUndefined = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z.string().optional(),
);

const emptyToUndefinedUrl = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z.string().url().optional(),
);

const boolFromString = z.union([z.boolean(), z.string()]).transform((v) => {
  if (typeof v === "boolean") return v;
  return v === "1" || v.toLowerCase() === "true";
});

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  AI_DEFAULT_PROVIDER: z.string().default("deepseek"),
  AI_DEFAULT_MODEL: emptyToUndefined,

  ANTHROPIC_API_KEY: emptyToUndefined,
  ANTHROPIC_BASE_URL: emptyToUndefinedUrl,
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6"),

  OPENAI_API_KEY: emptyToUndefined,
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_MODEL: z.string().default("gpt-5.1"),

  DEEPSEEK_API_KEY: emptyToUndefined,
  DEEPSEEK_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  DEEPSEEK_MODEL: z.string().default("deepseek-v4-flash"),

  OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().default("llama3.2"),
  OLLAMA_ALLOW_REMOTE: boolFromString.default(false),

  CLI_SESSION_DIR: emptyToUndefined,
  CLI_PERMISSION_MODE: z.enum(["ask", "allow", "deny"]).default("ask"),
  CLI_MAX_TOOL_CONCURRENCY: z.coerce.number().int().positive().default(4),

  SQUAD_PROJECT_PERMS: boolFromString.default(true),

  // Post-edit diagnostics: syntax-check files touched by Edit/Write/ApplyPatch
  // at the next turn boundary and inject findings. Set to 0 to disable.
  SQUAD_POST_EDIT_DIAGNOSTICS: boolFromString.default(true),

  // Comma-separated list of skill directories to scan for user-level skills.
  // Defaults to `~/.squad/skills` only. Set to a list like
  // `~/.squad/skills,~/some/other/skills` to import skills from existing
  // locations (e.g. another tool's skill library you already maintain).
  SQUAD_USER_SKILL_DIRS: emptyToUndefined,
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function applyEnvFiles(
  paths: string[],
  target: NodeJS.ProcessEnv = process.env,
): void {
  const fileValues: Record<string, string> = {};
  const seen = new Set<string>();

  for (const path of paths) {
    const resolved = resolve(path);
    if (seen.has(resolved) || !existsSync(resolved)) continue;
    seen.add(resolved);
    Object.assign(fileValues, parseDotenv(readFileSync(resolved, "utf-8")));
  }

  for (const [key, value] of Object.entries(fileValues)) {
    if (target[key] === undefined) {
      target[key] = value;
    }
  }
}

function loadEnvFiles(): void {
  applyEnvFiles([
    join(homedir(), ".squad", ".env"),
    join(process.cwd(), ".env"),
  ]);
}

export function loadEnv(): Env {
  if (cached) return cached;
  loadEnvFiles();
  cached = envSchema.parse(process.env);
  return cached;
}
