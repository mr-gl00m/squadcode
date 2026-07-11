import {
  type ContextFragment,
  createContextFragment,
} from "../context/fragment.js";
import { loadProjectInstructions } from "../instructions.js";
import type { JobRegistry } from "./job-registry.js";
import {
  buildDiagnosticsFragment,
  type DiagnosticsCommandConfig,
  type DiagnosticsTracker,
} from "./post-edit-diagnostics.js";
import type { TimerRegistry } from "./timer-registry.js";

// Builds the loop's injectPreTurn callback from a timer + job registry and an
// optional post-edit diagnostics tracker. At each turn boundary it drains
// expired timers, newly-finished BACKGROUND SHELL jobs, and files touched by
// mutating tools (syntax-checked; clean files inject nothing) and folds them
// into bounded context fragments the model reads before acting. Subagent jobs
// are skipped here on purpose — a subagent's result is delivered inline
// through the Agent tool's return value, so surfacing it again as "job
// finished" would double-report it.
//
// Rendering and escaping are centralized in the fragment accumulator.
export function makePreTurnInjector(opts: {
  timers?: TimerRegistry;
  jobs?: JobRegistry;
  diagnostics?: {
    tracker: DiagnosticsTracker;
    cwd: string;
    command?: DiagnosticsCommandConfig;
  };
  instructionsCwd?: string;
  nowMs?: () => number;
}): () => Promise<ContextFragment[]> {
  const clock = opts.nowMs ?? (() => Date.now());
  return async (): Promise<ContextFragment[]> => {
    const lines: string[] = [];

    if (opts.timers) {
      for (const fired of opts.timers.drainExpired(clock())) {
        lines.push(
          `<TIMER_FIRED label="${fired.label}" elapsedMs="${fired.elapsedMs}" />`,
        );
      }
    }

    if (opts.jobs) {
      for (const job of opts.jobs.drainSettled()) {
        if (job.type !== "shell") continue;
        const exit =
          job.exitCode !== undefined ? ` exitCode="${job.exitCode}"` : "";
        lines.push(
          `<JOB_FINISHED id="${job.id}" status="${job.status}"${exit} />`,
        );
      }
    }

    const fragments: ContextFragment[] = [];
    if (opts.instructionsCwd) {
      fragments.push(await loadProjectInstructions(opts.instructionsCwd));
    }
    if (lines.length > 0) {
      fragments.push(
        createContextFragment({
          source: "engine",
          type: "runtime_events",
          role: "user",
          merge: "append",
          visibility: "model",
          trust: "untrusted-environment",
          maxBytes: 4_096,
          maxTokens: 1_024,
          content:
            `${lines.join("\n")}\n` +
            "A timer fired or a backgrounded job finished while you were working. " +
            "Use JobStatus for a job's full output; decide your next step.",
        }),
      );
    }

    if (opts.diagnostics) {
      const fragment = await buildDiagnosticsFragment({
        tracker: opts.diagnostics.tracker,
        cwd: opts.diagnostics.cwd,
        ...(opts.diagnostics.command && {
          command: opts.diagnostics.command,
        }),
      });
      if (fragment !== null) fragments.push(fragment);
    }

    return fragments;
  };
}
