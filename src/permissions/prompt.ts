import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { atomicWriteJson } from "../fs-io.js";
import { logger } from "../logger.js";
import { sanitizeForTerminal } from "../terminal.js";

export type PromptOutcome =
  | "allow"
  | "deny"
  | "always-allow"
  | "always-project";

const PENDING_DIR = join(homedir(), ".squad", "pending");

export interface PromptRequest {
  toolName: string;
  callId: string;
  argsPreview: string;
}

export interface PromptOptions {
  allowProjectPersist?: boolean;
}

export async function promptForPermission(
  req: PromptRequest,
  opts: PromptOptions = {},
): Promise<PromptOutcome> {
  if (!process.stdin.isTTY) {
    return await fallbackToPending(req);
  }
  return await readChoice(req, opts);
}

async function fallbackToPending(req: PromptRequest): Promise<"deny"> {
  const target = join(PENDING_DIR, `${req.callId}.json`);
  await atomicWriteJson(target, {
    callId: req.callId,
    tool: req.toolName,
    argsPreview: req.argsPreview,
    createdAt: new Date().toISOString(),
  });
  process.stderr.write(
    `permission required for ${sanitizeForTerminal(req.toolName)} (call ${sanitizeForTerminal(req.callId)}); recorded at ${target}\n`,
  );
  logger.warn(
    { callId: req.callId, tool: req.toolName, target },
    "permission deferred (no TTY)",
  );
  return "deny";
}

async function readChoice(
  req: PromptRequest,
  opts: PromptOptions,
): Promise<PromptOutcome> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const projectChoice = opts.allowProjectPersist
      ? " / [p]ermanently for this project"
      : "";
    const answer = await rl.question(
      `\n[permission] ${sanitizeForTerminal(req.toolName)} wants to run with args:\n${sanitizeForTerminal(req.argsPreview)}\nallow? [y]es / [N]o / [a]lways for this session${projectChoice}: `,
    );
    const ch = answer.trim().toLowerCase();
    if (ch.startsWith("y")) return "allow";
    if (ch.startsWith("a")) return "always-allow";
    if (opts.allowProjectPersist && ch.startsWith("p")) return "always-project";
    return "deny";
  } finally {
    rl.close();
  }
}
