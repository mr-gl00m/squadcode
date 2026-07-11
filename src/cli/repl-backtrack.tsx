import { useInput } from "ink";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useRef,
  useState,
} from "react";
import type { CanonicalMessage } from "../providers/types.js";
import type { RollbackResult, SessionStore } from "../sessions/store.js";
import type { TurnDiffTracker } from "../sessions/trajectory-diff.js";
import type { RollbackTarget, SessionRecord } from "../sessions/types.js";
import { sanitizeForTerminal } from "../terminal.js";
import type { HistoryEntry } from "./repl-types.js";

const ESCAPE_WINDOW_MS = 500;

export interface BacktrackViewState {
  open: boolean;
  status: "loading" | "ready" | "rolling-back" | "error";
  targets: RollbackTarget[];
  selected: number;
  message?: string;
}

interface ReplBacktrackOptions {
  disabled: boolean;
  sessionId: string;
  store: SessionStore;
  header: HistoryEntry;
  messagesRef: MutableRefObject<CanonicalMessage[]>;
  idRef: MutableRefObject<number>;
  turnDiff: TurnDiffTracker;
  setHistory: Dispatch<SetStateAction<HistoryEntry[]>>;
  setTurnCount: Dispatch<SetStateAction<number>>;
  setTotalTokens: Dispatch<SetStateAction<number>>;
}

export function useReplBacktrack(
  opts: ReplBacktrackOptions,
): BacktrackViewState {
  const [state, setState] = useState<BacktrackViewState>({
    open: false,
    status: "loading",
    targets: [],
    selected: 0,
  });
  const lastEscapeRef = useRef(0);

  useInput((input, key) => {
    if (opts.disabled) return;
    if (state.open) {
      if (key.escape) {
        setState((previous) => ({ ...previous, open: false }));
        return;
      }
      if (state.status !== "ready") return;
      if (key.upArrow) {
        setState((previous) => ({
          ...previous,
          selected: Math.max(0, previous.selected - 1),
        }));
        return;
      }
      if (key.downArrow) {
        setState((previous) => ({
          ...previous,
          selected: Math.min(
            previous.targets.length - 1,
            previous.selected + 1,
          ),
        }));
        return;
      }
      if (key.return || input === "\r" || input === "\n") {
        const target = state.targets[state.selected];
        if (target) void requestRollback(opts, target, setState);
      }
      return;
    }
    if (!key.escape) return;
    const now = Date.now();
    if (now - lastEscapeRef.current <= ESCAPE_WINDOW_MS) {
      lastEscapeRef.current = 0;
      void loadTargets(opts, setState);
    } else {
      lastEscapeRef.current = now;
    }
  });

  return state;
}

async function loadTargets(
  opts: ReplBacktrackOptions,
  setState: Dispatch<SetStateAction<BacktrackViewState>>,
): Promise<void> {
  setState({ open: true, status: "loading", targets: [], selected: 0 });
  try {
    const checkpoints = await opts.store.listRollbackTargets(opts.sessionId);
    const targets = checkpoints.slice(0, -1);
    if (targets.length === 0) {
      setState({
        open: true,
        status: "error",
        targets: [],
        selected: 0,
        message: "No prior completed turn is available.",
      });
      return;
    }
    setState({
      open: true,
      status: "ready",
      targets,
      selected: targets.length - 1,
    });
  } catch (err: unknown) {
    setState({
      open: true,
      status: "error",
      targets: [],
      selected: 0,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function requestRollback(
  opts: ReplBacktrackOptions,
  target: RollbackTarget,
  setState: Dispatch<SetStateAction<BacktrackViewState>>,
): Promise<void> {
  setState((previous) => ({ ...previous, status: "rolling-back" }));
  try {
    const result = await opts.store.rollbackTurn(opts.sessionId, target.turnId);
    applyConfirmedRollback(opts, result);
    setState({ open: false, status: "ready", targets: [], selected: 0 });
  } catch (err: unknown) {
    setState((previous) => ({
      ...previous,
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

function applyConfirmedRollback(
  opts: ReplBacktrackOptions,
  result: RollbackResult,
): void {
  opts.messagesRef.current.length = 0;
  opts.messagesRef.current.push(...result.messages);
  const history = rollbackHistory(result.records, opts.header);
  history.push({
    id: history.length,
    kind: "system",
    text: `rolled back to turn ${result.target.turnNumber}${result.workspaceRestored ? " (workspace restored)" : " (conversation only)"}`,
  });
  opts.idRef.current = history.length;
  opts.setHistory(history);
  opts.setTurnCount(result.metadata.turnCount);
  opts.setTotalTokens(result.metadata.totalTokens);
  opts.turnDiff.reset();
}

export function rollbackHistory(
  records: readonly SessionRecord[],
  header: HistoryEntry,
): HistoryEntry[] {
  const history: HistoryEntry[] = [{ ...header, id: 0 }];
  const append = (kind: HistoryEntry["kind"], text: string): void => {
    history.push({ id: history.length, kind, text: sanitizeForTerminal(text) });
  };
  for (const record of records) {
    switch (record.type) {
      case "session_meta":
      case "turn_checkpoint":
        break;
      case "user_message":
        append("user", record.payload.content);
        break;
      case "assistant_message":
        for (const line of record.payload.content.split("\n")) {
          append("assistant", line);
        }
        break;
      case "tool_call":
        append("tool", `[${record.payload.toolName}] called`);
        break;
      case "tool_result":
        append(
          record.payload.ok ? "tool" : "error",
          `[${record.payload.toolName}] ${record.payload.ok ? "ok" : record.payload.reason}`,
        );
        break;
    }
  }
  return history;
}
