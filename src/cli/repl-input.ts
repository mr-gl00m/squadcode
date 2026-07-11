import { useInput } from "ink";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useEffect,
  useRef,
} from "react";
import { openExternalEditor } from "./external-editor.js";
import { findHistoryMatch } from "./input-history.js";
import {
  extendRapidRun,
  qualifiesAsPasteBurst,
  type RapidInputRun,
  replaceComposerText,
} from "./paste-burst.js";
import {
  type ComposerState,
  classifyPaste,
  composerBackspace,
  composerDeleteWord,
  composerEnd,
  composerForwardDelete,
  composerHome,
  composerInsert,
  composerMoveLeft,
  composerMoveRight,
  detectPaste,
  getCompletionSuggestion,
  isSubmitInput,
  isTerminalFocusReport,
  normalizeComposerValue,
  type PasteEntry,
  placeholderLabel,
} from "./repl-composer.js";

interface RawInputEmitter {
  prependListener(
    event: "input",
    listener: (chunk: Buffer | string) => void,
  ): unknown;
  removeListener(
    event: "input",
    listener: (chunk: Buffer | string) => void,
  ): unknown;
}

export function useRawComposerInput(opts: {
  emitter?: RawInputEmitter;
  forwardDeleteRef: MutableRefObject<boolean>;
  isStreamingRef: MutableRefObject<boolean>;
  pastesRef: MutableRefObject<Map<number, PasteEntry>>;
  pendingPermissionRef: MutableRefObject<unknown>;
  setComposer: Dispatch<SetStateAction<ComposerState>>;
  terminalFocusedRef: MutableRefObject<boolean>;
}): void {
  const {
    emitter,
    forwardDeleteRef,
    isStreamingRef,
    pastesRef,
    pendingPermissionRef,
    setComposer,
    terminalFocusedRef,
  } = opts;
  useEffect(() => {
    if (!emitter) return;
    const onInput = (chunk: Buffer | string): void => {
      const input = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (input.includes("\x1b[I") || input.includes("\u009bI")) {
        terminalFocusedRef.current = true;
      }
      if (input.includes("\x1b[O") || input.includes("\u009bO")) {
        terminalFocusedRef.current = false;
      }
      if (pendingPermissionRef.current || isStreamingRef.current) return;
      if (["\x1b[H", "\x1b[1~", "\x1b[7~", "\x1bOH"].includes(input)) {
        setComposer(composerHome);
        return;
      }
      if (["\x1b[F", "\x1b[4~", "\x1b[8~", "\x1bOF"].includes(input)) {
        setComposer(composerEnd);
        return;
      }
      if (input === "\x1b[3~") {
        forwardDeleteRef.current = true;
        setComposer((previous) =>
          composerForwardDelete(previous, pastesRef.current),
        );
      }
    };
    emitter.prependListener("input", onInput);
    return () => {
      emitter.removeListener("input", onInput);
    };
  }, [
    emitter,
    forwardDeleteRef,
    isStreamingRef,
    pastesRef,
    pendingPermissionRef,
    setComposer,
    terminalFocusedRef,
  ]);
}

