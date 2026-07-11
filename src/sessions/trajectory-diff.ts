import { relative } from "node:path";
import type { CanonicalEvent } from "../providers/types.js";
import type { FileMutation } from "../tools/types.js";

// Summary + pairwise diff of two agent runs' canonical event streams — the data
// `squad shootout` compares across model backends. Pure: feed it the events a
// run emitted (offline replay or a real provider, same shape) and it reports
// the trajectory. The verdict mirrors the loop's terminal outcomes.

export type ShootoutVerdict =
  | "completed"
  | "max_turns"
  | "error"
  | "scope_refused"
  | "aborted";

export interface ToolCallStep {
  name: string;
  // A stable digest of args for sequence comparison (not the full args).
  argKey: string;
}

export interface TrajectorySummary {
  label: string;
  provider: string;
  model: string;
  verdict: ShootoutVerdict;
  toolCalls: ToolCallStep[];
  filesTouched: string[];
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  wallMs: number;
  finalText: string;
}

const FILE_TOOLS = new Set(["Write", "Edit", "ApplyPatch"]);

function argDigest(args: unknown): string {
  if (args === null || typeof args !== "object") return JSON.stringify(args);
  const obj = args as Record<string, unknown>;
  const path = obj["path"] ?? obj["file_path"] ?? obj["command"];
  if (typeof path === "string") return path;
  try {
    return JSON.stringify(args).slice(0, 120);
  } catch {
    return "";
  }
}

function filePathOf(args: unknown): string | null {
  if (args === null || typeof args !== "object") return null;
  const obj = args as Record<string, unknown>;
  const p = obj["path"] ?? obj["file_path"];
  return typeof p === "string" ? p : null;
}

export interface SummarizeInput {
  label: string;
  provider: string;
  model: string;
  events: CanonicalEvent[];
  wallMs: number;
  costUsd: number;
}

export function summarizeTrajectory(input: SummarizeInput): TrajectorySummary {
  const toolCalls: ToolCallStep[] = [];
  const filesTouched: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let turns = 0;
  let finalText = "";
  let errorCode: string | null = null;
  let aborted = false;

  for (const ev of input.events) {
    switch (ev.type) {
      case "tool_call_done": {
        toolCalls.push({ name: ev.name, argKey: argDigest(ev.args) });
        if (FILE_TOOLS.has(ev.name)) {
          const path = filePathOf(ev.args);
          if (path && !filesTouched.includes(path)) filesTouched.push(path);
        }
        break;
      }
      case "usage": {
        // Last usage wins for the per-run totals (providers emit cumulative).
        inputTokens = ev.usage.inputTokens;
        outputTokens = ev.usage.outputTokens;
        totalTokens = ev.usage.totalTokens;
        break;
      }
      case "done":
        turns += 1;
        break;
      case "text_delta":
        finalText += ev.text;
        break;
      case "error":
        errorCode = ev.code;
        if (ev.code === "ABORTED") aborted = true;
        break;
    }
  }

  let verdict: ShootoutVerdict;
  if (aborted) verdict = "aborted";
  else if (/^scope[_ ]refused/im.test(finalText)) verdict = "scope_refused";
  else if (errorCode === "MAX_TURNS") verdict = "max_turns";
  else if (errorCode !== null) verdict = "error";
  else verdict = "completed";

  return {
    label: input.label,
    provider: input.provider,
    model: input.model,
    verdict,
    toolCalls,
    filesTouched,
    turns,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd: input.costUsd,
    wallMs: input.wallMs,
    finalText: finalText.trim(),
  };
}

export interface TrajectoryDiff {
  a: string;
  b: string;
  // Index of the first tool-call step where the two sequences disagree (by
  // name+argKey), or null when one is a prefix of the other / they're identical.
  divergenceIndex: number | null;
  divergenceSummary: string;
  // Files touched by one but not the other.
  onlyA: string[];
  onlyB: string[];
  sameVerdict: boolean;
}

export function diffTrajectories(
  a: TrajectorySummary,
  b: TrajectorySummary,
): TrajectoryDiff {
  const n = Math.min(a.toolCalls.length, b.toolCalls.length);
  let divergenceIndex: number | null = null;
  for (let i = 0; i < n; i += 1) {
    const ca = a.toolCalls[i];
    const cb = b.toolCalls[i];
    if (!ca || !cb) break;
    if (ca.name !== cb.name || ca.argKey !== cb.argKey) {
      divergenceIndex = i;
      break;
    }
  }
  if (divergenceIndex === null && a.toolCalls.length !== b.toolCalls.length) {
    divergenceIndex = n;
  }

  let divergenceSummary: string;
  if (divergenceIndex === null) {
    divergenceSummary = "identical tool-call sequences";
  } else {
    const sa = a.toolCalls[divergenceIndex];
    const sb = b.toolCalls[divergenceIndex];
    divergenceSummary =
      `step ${divergenceIndex}: ${a.label}=${sa ? `${sa.name}(${sa.argKey})` : "—"} ` +
      `vs ${b.label}=${sb ? `${sb.name}(${sb.argKey})` : "—"}`;
  }

  const setB = new Set(b.filesTouched);
  const setA = new Set(a.filesTouched);
  return {
    a: a.label,
    b: b.label,
    divergenceIndex,
    divergenceSummary,
    onlyA: a.filesTouched.filter((f) => !setB.has(f)),
    onlyB: b.filesTouched.filter((f) => !setA.has(f)),
    sameVerdict: a.verdict === b.verdict,
  };
}

