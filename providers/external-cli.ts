import { spawn } from "node:child_process";
import { logger } from "../logger.js";
import { buildSanitizedChildEnv } from "../tools/shell-env.js";
import type {
  CanonicalEvent,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalUsage,
  LLMProvider,
  ProviderCallOptions,
} from "./types.js";

// Adapter that backs a subagent with a third-party agent CLI (codex, claude,
// aider, …) instead of a model API. It is config-driven on purpose — this repo
// holds no vendor-specific knowledge. The user supplies the command and how to
// parse its transcript; the adapter shells out with the task as the prompt and
// folds the CLI's final output into a single canonical text turn.
//
// It is a one-shot, not a token stream: the external CLI runs its OWN agent loop
// (its own tools, its own turns) and hands back a transcript. So the subagent
// loop sees exactly one assistant turn — the parsed transcript — and stops. No
// tool calls flow back through Squad; the external agent did its own tool use.
//
// Env is sanitized by default. Trusted CLIs that need credentials must name
// specific variables in passEnv / pass_env.
export interface ExternalCliParseConfig {
  // "raw": the whole stdout (trimmed). "json_path": JSON.parse(stdout) then walk
  // a dot path (e.g. "result.text") to the final string.
  mode: "raw" | "json_path";
  jsonPath?: string;
}

export interface ExternalCliConfig {
  providerId: string;
  // argv. The prompt is appended as the final arg (prompt_via "arg") or written
  // to stdin (prompt_via "stdin").
  command: string[];
  promptVia?: "arg" | "stdin";
  parse?: ExternalCliParseConfig;
  timeoutMs?: number;
  passEnv?: string[];
  // Working directory for the child — set to a fresh git worktree by spawn when
  // the subagent def requests isolation.
  cwd?: string;
}

const DEFAULT_TIMEOUT_MS = 600_000;

const ZERO_USAGE: CanonicalUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

function buildPrompt(req: CanonicalRequest): string {
  const parts: string[] = [];
  if (req.system) parts.push(req.system);
  for (const m of req.messages) {
    if (m.role === "user") parts.push(m.content);
  }
  return parts.join("\n\n");
}

function walkJsonPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const key of path.split(".")) {
    if (cur && typeof cur === "object" && key in (cur as object)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

function parseTranscript(
  stdout: string,
  parse?: ExternalCliParseConfig,
): string {
  if (!parse || parse.mode === "raw") return stdout.trim();
  try {
    const json = JSON.parse(stdout);
    const at = parse.jsonPath ? walkJsonPath(json, parse.jsonPath) : json;
    if (typeof at === "string") return at.trim();
    return JSON.stringify(at);
  } catch {
    // Malformed JSON — fall back to raw so the parent still gets *something*.
    return stdout.trim();
  }
}

interface CliRun {
  ok: boolean;
  text: string;
  exitCode: number | null;
  stderr: string;
}

function runCli(
  config: ExternalCliConfig,
  prompt: string,
  signal?: AbortSignal,
): Promise<CliRun> {
  const cmd = config.command[0];
  if (!cmd) {
    return Promise.resolve({
      ok: false,
      text: "external-cli command is empty",
      exitCode: null,
      stderr: "external-cli command is empty",
    });
  }
  const promptVia = config.promptVia ?? "arg";
  const args =
    promptVia === "arg"
      ? [...config.command.slice(1), prompt]
      : [...config.command.slice(1)];

  return new Promise<CliRun>((resolve) => {
    const child = spawn(cmd, args, {
      ...(config.cwd !== undefined && { cwd: config.cwd }),
      windowsHide: true,
      env: buildSanitizedChildEnv(process.env, {
        ...(config.passEnv !== undefined && { passEnv: config.passEnv }),
      }),
    });
    let stdout = "";
    let stderr = "";
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    timer.unref();
    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf-8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf-8");
    });
    child.on("error", (err: Error) => {
      cleanup();
      resolve({
        ok: false,
        text: `failed to run ${cmd}: ${err.message}`,
        exitCode: null,
        stderr: err.message,
      });
    });
    child.on("close", (code: number | null) => {
      cleanup();
      resolve({
        ok: code === 0,
        text: parseTranscript(stdout, config.parse),
        exitCode: code,
        stderr,
      });
    });

    if (promptVia === "stdin" && child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }
  });
}

export function createExternalCliProvider(
  config: ExternalCliConfig,
): LLMProvider {
  async function* stream(
    req: CanonicalRequest,
    opts?: ProviderCallOptions,
  ): AsyncIterable<CanonicalEvent> {
    const run = await runCli(config, buildPrompt(req), opts?.signal);
    if (!run.ok) {
      logger.warn(
        { providerId: config.providerId, exitCode: run.exitCode },
        "external CLI provider failed",
      );
      yield {
        type: "error",
        code: "EXTERNAL_CLI_FAILED",
        message:
          `${config.command.join(" ")} exited ${run.exitCode ?? "null"}` +
          (run.stderr ? `: ${run.stderr.slice(0, 500)}` : ""),
        retryable: false,
      };
      return;
    }
    yield { type: "text_delta", text: run.text };
    yield { type: "usage", usage: ZERO_USAGE };
    yield { type: "done", reason: "stop" };
  }

  async function complete(
    req: CanonicalRequest,
    opts?: ProviderCallOptions,
  ): Promise<CanonicalResponse> {
    const run = await runCli(config, buildPrompt(req), opts?.signal);
    return {
      text: run.text,
      toolCalls: [],
      finishReason: run.ok ? "stop" : "error",
      usage: ZERO_USAGE,
    };
  }

  return { name: config.providerId, stream, complete };
}
