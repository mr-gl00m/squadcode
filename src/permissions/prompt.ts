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
  | "always-project"
  | "always-user";

const PENDING_DIR = join(homedir(), ".squad", "pending");

export interface PromptRequest {
  toolName: string;
  callId: string;
  argsPreview: string;
  scopePattern: string;
  scopePatterns: string[];
  // Source-agent metadata, present when the request originates from a subagent
  // (the main loop leaves these undefined). Surfaced on the prompt and recorded
  // in the audit row so a grant is always attributable to the agent that asked
  // — which agent (id/type), under what model/provider, in what cwd, and
  // whether it's running armed (yolo).
  agentId?: string;
  agentType?: string;
  agentCwd?: string;
  agentProvider?: string;
  agentModel?: string;
  agentYolo?: boolean;
  guardianAdvice?: string;
}

export interface PromptOptions {
  allowProjectPersist?: boolean;
  allowUserPersist?: boolean;
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

// Renders the source-agent banner shown before the tool name on the prompt,
// e.g. " [KT-4 red-team · deepseek/deepseek-v4-pro · yolo]". Empty for
// main-loop requests, which carry no agent identity.
function formatSourceAgent(req: PromptRequest): string {
  if (req.agentId === undefined) return "";
  const parts: string[] = [req.agentId];
  if (req.agentType) parts.push(req.agentType);
  const stack =
    req.agentProvider && req.agentModel
      ? `${req.agentProvider}/${req.agentModel}`
      : (req.agentModel ?? req.agentProvider);
  const segs = [parts.join(" ")];
  if (stack) segs.push(stack);
  if (req.agentYolo) segs.push("yolo");
  return ` [${segs.join(" · ")}]`;
}

async function fallbackToPending(req: PromptRequest): Promise<"deny"> {
  const target = join(PENDING_DIR, `${req.callId}.json`);
  await atomicWriteJson(target, {
    callId: req.callId,
    tool: req.toolName,
    argsPreview: req.argsPreview,
    createdAt: new Date().toISOString(),
    ...(req.agentId !== undefined && {
      agentId: req.agentId,
      agentType: req.agentType,
      agentCwd: req.agentCwd,
      agentProvider: req.agentProvider,
      agentModel: req.agentModel,
      agentYolo: req.agentYolo,
    }),
    ...(req.guardianAdvice && { guardianAdvice: req.guardianAdvice }),
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
    const userChoice = opts.allowUserPersist
      ? " / [u]ser-wide (all projects)"
      : "";
    const source = formatSourceAgent(req);
    const guardian = req.guardianAdvice
      ? `\n[advisory] ${sanitizeForTerminal(req.guardianAdvice)}`
      : "";
    const answer = await rl.question(
      `\n[permission]${source} ${sanitizeForTerminal(req.toolName)} wants to run with args:\n${sanitizeForTerminal(req.argsPreview)}${guardian}\nallow? [y]es / [N]o / [a]lways for this session${projectChoice}${userChoice}: `,
    );
    const ch = answer.trim().toLowerCase();
    if (ch.startsWith("y")) return "allow";
    if (ch.startsWith("a")) return "always-allow";
    if (opts.allowProjectPersist && ch.startsWith("p")) return "always-project";
    if (opts.allowUserPersist && ch.startsWith("u")) return "always-user";
    return "deny";
  } finally {
    rl.close();
  }
}
