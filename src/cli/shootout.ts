import {
  createAgentWorktree,
  WorktreeRequiredError,
} from "../agents/worktree.js";
import { runAgentLoop } from "../engine/loop.js";
import { logger } from "../logger.js";
import type { PolicyConfig } from "../permissions/policy.js";
import { calculateCost, lookupPricing } from "../pricing.js";
import { userPromptMessage } from "../prompts/boundary.js";
import type { CanonicalEvent, LLMProvider } from "../providers/types.js";
import type { ShootoutManifest } from "../sessions/shootout-store.js";
import {
  diffTrajectories,
  summarizeTrajectory,
  type TrajectoryDiff,
  type TrajectorySummary,
} from "../sessions/trajectory-diff.js";
import type { ToolRegistry } from "../tools/registry.js";

// The vetting fan-out: run the same prompt through N model backends under the
// same loop, tool set, and permission ruleset, each in its own isolated git
// worktree, then summarize + pairwise-diff the trajectories. The thing Squad is
// structurally positioned to do. Slots run concurrently; one slot throwing is
// captured as that slot's error verdict, never aborting the others.
export interface ShootoutSlotSpec {
  label: string;
  provider: LLMProvider;
  providerId: string;
  modelId: string;
}

export interface ShootoutOptions {
  prompt: string;
  cwd: string;
  slots: ShootoutSlotSpec[];
  // Fresh tool registry per slot (no shared todo / deferred state across slots).
  registryFactory: () => ToolRegistry;
  policy: PolicyConfig;
  maxTurns?: number;
  // Isolate each slot in its own git worktree (skipped on a non-git dir).
  isolate?: boolean;
  systemPrompt?: string;
  runId: string;
  createdAt: string;
  // Injectable clock for deterministic wall-time in tests.
  nowMs?: () => number;
}

export interface ShootoutRun {
  manifest: ShootoutManifest;
  perSlotEvents: Map<string, CanonicalEvent[]>;
}

async function runSlot(
  spec: ShootoutSlotSpec,
  opts: ShootoutOptions,
  clock: () => number,
): Promise<{
  summary: TrajectorySummary;
  events: CanonicalEvent[];
  worktreePath?: string;
}> {
  const events: CanonicalEvent[] = [];
  let worktree: Awaited<ReturnType<typeof createAgentWorktree>> = null;
  const start = clock();
  const abort = new AbortController();

  try {
    if (opts.isolate) {
      worktree = await createAgentWorktree(opts.cwd, spec.label, {
        required: true,
        runId: opts.runId,
      });
    }
    const slotCwd = worktree?.path ?? opts.cwd;
    for await (const ev of runAgentLoop({
      provider: spec.provider,
      model: spec.modelId,
      ...(opts.systemPrompt !== undefined && {
        systemPrompt: opts.systemPrompt,
      }),
      messages: [userPromptMessage(opts.prompt)],
      registry: opts.registryFactory(),
      policy: { ...opts.policy, cwd: slotCwd },
      cwd: slotCwd,
      abort: abort.signal,
      ...(opts.maxTurns !== undefined && { maxTurns: opts.maxTurns }),
      // A shootout is autonomous and isolated, so confirmations auto-allow —
      // edits land in the slot's throwaway worktree, never the user's tree.
      askPermission: async () => "allow",
    })) {
      events.push(ev);
    }
  } catch (err: unknown) {
    const isolationFailure = err instanceof WorktreeRequiredError;
    logger.warn(
      {
        label: spec.label,
        err: err instanceof Error ? err.message : String(err),
      },
      "shootout slot threw",
    );
    events.push({
      type: "error",
      code: isolationFailure ? "WORKTREE_REQUIRED" : "SLOT_THREW",
      message: err instanceof Error ? err.message : String(err),
      retryable: false,
    });
  }

  const wallMs = Math.max(0, clock() - start);
  const lastUsage = [...events]
    .reverse()
    .find(
      (e): e is Extract<CanonicalEvent, { type: "usage" }> =>
        e.type === "usage",
    );
  const pricing = lookupPricing(spec.providerId, spec.modelId);
  const costUsd =
    pricing && lastUsage
      ? calculateCost(
          pricing,
          lastUsage.usage.inputTokens,
          lastUsage.usage.outputTokens,
          lastUsage.usage.cachedInputTokens,
        )
      : 0;

  const summary = summarizeTrajectory({
    label: spec.label,
    provider: spec.providerId,
    model: spec.modelId,
    events,
    wallMs,
    costUsd,
  });
  return {
    summary,
    events,
    ...(worktree && { worktreePath: worktree.path }),
  };
}

export async function runShootout(opts: ShootoutOptions): Promise<ShootoutRun> {
  const clock = opts.nowMs ?? (() => Date.now());
  const results = await Promise.all(
    opts.slots.map((spec) => runSlot(spec, opts, clock)),
  );

  const summaries = results.map((r) => r.summary);
  const diffs: TrajectoryDiff[] = [];
  for (let i = 0; i < summaries.length; i += 1) {
    for (let j = i + 1; j < summaries.length; j += 1) {
      const a = summaries[i];
      const b = summaries[j];
      if (a && b) diffs.push(diffTrajectories(a, b));
    }
  }

  const perSlotEvents = new Map<string, CanonicalEvent[]>();
  for (let i = 0; i < opts.slots.length; i += 1) {
    const slot = opts.slots[i];
    const result = results[i];
    if (slot && result) perSlotEvents.set(slot.label, result.events);
  }

  const manifest: ShootoutManifest = {
    runId: opts.runId,
    prompt: opts.prompt,
    createdAt: opts.createdAt,
    cwd: opts.cwd,
    models: opts.slots.map((s) => s.modelId),
    worktrees: Object.fromEntries(
      results.flatMap((result, index) => {
        const slot = opts.slots[index];
        return slot && result.worktreePath
          ? [[slot.label, result.worktreePath] as const]
          : [];
      }),
    ),
    summaries,
    diffs,
  };
  return { manifest, perSlotEvents };
}
