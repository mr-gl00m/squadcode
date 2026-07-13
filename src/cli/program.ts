import { Command } from "commander";
import { logger } from "../logger.js";
import {
  listShootoutRuns,
  loadShootoutManifest,
} from "../sessions/shootout-store.js";
import { openSessionStore } from "../sessions/store.js";
import { runDoctor, verifyAuditChain } from "./doctor.js";
import { parseOnOff, type RootOptions } from "./program-options.js";
import { runPrintMode } from "./program-print.js";
import { runReplMode } from "./program-repl.js";
import {
  resolvePromptArg,
  runShootoutCli,
  splitModels,
} from "./program-shootout.js";
import { runRecapCli } from "./recap-cli.js";
import { type ReviewOptions, runReviewCli } from "./review.js";
import { runSessionsCli } from "./sessions.js";
import { formatShootoutReport } from "./shootout-report.js";
import { runUsageCli } from "./usage-cli.js";

export { permissionModeConflict } from "./runtime-resolution.js";
export { defaultSystemPrompt } from "./system-prompt.js";

const VERSION = "1.9.0";
const DESCRIPTION =
  "Provider-neutral local-first CLI agent: streaming, tool use, sessions, permissions across DeepSeek, OpenAI, and Anthropic.";

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("squad")
    .description(DESCRIPTION)
    .version(VERSION, "-v, --version", "print squad-code version")
    .option(
      "-p, --print <prompt>",
      "one-shot mode: send prompt and stream response",
    )
    .option("--model <name>", "override the default model for this run")
    .option("--provider <name>", "override the default provider for this run")
    .option("--profile <name>", "use a named local/cloud/review profile")
    .option("--simple", "use plain readline REPL instead of Ink")
    .option(
      "--resume [id]",
      "resume a session (most recent for cwd if id omitted)",
    )
    .option("--continue", "alias for --resume with no id")
    .option(
      "--allowed-tools <list>",
      "comma-separated tool allowlist for this session",
    )
    .option(
      "--disallowed-tools <list>",
      "comma-separated tool denylist for this session",
    )
    .option(
      "--dangerously-skip-permissions",
      "bypass the permission prompt for this invocation",
    )
    .option(
      "--dangerously-skip-read-permissions",
      "auto-allow file reads under the project dir without prompting (bypasses sensitive-file rules like .env for in-project paths); writes and shell stay gated. Reads outside cwd keep their normal protection",
    )
    .option(
      "--dangerously-allow-deletes",
      "disable the always-on delete guard for this run. By default rm/Remove-Item/del are rewritten to move the target into .deleted/ and unrewritable deletes (pipelines, .NET, git clean) are blocked; this flag lets deletes destroy for real",
    )
    .option(
      "--yolo",
      "YOLO mode: skip prompts and enable cwd path-guard + archive-on-delete + checklist rails (not OS isolation; REPL only; checklist.txt or CHECKLIST.md must exist in cwd)",
    )
    .option(
      "--notification-sound <state>",
      "permission-request sound for this invocation: on or off",
      parseOnOff,
    )
    .option(
      "--mode <name>",
      "permission mode: 'act' (default — full toolset) or 'plan' (read/grep/glob allowed, edit/write denied, shell asks)",
    )
    .option(
      "--output-format <fmt>",
      "print-mode output: 'text' (default, human-readable) or 'stream-json' (newline-delimited typed events on stdout)",
    )
    .option(
      "--output-schema <file>",
      "print mode: require the final assistant message to match a JSON Schema",
    )
    .option(
      "--output-last-message <file>",
      "print mode: atomically write the final assistant message to a file",
    )
    .option(
      "--replay [id]",
      "on launch, replay the last N turns of a session (the resumed/current one if no id given)",
    )
    .option(
      "--replay-limit <n>",
      "number of turns to show with --replay (default 5)",
      (value) => parseInt(value, 10),
    )
    .option(
      "--shootout <models>",
      "with -p: run the prompt across these comma-separated models concurrently and compare trajectories (same as the 'shootout' subcommand)",
    )
    .action(async (opts: RootOptions) => {
      logger.info({ opts }, "squadcode invoked");
      if (
        opts.print === undefined &&
        (opts.outputSchema !== undefined ||
          opts.outputLastMessage !== undefined)
      ) {
        process.stderr.write(
          "--output-schema and --output-last-message require --print\n",
        );
        process.exitCode = 2;
        return;
      }
      if (opts.shootout !== undefined && opts.print !== undefined) {
        await runShootoutCli({
          prompt: opts.print,
          models: splitModels(opts.shootout),
        });
        return;
      }
      if (opts.print !== undefined) {
        await runPrintMode(opts);
        return;
      }
      await runReplMode(opts);
    });

  const shootoutCmd = program
    .command("shootout [prompt]")
    .description(
      "run the same prompt across multiple model backends concurrently and compare trajectories",
    )
    .option("--models <list>", "comma-separated model ids (required)")
    .option("--max-turns <n>", "max turns per slot", (value) =>
      parseInt(value, 10),
    )
    .action(
      async (
        prompt: string | undefined,
        opts: { models?: string; maxTurns?: number },
      ) => {
        if (prompt === undefined) {
          process.stderr.write(
            "usage: squad shootout <prompt> --models a,b,c  (or 'squad shootout report <run-id>')\n",
          );
          process.exitCode = 2;
          return;
        }
        const models = splitModels(opts.models ?? "");
        if (models.length === 0) {
          process.stderr.write("--models <a,b,c> is required\n");
          process.exitCode = 2;
          return;
        }
        await runShootoutCli({
          prompt: resolvePromptArg(prompt),
          models,
          ...(opts.maxTurns !== undefined && { maxTurns: opts.maxTurns }),
        });
      },
    );

  shootoutCmd
    .command("report <runId>")
    .description("re-render a saved shootout run")
    .action(async (runId: string) => {
      const found = await loadShootoutManifest(runId);
      if (!found) {
        const runs = await listShootoutRuns();
        process.stderr.write(
          `no shootout run "${runId}". Known: ${runs.join(", ") || "(none)"}\n`,
        );
        process.exitCode = 2;
        return;
      }
      process.stdout.write(`${formatShootoutReport(found)}\n`);
    });

  const sessionsCmd = program
    .command("sessions")
    .description("manage stored conversation sessions");

  program
    .command("review")
    .description("review a Git change set with the configured reviewer model")
    .option("--uncommitted", "review staged, unstaged, and untracked changes")
    .option("--base <branch>", "review changes from merge-base(branch, HEAD)")
    .option("--commit <sha>", "review one commit")
    .action(async (opts: ReviewOptions) => {
      if (!(await runReviewCli(opts))) process.exitCode = 1;
    });

  program
    .command("doctor")
    .description(
      "check install, configuration provenance, auth, and runtime health",
    )
    .option("--json", "emit machine-readable JSON")
    .option("--explain <key>", "show why one effective configuration key won")
    .action(async (opts: { json?: boolean; explain?: string }) => {
      const ok = await runDoctor({
        cwd: process.cwd(),
        ...(opts.json !== undefined && { json: opts.json }),
        ...(opts.explain !== undefined && { explain: opts.explain }),
      });
      if (!ok) process.exitCode = 1;
    });

  const auditCmd = program
    .command("audit")
    .description("inspect the audit continuity log");

  auditCmd
    .command("verify")
    .description("verify prev_hash continuity in ~/.squad/audit.db")
    .action(async () => {
      const store = openSessionStore();
      try {
        const ok = await verifyAuditChain({ store });
        if (!ok) process.exitCode = 1;
      } finally {
        await store.shutdown();
      }
    });

  sessionsCmd
    .command("list")
    .description("list recent sessions")
    .option(
      "--cwd <path>",
      "filter by working directory (default: current cwd)",
    )
    .option("--all-cwds", "do not filter by cwd")
    .option(
      "--limit <n>",
      "max sessions to show",
      (value) => parseInt(value, 10),
      20,
    )
    .option("--archived", "include archived sessions")
    .action(
      async (opts: {
        cwd?: string;
        allCwds?: boolean;
        limit?: number;
        archived?: boolean;
      }) => {
        await runSessionsCli({ kind: "list", ...opts });
      },
    );

  sessionsCmd
    .command("show <id>")
    .description("print a session's transcript")
    .action(async (id: string) => {
      await runSessionsCli({ kind: "show", id });
    });

  program
    .command("receipt <id>")
    .description(
      "print a markdown recap of a session — goal, files touched, shell commands, tokens, next action",
    )
    .action(async (id: string) => {
      await runRecapCli(id);
    });

  program
    .command("usage")
    .description("show token usage and cost across sessions (auditable ledger)")
    .option(
      "--cwd <path>",
      "filter by working directory (default: current cwd)",
    )
    .option("--all-cwds", "do not filter by cwd")
    .option("--session <id>", "filter to a single session id")
    .option("--days <n>", "limit to the last N days", (value) =>
      parseInt(value, 10),
    )
    .option("--provider <name>", "filter to a single provider")
    .option("--model <name>", "filter to a single model")
    .action(
      async (opts: {
        cwd?: string;
        allCwds?: boolean;
        session?: string;
        days?: number;
        provider?: string;
        model?: string;
      }) => {
        const input: Parameters<typeof runUsageCli>[0] = {};
        if (opts.cwd !== undefined) input.cwd = opts.cwd;
        if (opts.allCwds === true) input.allCwds = true;
        if (opts.session !== undefined) input.sessionId = opts.session;
        if (opts.days !== undefined) input.daysBack = opts.days;
        if (opts.provider !== undefined) input.provider = opts.provider;
        if (opts.model !== undefined) input.model = opts.model;
        await runUsageCli(input);
      },
    );

  return program;
}