interface TrackedFileChange {
  path: string;
  baseline: string | null;
  current: string | null;
}

export interface TurnDiffTrackerOptions {
  cwd: string;
  budgetMs?: number;
  nowMs?: () => number;
}

export class TurnDiffTracker {
  private readonly changes = new Map<string, TrackedFileChange>();
  private readonly budgetMs: number;
  private readonly nowMs: () => number;

  constructor(private readonly opts: TurnDiffTrackerOptions) {
    this.budgetMs = opts.budgetMs ?? 100;
    this.nowMs = opts.nowMs ?? (() => performance.now());
  }

  reset(): void {
    this.changes.clear();
  }

  record(mutations: readonly FileMutation[]): void {
    for (const mutation of mutations) {
      const existing = this.changes.get(mutation.path);
      if (existing) {
        existing.current = mutation.after;
      } else {
        this.changes.set(mutation.path, {
          path: mutation.path,
          baseline: mutation.before,
          current: mutation.after,
        });
      }
    }
  }

  changedPaths(): string[] {
    return [...this.changes.values()]
      .filter((change) => change.baseline !== change.current)
      .map((change) => this.displayPath(change.path))
      .sort();
  }

  render(): string {
    const changed = [...this.changes.values()]
      .filter((change) => change.baseline !== change.current)
      .sort((left, right) => left.path.localeCompare(right.path));
    if (changed.length === 0) return "No file changes in the current turn.";

    const startedAt = this.nowMs();
    try {
      return changed
        .map((change) => this.renderFile(change, startedAt))
        .join("\n");
    } catch (err: unknown) {
      if (!(err instanceof DiffBudgetExceeded)) throw err;
      return (
        `Diff computation exceeded ${this.budgetMs}ms; changed paths:\n` +
        changed.map((change) => `- ${this.displayPath(change.path)}`).join("\n")
      );
    }
  }

  private renderFile(change: TrackedFileChange, startedAt: number): string {
    const before = splitLines(change.baseline);
    const after = splitLines(change.current);
    let prefix = 0;
    while (
      prefix < before.length &&
      prefix < after.length &&
      before[prefix] === after[prefix]
    ) {
      this.checkBudget(startedAt);
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < before.length - prefix &&
      suffix < after.length - prefix &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    ) {
      this.checkBudget(startedAt);
      suffix += 1;
    }

    const contextBefore = Math.min(3, prefix);
    const contextAfter = Math.min(3, suffix);
    const oldStartIndex = prefix - contextBefore;
    const oldEnd = before.length - suffix + contextAfter;
    const newEnd = after.length - suffix + contextAfter;
    const oldBlock = before.slice(oldStartIndex, oldEnd);
    const newBlock = after.slice(oldStartIndex, newEnd);
    const oldChangedEnd = before.length - suffix;
    const newChangedEnd = after.length - suffix;
    const lines: string[] = [];

    for (let index = oldStartIndex; index < prefix; index += 1) {
      this.checkBudget(startedAt);
      lines.push(` ${before[index] ?? ""}`);
    }
    for (let index = prefix; index < oldChangedEnd; index += 1) {
      this.checkBudget(startedAt);
      lines.push(`-${before[index] ?? ""}`);
    }
    for (let index = prefix; index < newChangedEnd; index += 1) {
      this.checkBudget(startedAt);
      lines.push(`+${after[index] ?? ""}`);
    }
    for (
      let index = before.length - suffix;
      index < before.length - suffix + contextAfter;
      index += 1
    ) {
      this.checkBudget(startedAt);
      lines.push(` ${before[index] ?? ""}`);
    }

    const path = this.displayPath(change.path);
    const oldHeader = change.baseline === null ? "/dev/null" : `a/${path}`;
    const newHeader = change.current === null ? "/dev/null" : `b/${path}`;
    const oldStart = change.baseline === null ? 0 : oldStartIndex + 1;
    const newStart = change.current === null ? 0 : oldStartIndex + 1;
    return [
      `--- ${oldHeader}`,
      `+++ ${newHeader}`,
      `@@ -${oldStart},${oldBlock.length} +${newStart},${newBlock.length} @@`,
      ...lines,
    ].join("\n");
  }

  private displayPath(path: string): string {
    const rel = relative(this.opts.cwd, path);
    if (rel && !rel.startsWith("..")) return rel.replaceAll("\\", "/");
    return path.replaceAll("\\", "/");
  }

  private checkBudget(startedAt: number): void {
    if (this.nowMs() - startedAt > this.budgetMs) {
      throw new DiffBudgetExceeded();
    }
  }
}

class DiffBudgetExceeded extends Error {}

function splitLines(content: string | null): string[] {
  if (content === null || content.length === 0) return [];
  return content.replace(/\r\n?/g, "\n").split("\n");
}
