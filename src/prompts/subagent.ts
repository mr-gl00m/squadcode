import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SubagentDef, SubagentReport } from "../agents/types.js";
import { TRUST_BOUNDARY_INSTRUCTION } from "./boundary.js";

// The structured-report contract, loaded once from the .md beside this module.
// copy-assets.mjs places the .md next to the compiled .js in dist, and under
// vitest it resolves straight to the source file — both via import.meta.url.
let cachedOutputFormat: string | null = null;

export function subagentOutputFormat(): string {
  if (cachedOutputFormat === null) {
    const path = fileURLToPath(
      new URL("./subagent-output-format.md", import.meta.url),
    );
    cachedOutputFormat = readFileSync(path, "utf-8").trim();
  }
  return cachedOutputFormat;
}

// The hard scope lock (FETCH §3). A subagent owns exactly one task. If the
// conversation tries to widen it — "while you're in there, also…" — the agent
// must refuse and report SCOPE_REFUSED rather than silently expanding. This is
// load-bearing for vetting: a run that quietly does more than asked isn't
// comparable to one that stayed in scope.
const SCOPE_LOCK = [
  "You are a subagent with exactly one task, stated in the user message below.",
  "You operate under a hard scope lock:",
  "- Do that task and nothing else. Do not take on adjacent work, even if it looks helpful or trivial.",
  "- If the task or any later instruction asks you to expand beyond your single assignment, refuse: stop, and report SCOPE_REFUSED in your BLOCKERS section naming what was out of scope.",
  "- You cannot spawn subagents of your own; the Agent tool is not available to you.",
  "- When your task is complete (or refused), finish with the structured report below. Do not keep working past completion.",
].join("\n");

// Assembles the full system prompt a subagent runs under: its own role prompt,
// then the universal scope lock, then the report contract. The task itself is
// delivered as the first user message, not here. Note what is deliberately
// absent: the agent's anguish scalar. Anguish is observability only and must
// never enter the prompt (it would modulate the model under test).
export function assembleSubagentSystemPrompt(def: SubagentDef): string {
  return [
    def.systemPrompt.trim(),
    TRUST_BOUNDARY_INSTRUCTION,
    SCOPE_LOCK,
    subagentOutputFormat(),
  ].join("\n\n");
}

function extractSection(text: string, heading: string): string {
  // Grab everything under "### HEADING" up to the next "### " or end of text.
  const re = new RegExp(
    `^###\\s+${heading}\\s*\\r?\\n([\\s\\S]*?)(?=^###\\s+|\\s*$(?![\\s\\S]))`,
    "im",
  );
  const m = text.match(re);
  return (m?.[1] ?? "").trim();
}

function toBullets(section: string): string[] {
  const lines = section
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .filter((l) => l.length > 0);
  // A lone "None." means an intentionally empty section.
  if (lines.length === 1 && /^none\.?$/i.test(lines[0] ?? "")) return [];
  return lines;
}

// Parses a subagent's final text into the structured report. Tolerant of a
// model that ignored the format: if no sections are found, the whole text
// becomes the summary, and `raw` always carries the verbatim output so the
// parent can fall back to reading it directly.
export function parseSubagentReport(text: string): SubagentReport {
  const summary = extractSection(text, "SUMMARY");
  const evidence = toBullets(extractSection(text, "EVIDENCE"));
  const changes = toBullets(extractSection(text, "CHANGES"));
  const risks = toBullets(extractSection(text, "RISKS"));
  const blockers = toBullets(extractSection(text, "BLOCKERS"));
  return {
    summary: summary || text.trim(),
    evidence,
    changes,
    risks,
    blockers,
    raw: text,
  };
}

// True when the agent refused on scope grounds — its BLOCKERS (or raw output)
// leads with the SCOPE_REFUSED marker the scope lock instructs it to emit.
export function isScopeRefusal(report: SubagentReport): boolean {
  if (report.blockers.some((b) => /^scope[_ ]refused/i.test(b))) return true;
  return /^scope[_ ]refused/im.test(report.raw);
}

// Renders a report back to the canonical five-section markdown — the exact
// payload the parent agent reads as the Agent tool's result.
export function formatSubagentReport(report: SubagentReport): string {
  const section = (heading: string, items: string[]): string =>
    `### ${heading}\n${
      items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : "None."
    }`;
  return [
    `### SUMMARY\n${report.summary || "None."}`,
    section("EVIDENCE", report.evidence),
    section("CHANGES", report.changes),
    section("RISKS", report.risks),
    section("BLOCKERS", report.blockers),
  ].join("\n\n");
}