export function useComposerInput(opts: {
  composer: ComposerState;
  cwd: string;
  draftRef: MutableRefObject<string>;
  forwardDeleteRef: MutableRefObject<boolean>;
  historyPosRef: MutableRefObject<number | null>;
  historyQueryRef: MutableRefObject<string>;
  inputHistoryRef: MutableRefObject<string[]>;
  pasteCounterRef: MutableRefObject<number>;
  pastesRef: MutableRefObject<Map<number, PasteEntry>>;
  disabled: boolean;
  onEditorError: (message: string) => void;
  setComposer: Dispatch<SetStateAction<ComposerState>>;
  skillNames: () => Iterable<string>;
  fileMentions: readonly string[];
  submit: (value: string) => Promise<void>;
}): void {
  const composerRef = useRef(opts.composer);
  const rapidRunRef = useRef<RapidInputRun | null>(null);
  const activeBurstRef = useRef<{
    entry: PasteEntry;
    id: number;
    initialLabel: string;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  composerRef.current = opts.composer;

  const finishActiveBurst = (): void => {
    const active = activeBurstRef.current;
    if (!active) return;
    clearTimeout(active.timer);
    const nextLabel = placeholderLabel(active.entry, active.id);
    const next = replaceComposerText(
      composerRef.current,
      active.initialLabel,
      nextLabel,
    );
    composerRef.current = next;
    opts.setComposer(next);
    activeBurstRef.current = null;
  };

  const extendActiveBurst = (fragment: string): void => {
    const active = activeBurstRef.current;
    if (!active) return;
    active.entry.content += fragment;
    clearTimeout(active.timer);
    active.timer = setTimeout(finishActiveBurst, 30);
  };

  useEffect(
    () => () => {
      const active = activeBurstRef.current;
      if (active) clearTimeout(active.timer);
    },
    [],
  );

  useInput((inputChar, key) => {
    if (opts.disabled) return;
    if (isTerminalFocusReport(inputChar)) return;

    if (isSubmitInput(inputChar, key.return)) {
      if (activeBurstRef.current) {
        extendActiveBurst("\n");
        return;
      }
      const now = performance.now();
      const rapid = rapidRunRef.current;
      if (qualifiesAsPasteBurst(rapid, now)) {
        const id = ++opts.pasteCounterRef.current;
        const entry = classifyPaste(`${rapid.text}\n`, opts.cwd);
        opts.pastesRef.current.set(id, entry);
        const initialLabel = placeholderLabel(entry, id);
        const next = composerInsert(rapid.startState, initialLabel);
        composerRef.current = next;
        opts.setComposer(next);
        activeBurstRef.current = {
          entry,
          id,
          initialLabel,
          timer: setTimeout(finishActiveBurst, 30),
        };
        rapidRunRef.current = null;
        return;
      }
      rapidRunRef.current = null;
      void opts.submit(composerRef.current.value);
      return;
    }

    const plainFragment =
      !key.ctrl && !key.meta ? normalizeComposerValue(inputChar) : "";
    if (activeBurstRef.current && plainFragment.length > 0) {
      extendActiveBurst(plainFragment);
      return;
    }
    if (activeBurstRef.current) finishActiveBurst();

    if (key.tab) {
      const suggestion = getCompletionSuggestion(
        opts.composer.value,
        opts.composer.cursor,
        opts.skillNames(),
        opts.fileMentions,
      );
      if (suggestion.length > 0) {
        opts.setComposer((previous) => composerInsert(previous, suggestion));
      }
      return;
    }

    if (key.ctrl) {
      const character = inputChar.toLowerCase();
      if (character === "g") {
        void openExternalEditor(opts.composer.value, opts.cwd)
          .then((value) =>
            opts.setComposer({ value, cursor: [...value].length }),
          )
          .catch((error: unknown) =>
            opts.onEditorError(
              error instanceof Error ? error.message : String(error),
            ),
          );
        return;
      }
      if (character === "r") {
        opts.setComposer((previous) => {
          const history = opts.inputHistoryRef.current;
          if (opts.historyPosRef.current === null) {
            opts.draftRef.current = previous.value;
            opts.historyQueryRef.current = previous.value;
          }
          const match = findHistoryMatch(
            history,
            opts.historyQueryRef.current,
            opts.historyPosRef.current ?? history.length,
          );
          if (match === null) return previous;
          opts.historyPosRef.current = match;
          const recalled = history[match] ?? "";
          return { value: recalled, cursor: [...recalled].length };
        });
        return;
      }
      if (character === "a") {
        opts.setComposer(composerHome);
        return;
      }
      if (character === "e") {
        opts.setComposer(composerEnd);
        return;
      }
      if (character === "w") {
        opts.setComposer((previous) =>
          composerDeleteWord(previous, opts.pastesRef.current),
        );
        return;
      }
      return;
    }
    if (key.meta) return;

    if (key.leftArrow) {
      opts.setComposer(composerMoveLeft);
      return;
    }
    if (key.rightArrow) {
      opts.setComposer(composerMoveRight);
      return;
    }
    if (key.upArrow) {
      opts.setComposer((previous) => {
        const history = opts.inputHistoryRef.current;
        if (history.length === 0) return previous;
        if (opts.historyPosRef.current === null) {
          opts.draftRef.current = previous.value;
          opts.historyPosRef.current = history.length - 1;
        } else if (opts.historyPosRef.current > 0) {
          opts.historyPosRef.current -= 1;
        } else {
          return previous;
        }
        const recalled = history[opts.historyPosRef.current] ?? "";
        return { value: recalled, cursor: [...recalled].length };
      });
      return;
    }
    if (key.downArrow) {
      opts.setComposer((previous) => {
        if (opts.historyPosRef.current === null) return previous;
        const history = opts.inputHistoryRef.current;
        const next = opts.historyPosRef.current + 1;
        if (next >= history.length) {
          opts.historyPosRef.current = null;
          const draft = opts.draftRef.current;
          return { value: draft, cursor: [...draft].length };
        }
        opts.historyPosRef.current = next;
        const recalled = history[next] ?? "";
        return { value: recalled, cursor: [...recalled].length };
      });
      return;
    }

    if (key.backspace || key.delete) {
      if (opts.forwardDeleteRef.current) {
        opts.forwardDeleteRef.current = false;
        return;
      }
      opts.setComposer((previous) =>
        composerBackspace(previous, opts.pastesRef.current),
      );
      return;
    }
    if (key.escape) {
      opts.setComposer({ value: "", cursor: 0 });
      opts.pastesRef.current.clear();
      opts.historyPosRef.current = null;
      opts.historyQueryRef.current = "";
      opts.draftRef.current = "";
      return;
    }
    if (detectPaste(inputChar)) {
      const id = ++opts.pasteCounterRef.current;
      const entry = classifyPaste(inputChar, opts.cwd);
      opts.pastesRef.current.set(id, entry);
      opts.setComposer((previous) =>
        composerInsert(previous, placeholderLabel(entry, id)),
      );
      return;
    }
    const fragment = normalizeComposerValue(inputChar);
    if (fragment.length > 0) {
      const previous = composerRef.current;
      rapidRunRef.current = extendRapidRun(
        rapidRunRef.current,
        fragment,
        performance.now(),
        previous,
      );
      const next = composerInsert(previous, fragment);
      composerRef.current = next;
      opts.setComposer(next);
    }
  });
}
