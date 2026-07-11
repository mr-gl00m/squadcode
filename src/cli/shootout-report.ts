import type { ShootoutManifest } from "../sessions/shootout-store.js";

// Renders a shootout manifest to a side-by-side text report. Text, not Ink, on
// purpose: a vetting artifact you want to read headless, pipe, and diff — and it
// stays unit-testable. `squad shootout` prints this; `squad shootout report
// <id>` re-renders a saved one.

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

export function formatShootoutReport(manifest: ShootoutManifest): string {
  const lines: string[] = [];
  lines.push(`Shootout ${manifest.runId}`);
  lines.push(`  prompt: ${truncate(manifest.prompt, 80)}`);
  lines.push(`  models: ${manifest.models.join(", ")}`);
  lines.push("");

  for (const s of manifest.summaries) {
    const toolSeq =
      s.toolCalls.length > 0
        ? s.toolCalls.map((t) => t.name).join(" → ")
        : "none";
    lines.push(`── ${s.label}  [${s.provider}/${s.model}]`);
    lines.push(`   verdict : ${s.verdict}`);
    lines.push(
      `   tools   : ${s.toolCalls.length}  (${truncate(toolSeq, 70)})`,
    );
    lines.push(
      `   files   : ${s.filesTouched.length}${
        s.filesTouched.length > 0 ? `  (${s.filesTouched.join(", ")})` : ""
      }`,
    );
    lines.push(
      `   tokens  : ${s.totalTokens}  (in ${s.inputTokens} / out ${s.outputTokens})`,
    );
    lines.push(`   cost    : ${fmtCost(s.costUsd)}`);
    lines.push(`   time    : ${fmtMs(s.wallMs)}`);
    lines.push("");
  }

  if (manifest.diffs.length > 0) {
    lines.push("Divergence:");
    for (const d of manifest.diffs) {
      const verdictNote = d.sameVerdict ? "" : "  · verdicts differ";
      lines.push(`   ${d.a} vs ${d.b}: ${d.divergenceSummary}${verdictNote}`);
      if (d.onlyA.length > 0) {
        lines.push(`     files only in ${d.a}: ${d.onlyA.join(", ")}`);
      }
      if (d.onlyB.length > 0) {
        lines.push(`     files only in ${d.b}: ${d.onlyB.join(", ")}`);
      }
    }
  }

  return lines.join("\n");
}
