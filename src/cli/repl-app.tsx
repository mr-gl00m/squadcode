import { Box, Static, Text, useApp, useInput, useStdin, useStdout } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { killAgent } from "../agents/kill.js";
import { SteeringQueue } from "../engine/steering-queue.js";
import { guardPermissionRequest } from "../guardian.js";
import { logger } from "../logger.js";
import { loadOutputStyles, type OutputStyle } from "../output-styles.js";
import { loadUserGlobalRules, persistUserRule } from "../permissions/global.js";
import type { Mode } from "../permissions/plan.js";
import type { PolicyConfig, RuleMap } from "../permissions/policy.js";
import {
  loadProjectRules,
  persistProjectRule,
} from "../permissions/project.js";
import type { PromptOutcome, PromptRequest } from "../permissions/prompt.js";
import type { CanonicalMessage, LLMProvider } from "../providers/types.js";
import { formatRecapFromMessages } from "../sessions/recap.js";
import { TurnDiffTracker } from "../sessions/trajectory-diff.js";
import { loadSkills, type SkillEntry } from "../skills.js";
import { sanitizeForTerminal } from "../terminal.js";
import type { TodoItem } from "../tools/todo.js";
import type { YoloSession } from "../yolo/index.js";
import { AgentPanel, KillPicker } from "./agent-panel.js";
import {
  cycleFocus,
  emptyPanelState,
  killPickerTarget,
  liveCards,
  reducePanels,
} from "./agent-panel-state.js";
import { BANNER, bannerSubtitle } from "./banner.js";
import { appendInputHistory, loadInputHistory } from "./input-history.js";
import { usePermissionNotification } from "./permission-notification.js";
import { useReplBacktrack } from "./repl-backtrack.js";
import {
  ComposerLine,
  type ComposerState,
  getCompletionSuggestion,
  type PasteEntry,
} from "./repl-composer.js";
import { useComposerInput, useRawComposerInput } from "./repl-input.js";
import { usePermissionInput } from "./repl-permissions.js";
import {
  ActivityRow,
  BacktrackOverlay,
  HistoryRow,
  PermissionOverlay,
  StatusFooter,
  TodoPanel,
  ToolLedgerView,
} from "./repl-presentation.js";
import { createReplSlashContext } from "./repl-slash-context.js";
import { createSubmitHandler } from "./repl-submit.js";
import { useToolView } from "./repl-tool-view.js";
import { createReplTurnController } from "./repl-turn-controller.js";
import {
  type ActivityState,
  buildInitialHistory,
  type HistoryEntry,
  type ReplControl,
  type ReplOptions,
  snapshotTodos,
} from "./repl-types.js";

const ACCENT = "#7aa2f7";
const VERSION = "1.9.1";

