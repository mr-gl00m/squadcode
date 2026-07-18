import { useInput } from "ink";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useRef,
  useState,
} from "react";
import type { HistoryEntry } from "./repl-types.js";
import {
  replayEntries,
  type ToolCallRecord,
  type ViewMode,
} from "./tool-ledger.js";

// Owns the compact/detailed tool view and the per-turn ledger state behind
// it. Compact hides the per-call transcript spam behind a live ledger
// window; detailed is the raw two-line-per-call firehose. Ctrl+O flips at
// any time, including mid-stream. Scrollback can't be rewritten, so
// flipping to detailed replays the retained ledger (this turn while
// streaming, otherwise the last turn) as merged one-line entries.
export function useToolView(opts: {
  append: (kind: HistoryEntry["kind"], text: string) => void;
  disabled: boolean;
  isStreaming: boolean;
}): {
  ledger: readonly ToolCallRecord[];
  setLedger: Dispatch<SetStateAction<readonly ToolCallRecord[]>>;
  viewMode: ViewMode;
  viewModeRef: MutableRefObject<ViewMode>;
} {
  const [viewMode, setViewMode] = useState<ViewMode>("compact");
  const viewModeRef = useRef<ViewMode>("compact");
  const [ledger, setLedger] = useState<readonly ToolCallRecord[]>([]);

  useInput((inputChar, key) => {
    if (opts.disabled) return;
    if (!key.ctrl || inputChar.toLowerCase() !== "o") return;
    const next: ViewMode =
      viewModeRef.current === "compact" ? "detailed" : "compact";
    viewModeRef.current = next;
    setViewMode(next);
    if (next === "compact") {
      opts.append("system", "view: compact · Ctrl-O for the full tool trace");
      return;
    }
    if (ledger.length === 0) {
      opts.append(
        "system",
        "view: detailed · every tool call and result prints",
      );
      return;
    }
    const scope = opts.isStreaming ? "this turn so far" : "last turn";
    opts.append(
      "system",
      `view: detailed · replaying ${ledger.length} tool call${ledger.length === 1 ? "" : "s"} (${scope})`,
    );
    for (const entry of replayEntries(ledger)) {
      opts.append(entry.kind, entry.text);
    }
  });

  return { ledger, setLedger, viewMode, viewModeRef };
}
