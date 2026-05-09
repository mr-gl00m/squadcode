export const AUTO_COMPACT_THRESHOLD = 0.8;
export const DEFAULT_TAIL_TURNS = 2;
export const MIN_PRESERVE_RECENT_TOKENS = 2_000;

export const STRUCTURED_SUMMARIZER_PROMPT = `You are a conversation summarizer. Output a faithful, compact summary of the prior conversation that preserves every decision, fact, file path, code reference, name, and current task state. Drop only redundant chatter. No preamble or sign-off.

Use this exact structure:

## Goal
<one or two sentences naming what the user is trying to accomplish>

## Constraints & Preferences
<bullet list of stated rules, conventions, charter items, banned vocabulary, etc.>

## Progress
### Done
<bullet list of work that has landed, with file paths and identifiers preserved>
### In Progress
<bullet list of work that is partially complete, with the exact next step>
### Blocked
<bullet list of items waiting on a decision, or items that failed and need redo>

## Open Decisions
<bullet list of choices the user has not yet made; include the options>

## Notes
<anything else that future-you would need to continue without re-reading the transcript>`;

export function shouldAutoCompact(
  inputTokens: number,
  contextWindow: number | null,
): boolean {
  if (contextWindow === null || contextWindow <= 0) return false;
  return inputTokens / contextWindow >= AUTO_COMPACT_THRESHOLD;
}

export interface MessageWithRole {
  role: string;
}

export function findTailStart(
  messages: ReadonlyArray<MessageWithRole>,
  tailTurns: number,
): number {
  let userCount = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === "user") {
      userCount += 1;
      if (userCount >= tailTurns) return i;
    }
  }
  return 0;
}
