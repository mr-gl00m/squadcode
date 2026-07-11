import type { SessionMetadata } from "../sessions/types.js";
import type { ResumeTarget } from "./slash.js";

// Resolves a /resume argument against the cwd's sessions (most-recent-first, as
// store.list returns them) to a concrete target or an error.
//
//   - explicit arg: match a session by id or id-prefix, even if it's empty —
//     the user asked for it specifically.
//   - no arg: the most recent OTHER session that actually has content. The
//     current session was just created (and so is most-recent), and relaunching
//     to test leaves empty stubs behind; skipping turnCount/token-empty sessions
//     makes a bare /resume land on the last real conversation instead of a stub.
export function pickResumeTarget(
  sessions: readonly SessionMetadata[],
  currentSessionId: string,
  arg: string,
): ResumeTarget {
  const trimmed = arg.trim();
  if (trimmed) {
    const target = sessions.find(
      (s) => s.sessionId === trimmed || s.sessionId.startsWith(trimmed),
    );
    if (!target) {
      return {
        error: `no session matching "${trimmed}" in this directory (try /sessions)`,
      };
    }
    return { sessionId: target.sessionId, turnCount: target.turnCount };
  }
  const target = sessions.find(
    (s) =>
      s.sessionId !== currentSessionId &&
      (s.turnCount > 0 || s.totalTokens > 0),
  );
  if (!target) {
    return {
      error:
        "no earlier conversation in this directory to resume (try /sessions)",
    };
  }
  return { sessionId: target.sessionId, turnCount: target.turnCount };
}
