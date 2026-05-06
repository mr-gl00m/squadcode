import { loadEnv } from "./env.js";
import { logger } from "./logger.js";
import { buildProgram } from "./cli/program.js";
import { SETTINGS_PATH, ensureSettingsFile } from "./settings.js";

async function ensureStateDir(options: { logInitialization: boolean }): Promise<void> {
  const created = await ensureSettingsFile();
  if (created && options.logInitialization) {
    logger.info({ path: SETTINGS_PATH }, "initialized squad state directory");
  }
}

function isInformationalCommand(argv: string[]): boolean {
  return argv.slice(2).some((arg) => {
    return arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v";
  });
}

export async function start(argv: string[]): Promise<void> {
  const quiet = isInformationalCommand(argv);
  const env = quiet ? undefined : loadEnv();
  await ensureStateDir({ logInitialization: !quiet });
  if (!quiet) {
    logger.info(
      { nodeEnv: env?.NODE_ENV, provider: env?.AI_DEFAULT_PROVIDER },
      "squad-code starting",
    );
  }
  const program = buildProgram();
  await program.parseAsync(argv);
}
