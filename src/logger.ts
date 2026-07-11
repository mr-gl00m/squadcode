import { homedir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { loadEnv } from "./env.js";
import { redactSecretsInValue } from "./redact.js";

const STATE_DIR = join(homedir(), ".squad");
const LOG_DIR = join(STATE_DIR, "logs");
const LOG_FILE = join(LOG_DIR, "squad.log");

const REDACT_PATHS = [
  "apiKey",
  "*.apiKey",
  "api_key",
  "*.api_key",
  "ANTHROPIC_API_KEY",
  "*.ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "*.OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "*.DEEPSEEK_API_KEY",
  "headers.authorization",
  "headers.Authorization",
  'headers["x-api-key"]',
];

function createLogger(): pino.Logger {
  const env = (() => {
    try {
      return loadEnv();
    } catch {
      return {
        NODE_ENV: "development" as const,
        LOG_LEVEL: "info" as const,
      };
    }
  })();
  const redact = { paths: REDACT_PATHS, remove: false };
  const hooks: pino.LoggerOptions["hooks"] = {
    logMethod(args, method) {
      method.apply(
        this,
        args.map(redactSecretsInValue) as [
          obj: unknown,
          msg?: string,
          ...args: unknown[],
        ],
      );
    },
  };

  if (env.NODE_ENV === "test") {
    return pino({ name: "squad", level: "silent", redact, hooks });
  }

  return pino({
    name: "squad",
    level: env.LOG_LEVEL,
    redact,
    hooks,
    transport: {
      target: "pino-roll",
      options: {
        file: LOG_FILE,
        frequency: "daily",
        mkdir: true,
      },
    },
  });
}

export const logger = createLogger();

export async function flushLogger(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    logger.flush((err?: Error) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  }).catch(() => undefined);
}
