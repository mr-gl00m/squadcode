import { sanitizeForTerminal } from "../terminal.js";

// Per-turn ledger of tool calls, keyed by provider call id. Pure state and
// text formatting, kept out of the .tsx files so it's testable without
// importing Ink/React (same split as agent-panel-state.ts). The turn
// controller folds stream events in; compact view renders the live window;
// the Ctrl+O toggle replays merged lines retroactively from this state.

export type ViewMode = "compact" | "detailed";

export type ToolCallStatus =
  | "preparing"
  | "running"
  | "ok"
  | "failed"
  | "denied"
  | "aborted"
  | "unknown"
  | "interrupted";

export interface ToolCallRecord {
  // Stable render key. Provider call ids can repeat (local models emit
  // duplicates), so ids alone can't key rows.
  seq: number;
  id: string;
  name: string;
  status: ToolCallStatus;
  argBytes: number;
  preview?: string;
  error?: string;
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatToolPreview(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "called";
  const values = args as Record<string, unknown>;
  switch (name) {
    case "Read":
      return `read ${shortPath(values.path)}`;
    case "Write":
      return `wrote ${shortPath(values.path)}`;
    case "Edit":
      return `edited ${shortPath(values.path)}`;
    case "Glob":
      return `matched ${truncateText(stringOr(values.pattern, "?"), 60)}`;
    case "Grep": {
      const pattern = truncateText(stringOr(values.pattern, "?"), 50);
      const where =
        typeof values.path === "string" ? ` in ${shortPath(values.path)}` : "";
      return `searched ${pattern}${where}`;
    }
    case "Shell":
      return `ran ${truncateText(stringOr(values.command, ""), 80)}`;
    case "TodoWrite": {
      const count = Array.isArray(values.todos) ? values.todos.length : 0;
      return `updated checklist (${count} item${count === 1 ? "" : "s"})`;
    }
    default:
      return "called";
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function shortPath(value: unknown): string {
  if (typeof value !== "string") return "?";
  if (value.length <= 60) return value;
  return `...${value.slice(value.length - 57)}`;
}

function truncateText(value: string, length: number): string {
  if (value.length <= length) return value;
  return `${value.slice(0, length - 3)}...`;
}

function isOpen(status: ToolCallStatus): boolean {
  return status === "preparing" || status === "running";
}

// Last open record with this id. Duplicate ids resolve to the most recent
// open call, which matches how a single model stream interleaves them.
function lastOpenIndex(ledger: readonly ToolCallRecord[], id: string): number {
  for (let i = ledger.length - 1; i >= 0; i--) {
    const record = ledger[i] as ToolCallRecord;
    if (record.id === id && isOpen(record.status)) return i;
  }
  return -1;
}

function replaceAt(
  ledger: readonly ToolCallRecord[],
  index: number,
  next: ToolCallRecord,
): ToolCallRecord[] {
  const copy = [...ledger];
  copy[index] = next;
  return copy;
}

export function ledgerStart(
  ledger: readonly ToolCallRecord[],
  id: string,
  name: string,
): ToolCallRecord[] {
  return [
    ...ledger,
    {
      seq: ledger.length,
      id,
      name: sanitizeForTerminal(name),
      status: "preparing",
      argBytes: 0,
    },
  ];
}

export function ledgerDelta(
  ledger: readonly ToolCallRecord[],
  id: string,
  bytes: number,
): readonly ToolCallRecord[] {
  const index = lastOpenIndex(ledger, id);
  if (index < 0) return ledger;
  const record = ledger[index] as ToolCallRecord;
  if (record.status !== "preparing") return ledger;
  return replaceAt(ledger, index, {
    ...record,
    argBytes: record.argBytes + bytes,
  });
}

export function ledgerRun(
  ledger: readonly ToolCallRecord[],
  id: string,
  name: string,
  preview: string,
): ToolCallRecord[] {
  const cleanName = sanitizeForTerminal(name);
  const cleanPreview = sanitizeForTerminal(preview);
  const index = lastOpenIndex(ledger, id);
  if (index < 0) {
    // Recovered calls (e.g. prose-wrapped tool calls from local models) can
    // reach tool_call_done without a start event.
    return [
      ...ledger,
      {
        seq: ledger.length,
        id,
        name: cleanName,
        status: "running",
        argBytes: 0,
        preview: cleanPreview,
      },
    ];
  }
  const record = ledger[index] as ToolCallRecord;
  return replaceAt(ledger, index, {
    ...record,
    name: cleanName,
    status: "running",
    preview: cleanPreview,
  });
}

export interface LedgerResultInput {
  ok: boolean;
  reason?: "denied" | "executed" | "unknown_tool" | "aborted";
  error?: string;
}

function resultStatus(result: LedgerResultInput): ToolCallStatus {
  if (result.ok) return "ok";
  if (result.reason === "denied") return "denied";
  if (result.reason === "aborted") return "aborted";
  if (result.reason === "unknown_tool") return "unknown";
  return "failed";
}

export function ledgerResult(
  ledger: readonly ToolCallRecord[],
  id: string,
  name: string,
  result: LedgerResultInput,
): ToolCallRecord[] {
  const status = resultStatus(result);
  const error =
    result.error === undefined ? undefined : sanitizeForTerminal(result.error);
  const index = lastOpenIndex(ledger, id);
  if (index < 0) {
    return [
      ...ledger,
      {
        seq: ledger.length,
        id,
        name: sanitizeForTerminal(name),
        status,
        argBytes: 0,
        ...(error !== undefined && { error }),
      },
    ];
  }
  const record = ledger[index] as ToolCallRecord;
  return replaceAt(ledger, index, {
    ...record,
    status,
    ...(error !== undefined && { error }),
  });
}

// Turn ended (done, provider error, or Ctrl-C) with calls still open.
export function ledgerInterrupt(
  ledger: readonly ToolCallRecord[],
): readonly ToolCallRecord[] {
  if (!ledger.some((record) => isOpen(record.status))) return ledger;
  return ledger.map((record) =>
    isOpen(record.status) ? { ...record, status: "interrupted" } : record,
  );
}

// Tag text shared by the detailed-mode result line and merged one-liners, so
// both views name a result identically.
export function resultTag(status: ToolCallStatus, error?: string): string {
  if (status === "failed") return error ? `failed (${error})` : "failed";
  return status;
}

export function resultLineTag(result: LedgerResultInput): string {
  const error =
    result.error === undefined ? undefined : sanitizeForTerminal(result.error);
  return resultTag(resultStatus(result), error);
}

// One line carrying everything about a call: name, args preview, outcome.
export function describeRecord(record: ToolCallRecord): string {
  if (record.status === "preparing") {
    return `[${record.name}] preparing arguments (${formatBytes(record.argBytes)})`;
  }
  const preview = record.preview ?? "called";
  return `[${record.name}] ${preview} · ${resultTag(record.status, record.error)}`;
}

// Live-window row text. Running/ok rows drop the tag; the row glyph carries it.
export function liveRowText(record: ToolCallRecord): string {
  if (record.status === "preparing") {
    return `[${record.name}] preparing arguments (${formatBytes(record.argBytes)})`;
  }
  const preview = record.preview ?? "called";
  if (record.status === "running" || record.status === "ok") {
    return `[${record.name}] ${preview}`;
  }
  return `[${record.name}] ${preview} · ${resultTag(record.status, record.error)}`;
}

export interface LedgerCounts {
  total: number;
  ok: number;
  failed: number;
  unknown: number;
  denied: number;
  aborted: number;
  interrupted: number;
  active: number;
}

export function ledgerCounts(ledger: readonly ToolCallRecord[]): LedgerCounts {
  const counts: LedgerCounts = {
    total: ledger.length,
    ok: 0,
    failed: 0,
    unknown: 0,
    denied: 0,
    aborted: 0,
    interrupted: 0,
    active: 0,
  };
  for (const record of ledger) {
    switch (record.status) {
      case "ok":
        counts.ok += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "unknown":
        counts.unknown += 1;
        break;
      case "denied":
        counts.denied += 1;
        break;
      case "aborted":
        counts.aborted += 1;
        break;
      case "interrupted":
        counts.interrupted += 1;
        break;
      case "preparing":
      case "running":
        counts.active += 1;
        break;
    }
  }
  return counts;
}

export function formatLedgerCounts(counts: LedgerCounts): string {
  const parts: string[] = [];
  if (counts.ok > 0) parts.push(`${counts.ok} ok`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.unknown > 0) parts.push(`${counts.unknown} unknown-tool`);
  if (counts.denied > 0) parts.push(`${counts.denied} denied`);
  if (counts.aborted > 0) parts.push(`${counts.aborted} aborted`);
  if (counts.interrupted > 0) {
    parts.push(`${counts.interrupted} interrupted`);
  }
  if (counts.active > 0) parts.push(`${counts.active} running`);
  return parts.join(" · ");
}

// Suffix for the turn-close line: "17 tool calls · 15 ok · 2 failed".
// Null when the turn ran no tools.
export function formatLedgerSummary(
  ledger: readonly ToolCallRecord[],
): string | null {
  const counts = ledgerCounts(ledger);
  if (counts.total === 0) return null;
  const noun = counts.total === 1 ? "tool call" : "tool calls";
  return `${counts.total} ${noun} · ${formatLedgerCounts(counts)}`;
}

export interface LedgerWindow {
  hidden: LedgerCounts | null;
  visible: ToolCallRecord[];
}

export function ledgerWindow(
  ledger: readonly ToolCallRecord[],
  max: number,
): LedgerWindow {
  if (ledger.length <= max) {
    return { hidden: null, visible: [...ledger] };
  }
  return {
    hidden: ledgerCounts(ledger.slice(0, ledger.length - max)),
    visible: ledger.slice(ledger.length - max),
  };
}

export interface ReplayEntry {
  kind: "tool" | "error";
  text: string;
}

// Merged one-liners for the Ctrl+O retroactive dump. Failures keep the red
// (error) kind so the replay reads like the live transcript would have.
export function replayEntries(
  ledger: readonly ToolCallRecord[],
): ReplayEntry[] {
  return ledger.map((record) => ({
    kind:
      record.status === "failed" ||
      record.status === "unknown" ||
      record.status === "denied"
        ? "error"
        : "tool",
    text: describeRecord(record),
  }));
}