export function ReplApp(opts: ReplOptions): React.JSX.Element {
  const {
    providerName,
    model,
    registry,
    policy,
    cwd,
    systemPrompt,
    buildProvider,
    store,
    sessionId,
    metadata,
    allowProjectPersist,
    hookRunner,
    yolo: initialYolo,
    allowDeletes,
    jobs,
    timers,
    diagnostics,
  } = opts;

  // Subagent panel state (howl-driven) and the Ctrl+K kill-picker overlay.
  const [panelState, setPanelState] = useState(() =>
    emptyPanelState(opts.slotRegistry?.maxSlots ?? 4),
  );
  const [killPickerOpen, setKillPickerOpen] = useState(false);
  const { exit } = useApp();
  const yoloRef = useRef<YoloSession | null>(initialYolo);
  const [yoloOn, setYoloOn] = useState<boolean>(initialYolo !== null);
  const [modeState, setModeState] = useState<Mode>(policy.mode);
  const systemPromptRef = useRef<string>(systemPrompt);
  const policyRef = useRef<PolicyConfig>(policy);
  const basePolicyRef = useRef<PolicyConfig>({
    ...policy,
    dangerouslySkipPermissions: false,
  });
  const initialHistory = buildInitialHistory(opts);
  const [history, setHistory] = useState<HistoryEntry[]>(initialHistory);
  const [streamingText, setStreamingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [composer, setComposer] = useState<ComposerState>({
    value: "",
    cursor: 0,
  });
  const [activity, setActivity] = useState<ActivityState>({
    kind: "idle",
    label: "",
  });
  const [activityTick, setActivityTick] = useState(0);
  const [bulletOn, setBulletOn] = useState(true);
  const [resizeNonce, setResizeNonce] = useState(0);
  const [todos, setTodos] = useState<TodoItem[]>(() =>
    snapshotTodos(registry.todoState.items),
  );
  const [providerNameState, setProviderName] = useState(providerName);
  const [modelState, setModel] = useState(model);
  const [turnCount, setTurnCount] = useState(metadata.turnCount);
  const [totalTokens, setTotalTokens] = useState(metadata.totalTokens);
  const [lastTurnTokens, setLastTurnTokens] = useState(0);
  const [totalCachedTokens, setTotalCachedTokens] = useState(0);
  const [lastTurnCachedTokens, setLastTurnCachedTokens] = useState(0);
  const [totalInputTokens, setTotalInputTokens] = useState(0);
  const [totalOutputTokens, setTotalOutputTokens] = useState(0);
  const [lastTurnInputTokens, setLastTurnInputTokens] = useState(0);
  const [lastTurnOutputTokens, setLastTurnOutputTokens] = useState(0);
  const [totalCost, setTotalCost] = useState(0);
  const [lastTurnCost, setLastTurnCost] = useState(0);

  const messagesRef = useRef<CanonicalMessage[]>([...opts.messages]);
  const turnDiffRef = useRef(new TurnDiffTracker({ cwd }));
  const steeringQueueRef = useRef(new SteeringQueue());
  const terminalFocusedRef = useRef(true);
  // Stable handoff to runInkRepl for /resume. A ref (not opts.control directly)
  // keeps it out of the submit callback's dependency list — it's a constant for
  // the mount anyway.
  const controlRef = useRef<ReplControl | undefined>(opts.control);
  const sessionRulesRef = useRef<RuleMap>(new Map());
  const projectRulesRef = useRef<RuleMap>(new Map());
  const userGlobalRulesRef = useRef<RuleMap>(new Map());
  const providerRef = useRef<LLMProvider>(opts.provider);
  const abortRef = useRef<AbortController | null>(null);
  const idRef = useRef(initialHistory.length);
  const pastesRef = useRef<Map<number, PasteEntry>>(new Map());
  const pasteCounterRef = useRef(0);
  const inputHistoryRef = useRef<string[]>([]);
  const historyPosRef = useRef<number | null>(null);
  const historyQueryRef = useRef("");
  const draftRef = useRef<string>("");
  const forwardDeleteRef = useRef(false);
  const pendingPermissionRef = useRef<unknown>(null);
  const isStreamingRef = useRef(false);
  const argBytesRef = useRef<{ id: string; bytes: number } | null>(null);
  const skillsRef = useRef<Map<string, SkillEntry>>(new Map());
  const outputStylesRef = useRef<Map<string, OutputStyle>>(new Map());
  const [activeStyle, setActiveStyle] = useState<OutputStyle | null>(null);
  const { internal_eventEmitter: stdinEmitter } = useStdin();
  const { stdout } = useStdout();
  const [pendingPermission, setPendingPermission] = useState<{
    req: PromptRequest;
    resolve: (outcome: PromptOutcome) => void;
  } | null>(null);
  const permissionNotification = usePermissionNotification({
    ...(stdout && { stdout }),
    pending: pendingPermission !== null,
    activityKind: activity.kind,
    initialSoundEnabled: opts.notifications.permissionSound,
  });
  useEffect(() => {
    let active = true;
    void loadInputHistory().then((loaded) => {
      if (!active) return;
      const current = inputHistoryRef.current;
      inputHistoryRef.current = [...loaded, ...current].slice(-500);
    });
    return () => {
      active = false;
    };
  }, []);
  const backtrack = useReplBacktrack({
    disabled: isStreaming || pendingPermission !== null,
    sessionId,
    store,
    header: initialHistory[0] as HistoryEntry,
    messagesRef,
    idRef,
    turnDiff: turnDiffRef.current,
    setHistory,
    setTurnCount,
    setTotalTokens,
  });

  const append = useCallback(
    (kind: HistoryEntry["kind"], text: string): void => {
      setHistory((prev) => [
        ...prev,
        { id: idRef.current++, kind, text: sanitizeForTerminal(text) },
      ]);
    },
    [],
  );

  const appendAssistantBlock = useCallback((block: string): void => {
    // Split a reflow-produced block into individual line entries so each
    // line stacks naturally in <Static>. A string that ends with "\n" has
    // a trailing empty from split() — that empty is the line terminator
    // of the last line, not a blank line, so drop it. "\n\n" produces one
    // intentional empty mid-list, which renders as one blank row.
    const lines = block.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    if (lines.length === 0) return;
    setHistory((prev) => [
      ...prev,
      ...lines.map((text) => ({
        id: idRef.current++,
        kind: "assistant" as const,
        text: sanitizeForTerminal(text),
      })),
    ]);
  }, []);

  const updateTodos = useCallback((): void => {
    setTodos(snapshotTodos(registry.todoState.items));
  }, [registry]);

  const slashCtx = createReplSlashContext({
    activeStyle,
    basePolicyRef,
    baseSystemPrompt: opts.baseSystemPrompt,
    buildProvider,
    clearConversation: () => {
      messagesRef.current.length = 0;
      sessionRulesRef.current.clear();
      idRef.current = 1;
      setHistory([
        {
          id: 0,
          kind: "header",
          text: BANNER,
          subtitle: bannerSubtitle(VERSION, providerNameState, modelState),
        },
      ]);
      stdout?.write("\x1b[2J\x1b[3J\x1b[H");
      setResizeNonce((nonce) => nonce + 1);
    },
    cwd,
    metadata,
    messagesRef,
    model: modelState,
    outputStylesRef,
    policyRef,
    providerName: providerNameState,
    providerRef,
    registry,
    sessionId,
    sessionRulesRef,
    setActiveStyle,
    setMode: setModeState,
    setModel,
    setProviderName,
    setYoloOn,
    notificationSoundEnabled: permissionNotification.soundEnabled,
    setNotificationSound: permissionNotification.setSoundEnabled,
    skillsRef,
    store,
    systemPromptRef,
    totalCachedTokens,
    totalCost,
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    lastTurnCachedTokens,
    lastTurnCost,
    lastTurnInputTokens,
    lastTurnOutputTokens,
    lastTurnTokens,
    turnCount,
    turnDiff: () => turnDiffRef.current.render(),
    yoloRef,
    ...(opts.guardian && { guardian: opts.guardian }),
  });

  usePermissionInput({
    abortRef,
    allowProjectPersist,
    append,
    ...(opts.controllers && { controllers: opts.controllers }),
    exit,
    isStreaming,
    pendingPermission,
    setActivity,
    setPendingPermission,
    ...(opts.slotRegistry && { slotRegistry: opts.slotRegistry }),
  });

  const askPermission = useCallback(
    async (req: PromptRequest): Promise<PromptOutcome> => {
      const guardedReq = await guardPermissionRequest(opts.guardian, req);
      return await new Promise<PromptOutcome>((resolve) => {
        setActivity({
          kind: "tool",
          label: `Awaiting permission for ${req.toolName}`,
          toolName: req.toolName,
        });
        setPendingPermission({
          req: guardedReq,
          resolve: (outcome) => {
            store.recordPermissionDecision(sessionId, {
              tool: req.toolName,
              callId: req.callId,
              outcome,
            });
            if (outcome === "always-project" && allowProjectPersist) {
              (async () => {
                for (const pattern of req.scopePatterns) {
                  await persistProjectRule(cwd, req.toolName, pattern, "allow");
                }
              })().catch((err: unknown) => {
                logger.warn(
                  { err: err instanceof Error ? err.message : String(err) },
                  "failed to persist project permission",
                );
              });
            }
            if (outcome === "always-user") {
              (async () => {
                for (const pattern of req.scopePatterns) {
                  await persistUserRule(req.toolName, pattern, "allow");
                }
              })().catch((err: unknown) => {
                logger.warn(
                  { err: err instanceof Error ? err.message : String(err) },
                  "failed to persist user-global permission",
                );
              });
            }
            resolve(outcome);
          },
        });
      });
    },
    [sessionId, store, cwd, allowProjectPersist, opts.guardian],
  );

  // Fold HOWL lifecycle/anguish/roster batches into panel state. No-op when the
  // session wired no agent runtime.
  useEffect(() => {
    const howl = opts.howl;
    if (!howl) return;
    return howl.subscribe((batch) => {
      setPanelState((s) => reducePanels(s, batch));
    });
  }, [opts.howl]);

  // Route subagent permission requests through this REPL's overlay, carrying the
  // source-agent metadata the bus stamped on the request.
  useEffect(() => {
    opts.setAgentResponder?.((env) => askPermission(env.request));
  }, [askPermission, opts.setAgentResponder]);

  // Dedicated agent-panel controls. Fires regardless of isStreaming — a subagent
  // runs while the main loop is blocked on the Agent tool, so the composer input
  // hook is dormant and there's no Tab/Ctrl-K conflict. Guarded on live
  // subagents (or an open picker), so an ordinary session is unaffected: Tab and
  // Ctrl-K keep their normal meaning until a subagent is actually running.
  useInput((inputChar, key) => {
    if (pendingPermission) return;
    if (killPickerOpen) {
      if (key.escape) {
        setKillPickerOpen(false);
        return;
      }
      const target = killPickerTarget(panelState, inputChar);
      if (target.action === "kill" && opts.slotRegistry && opts.controllers) {
        killAgent(opts.slotRegistry, opts.controllers, target.agentId);
        append("system", `killed subagent ${target.agentId}`);
        setKillPickerOpen(false);
      } else if (target.action === "cancel") {
        setKillPickerOpen(false);
      }
      return;
    }
    if (liveCards(panelState).length === 0) return;
    if (key.ctrl && inputChar === "k") {
      setKillPickerOpen(true);
      return;
    }
    if (key.tab) {
      setPanelState((s) => cycleFocus(s, key.shift ? "prev" : "next"));
    }
  });

  const { ledger, setLedger, viewMode, viewModeRef } = useToolView({
    append,
    disabled: pendingPermission !== null || backtrack.open || killPickerOpen,
    isStreaming,
  });

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadSkills(cwd)
      .then((map) => {
        if (cancelled) return;
        skillsRef.current = map;
        if (map.size > 0) {
          append(
            "system",
            `loaded ${map.size} skill${map.size === 1 ? "" : "s"} (type /skills to list)`,
          );
        }
      })
      .catch((err: unknown) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "skill loading failed",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, append]);

  useEffect(() => {
    let cancelled = false;
    loadOutputStyles(cwd)
      .then((map) => {
        if (cancelled) return;
        outputStylesRef.current = map;
        if (map.size > 0) {
          append(
            "system",
            `loaded ${map.size} output style${map.size === 1 ? "" : "s"} (type /output-style to list)`,
          );
        }
      })
      .catch((err: unknown) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "output style loading failed",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, append]);

  useEffect(() => {
    if (!allowProjectPersist) return;
    let cancelled = false;
    loadProjectRules(cwd)
      .then((map) => {
        if (cancelled) return;
        projectRulesRef.current = map;
        if (map.size > 0) {
          const total = Array.from(map.values()).reduce(
            (n, list) => n + list.length,
            0,
          );
          append(
            "system",
            `project permissions loaded: ${total} rule${total === 1 ? "" : "s"} across ${map.size} tool${map.size === 1 ? "" : "s"} (from .squad/settings.json)`,
          );
        }
      })
      .catch((err: unknown) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "project permission loading failed",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, append, allowProjectPersist]);

  useEffect(() => {
    let cancelled = false;
    loadUserGlobalRules()
      .then((map) => {
        if (cancelled) return;
        userGlobalRulesRef.current = map;
        if (map.size > 0) {
          const total = Array.from(map.values()).reduce(
            (n, list) => n + list.length,
            0,
          );
          append(
            "system",
            `user-global permissions loaded: ${total} rule${total === 1 ? "" : "s"} across ${map.size} tool${map.size === 1 ? "" : "s"} (from ~/.squad/permissions.json)`,
          );
        }
      })
      .catch((err: unknown) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "user-global permission loading failed",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [append]);

  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => {
      // On resize: erase the visible screen, erase the scrollback (so orphan
      // composer borders in the back-buffer don't haunt later scrolling),
      // home the cursor, and bump a nonce that we use as the <Static> key —
      // remounting Static resets its internal "seen" index so all history
      // items re-emit on the next render, restoring what the scrollback wipe
      // just removed. There's a single-frame flicker; resize is rare enough
      // that it doesn't matter.
      stdout.write("\x1b[2J\x1b[3J\x1b[H");
      setResizeNonce((n) => n + 1);
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  useEffect(() => {
    if (!isStreaming && !pendingPermission) return;
    const timer = setInterval(() => {
      setActivityTick((tick) => (tick + 1) % 4);
    }, 350);
    return () => clearInterval(timer);
  }, [isStreaming, pendingPermission]);

  useEffect(() => {
    if (!isStreaming && !pendingPermission) {
      setBulletOn(true);
      return;
    }
    const blink = setInterval(() => setBulletOn((v) => !v), 500);
    return () => clearInterval(blink);
  }, [isStreaming, pendingPermission]);

  useEffect(() => {
    pendingPermissionRef.current = pendingPermission;
  }, [pendingPermission]);
  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  // Idle-recap timer. Fires `recapIdleMinutes` after the last activity,
  // emits the current recap into the transcript so the user (re-) orients
  // when they've been away from the terminal. Setting recapIdleMinutes to
  // 0 disables. `bumpIdle` is called from submit() and after each turn.
  const idleTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastRecapSignatureRef = useRef<string>("");
  const bumpIdle = useCallback((): void => {
    if (opts.recapIdleMinutes <= 0) return;
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    const ms = opts.recapIdleMinutes * 60_000;
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null;
      // Skip if nothing has changed since the last auto-recap — no point
      // re-emitting the same text every idle window.
      const signature = `${messagesRef.current.length}:${turnCount}`;
      if (signature === lastRecapSignatureRef.current) return;
      lastRecapSignatureRef.current = signature;
      const usage = store.usageTotals({ sessionId });
      const text = formatRecapFromMessages({
        metadata: {
          ...metadata,
          turnCount,
          totalTokens,
          provider: providerNameState,
          model: modelState,
        },
        messages: messagesRef.current,
        usage,
      });
      append(
        "system",
        `(idle ${opts.recapIdleMinutes}m — auto-recap)\n\n${text}`,
      );
    }, ms);
  }, [
    opts.recapIdleMinutes,
    metadata,
    sessionId,
    store,
    turnCount,
    totalTokens,
    providerNameState,
    modelState,
    append,
  ]);

  useEffect(() => {
    bumpIdle();
    return () => {
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
  }, [bumpIdle]);

  useRawComposerInput({
    emitter: stdinEmitter,
    forwardDeleteRef,
    isStreamingRef,
    pastesRef,
    pendingPermissionRef,
    setComposer,
    terminalFocusedRef,
  });

  const { runCompact, runUserTurn } = createReplTurnController({
    activeStyle,
    allowDeletes,
    append,
    appendAssistantBlock,
    askPermission,
    bumpIdle,
    cwd,
    ...(diagnostics && { diagnostics }),
    hookRunner,
    ...(jobs && { jobs }),
    model: modelState,
    notifications: opts.notifications,
    providerName: providerNameState,
    registry,
    sessionId,
    store,
    steeringQueue: steeringQueueRef.current,
    ...(timers && { timers }),
    turnDiff: turnDiffRef.current,
    turnNumber: turnCount + 1,
    updateTodos,
    viewModeRef,
    setLedger,
    isTerminalFocused: () => terminalFocusedRef.current,
    ...(stdout && { writeTerminal: (value: string) => stdout.write(value) }),
    abortRef,
    argBytesRef,
    messagesRef,
    policyRef,
    projectRulesRef,
    providerRef,
    sessionRulesRef,
    systemPromptRef,
    userGlobalRulesRef,
    yoloRef,
    setActivity,
    setIsStreaming,
    setLastTurnCachedTokens,
    setLastTurnCost,
    setLastTurnInputTokens,
    setLastTurnOutputTokens,
    setLastTurnTokens,
    setStreamingText,
    setTotalCachedTokens,
    setTotalCost,
    setTotalInputTokens,
    setTotalOutputTokens,
    setTotalTokens,
    setTurnCount,
  });
  const submit = createSubmitHandler({
    append,
    bumpIdle,
    cwd,
    controlRef,
    draftRef,
    exit,
    historyPosRef,
    idRef,
    inputHistoryRef,
    fileMentions: opts.fileMentions ?? [],
    recordHistory: appendInputHistory,
    isStreaming,
    pastesRef,
    runCompact,
    runUserTurn,
    setComposer,
    setHistory,
    skillsRef,
    slashContext: slashCtx,
    steeringQueue: steeringQueueRef.current,
  });
  useComposerInput({
    composer,
    cwd,
    draftRef,
    forwardDeleteRef,
    historyPosRef,
    historyQueryRef,
    inputHistoryRef,
    fileMentions: opts.fileMentions ?? [],
    onEditorError: (message: string) => append("error", message),
    pasteCounterRef,
    pastesRef,
    disabled: pendingPermission !== null || backtrack.open,
    setComposer,
    skillNames: () => skillsRef.current.keys(),
    submit,
  });

  return (
    <Box flexDirection="column">
      <Static key={resizeNonce} items={history}>
        {(entry) => <HistoryRow key={entry.id} entry={entry} />}
      </Static>
      {isStreaming && streamingText.length > 0 ? (
        <Text wrap="wrap">{sanitizeForTerminal(streamingText)}</Text>
      ) : null}
      {panelState.cards.some((c) => c.live || c.status !== undefined) ? (
        <AgentPanel state={panelState} />
      ) : null}
      {killPickerOpen ? <KillPicker state={panelState} /> : null}
      {todos.length > 0 && todos.some((t) => t.status !== "completed") ? (
        <TodoPanel todos={todos} />
      ) : null}
      {isStreaming && viewMode === "compact" && ledger.length > 0 ? (
        <ToolLedgerView ledger={ledger} />
      ) : null}
      {isStreaming || pendingPermission ? (
        <ActivityRow
          activity={
            pendingPermission
              ? {
                  kind: "tool",
                  label: `Awaiting permission for ${pendingPermission.req.toolName}`,
                  toolName: pendingPermission.req.toolName,
                }
              : activity
          }
          tick={activityTick}
          bulletOn={bulletOn}
        />
      ) : null}
      {pendingPermission ? (
        <PermissionOverlay
          request={pendingPermission.req}
          allowProjectPersist={allowProjectPersist}
        />
      ) : backtrack.open ? (
        <BacktrackOverlay state={backtrack} />
      ) : (
        <Box borderStyle="round" borderColor={ACCENT} paddingX={1}>
          <ComposerLine
            value={composer.value}
            cursor={composer.cursor}
            suggestion={getCompletionSuggestion(
              composer.value,
              composer.cursor,
              skillsRef.current.keys(),
              opts.fileMentions ?? [],
            )}
          />
        </Box>
      )}
      <StatusFooter
        yoloOn={yoloOn}
        mode={modeState}
        provider={providerNameState}
        model={modelState}
        turnCount={turnCount}
        lastTurnInputTokens={lastTurnInputTokens}
        lastTurnCachedTokens={lastTurnCachedTokens}
        lastTurnOutputTokens={lastTurnOutputTokens}
        lastTurnCost={lastTurnCost}
        totalInputTokens={totalInputTokens}
        totalCachedTokens={totalCachedTokens}
        totalOutputTokens={totalOutputTokens}
        totalCost={totalCost}
        pendingPermission={pendingPermission !== null}
        isStreaming={isStreaming}
        viewMode={viewMode}
      />
    </Box>
  );
}
