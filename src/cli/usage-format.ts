import { formatCost } from "../pricing.js";
import type { UsageGroupRow, UsageTotals } from "../sessions/usage-ledger.js";

export interface UsageReport {
  totals: UsageTotals;
  byDay: UsageGroupRow[];
  byModel: UsageGroupRow[];
  bySession: UsageGroupRow[];
}

export interface FormatOpts {
  scopeLabel: string;
  daysBack?: number;
  thisSessionTotals?: UsageTotals;
}

export function formatUsageReport(
  report: UsageReport,
  opts: FormatOpts,
): string {
  const lines: string[] = [];
  lines.push(`Usage — ${opts.scopeLabel}`);
  if (report.totals.rows === 0) {
    lines.push("  (no usage records yet)");
    return lines.join("\n");
  }
  const range = formatRange(report.totals.firstTs, report.totals.lastTs);
  lines.push(
    `  ${report.totals.rows} record${report.totals.rows === 1 ? "" : "s"}${range}`,
  );
  lines.push(
    `  input  ${formatTokens(report.totals.inputTokens)}` +
      `  (hit ${formatTokens(report.totals.cachedInputTokens)} / miss ${formatTokens(missTokens(report.totals))}, ${cachePct(report.totals)}% cached)`,
  );
  lines.push(`  output ${formatTokens(report.totals.outputTokens)}`);
  lines.push(`  total  ${formatTokens(report.totals.totalTokens)}`);
  lines.push(`  cost   ${formatCost(report.totals.costUsd)}`);
  lines.push(`  tool calls: ${report.totals.toolCalls.toLocaleString()}`);

  if (opts.thisSessionTotals && opts.thisSessionTotals.rows > 0) {
    const t = opts.thisSessionTotals;
    lines.push("");
    lines.push("This session:");
    lines.push(
      `  input ${formatTokens(t.inputTokens)} (${cachePct(t)}% cached) · output ${formatTokens(t.outputTokens)} · ${formatCost(t.costUsd)}`,
    );
  }

  if (report.byDay.length > 0) {
    lines.push("");
    const daysBack = opts.daysBack ?? report.byDay.length;
    lines.push(`By day (last ${daysBack}):`);
    for (const row of report.byDay) {
      lines.push(
        `  ${row.key}  in ${formatTokens(row.inputTokens)} (${cachePct(row)}% cached) · out ${formatTokens(row.outputTokens)} · ${formatCost(row.costUsd)}  [${row.rows} turn${row.rows === 1 ? "" : "s"}]`,
      );
    }
  }

  if (report.byModel.length > 1) {
    lines.push("");
    lines.push("By model:");
    for (const row of report.byModel) {
      lines.push(
        `  ${row.key.padEnd(28)}  in ${formatTokens(row.inputTokens)} (${cachePct(row)}% cached) · out ${formatTokens(row.outputTokens)} · ${formatCost(row.costUsd)}`,
      );
    }
  }

  if (report.bySession.length > 0) {
    lines.push("");
    lines.push(`Recent sessions (top ${report.bySession.length}):`);
    for (const row of report.bySession) {
      lines.push(
        `  ${row.key.slice(0, 8)}  in ${formatTokens(row.inputTokens)} (${cachePct(row)}% cached) · out ${formatTokens(row.outputTokens)} · ${formatCost(row.costUsd)}  [${row.rows} turn${row.rows === 1 ? "" : "s"}]`,
      );
    }
  }
  return lines.join("\n");
}

function missTokens(t: {
  inputTokens: number;
  cachedInputTokens: number;
}): number {
  return Math.max(0, t.inputTokens - t.cachedInputTokens);
}

function cachePct(t: {
  inputTokens: number;
  cachedInputTokens: number;
}): number {
  if (t.inputTokens <= 0) return 0;
  return Math.round((t.cachedInputTokens / t.inputTokens) * 100);
}

function formatRange(first: string | null, last: string | null): string {
  if (!first || !last) return "";
  const firstDay = first.slice(0, 10);
  const lastDay = last.slice(0, 10);
  if (firstDay === lastDay) return `  (${firstDay})`;
  return `  (${firstDay} → ${lastDay})`;
}

function formatTokens(n: number): string {
  if (n < 1000) return n.toLocaleString();
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
