import type { CanonicalMessage } from "../providers/types.js";

// /replay and --replay render the last N *turns* of a conversation as a compact
// preroll so you re-orient on resume without scrolling. A "turn" begins at each
// user message. Works off the in-memory CanonicalMessage[] (the REPL already
// holds it; the CLI path converts records first), so there's no audit-chain
// dependency — it's a pure read of conversation content.

export const DEFAULT_REPLAY_LIMIT = 5;
const MAX_REPLAY_LIMIT = 50;
const PREVIEW_CHARS = 240;

export function parseReplayLimit(arg: string): number {
  const n = Number.parseInt(arg.trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REPLAY_LIMIT;
  return Math.min(n, MAX_REPLAY_LIMIT);
}

function oneLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

export function formatReplay(
  messages: readonly CanonicalMessage[],
  label: string,
  limit: number,
): string {
  const userIdxs: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "user") userIdxs.push(i);
  });
  if (userIdxs.length === 0) {
    return `(${label} has no turns to replay yet)`;
  }
  const shown = Math.min(limit, userIdxs.length);
  // userIdxs[len - shown] is the start of the Nth-from-last turn.
  const startIdx = userIdxs[userIdxs.length - shown] ?? 0;
  const lines: string[] = [
    `── replay: last ${shown} turn${shown === 1 ? "" : "s"} of ${label} ──`,
    "",
  ];
  for (const m of messages.slice(startIdx)) {
    if (m.role === "user") {
      lines.push(`▸ you: ${oneLine(m.content, PREVIEW_CHARS)}`);
    } else if (m.role === "assistant") {
      const text = m.content.trim();
      if (text) lines.push(`  ${oneLine(text, PREVIEW_CHARS)}`);
      if (m.toolCalls && m.toolCalls.length > 0) {
        lines.push(`  ⚙ ${m.toolCalls.map((t) => t.name).join(" · ")}`);
      }
    }
    // tool-result messages are summarized by the ⚙ line above — skip them to
    // keep the preroll compact.
  }
  return lines.join("\n");
}
