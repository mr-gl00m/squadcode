import { existsSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve as resolvePath } from "node:path";
import {
  Box,
  Static,
  Text,
  render,
  useApp,
  useInput,
  useStdin,
  useStdout,
} from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { runAgentLoop } from "../engine/loop.js";
import type { HookRunner } from "../hooks/runner.js";
import { logger } from "../logger.js";
import type { PolicyConfig } from "../permissions/policy.js";
import {
  loadProjectRules,
  persistProjectRule,
} from "../permissions/project.js";
import type { RuleMap } from "../permissions/policy.js";
import type {
  PromptOutcome,
  PromptRequest,
} from "../permissions/prompt.js";
import type {
  CanonicalEvent,
  CanonicalMessage,
  CanonicalToolCall,
  LLMProvider,
} from "../providers/types.js";
import { makeOffloadLargeOutput } from "../sessions/artifacts.js";
import type { SessionStore } from "../sessions/store.js";
import type { SessionMetadata } from "../sessions/types.js";
import {
  calculateCost,
  formatCost,
  lookupContextWindow,
  lookupPricing,
  type ModelPricing,
} from "../pricing.js";
import {
  DEFAULT_TAIL_TURNS,
  STRUCTURED_SUMMARIZER_PROMPT,
  findTailStart,
  shouldAutoCompact,
} from "../engine/auto-compact.js";
import { updateDefaultSelection } from "../settings.js";
import {
  composeSystemPrompt,
  loadOutputStyles,
  type OutputStyle,
} from "../output-styles.js";
import {
  formatSkillForLLM,
  loadSkills,
  type SkillEntry,
  type SkillSource,
} from "../skills.js";
import { sanitizeForTerminal } from "../terminal.js";
import type { TodoItem } from "../tools/todo.js";
import type { ToolRegistry } from "../tools/registry.js";
import { findChecklist, checklistMissingMessage } from "../yolo/checklist.js";
import {
  createYoloSession,
  yoloSystemPromptAddendum,
  type YoloSession,
} from "../yolo/index.js";
import { BANNER, bannerSubtitle } from "./banner.js";
import { handleSlash, type SlashContext } from "./slash.js";
import { formatUsageReport } from "./usage-format.js";
import { renderAssistantLine } from "./markdown.js";
import {
  BELL,
  CLEAR_TITLE_SEQUENCE,
  deriveTabTitle,
  tabTitleSequence,
} from "./tab-title.js";
import { AssistantTextReflow } from "./text-reflow.js";

const ACCENT = "#7aa2f7";
const SOFT_RED = "#f7768e";
const TOOL_GRAY = "#7a8294";
const USER_DIM = "#a89984";
const VERSION = "1.1.0";

export interface ReplOptions {
  provider: LLMProvider;
  providerName: string;
  model: string;
  registry: ToolRegistry;
  policy: PolicyConfig;
  cwd: string;
  systemPrompt: string;
  baseSystemPrompt: string;
  buildProvider: (name: string) => LLMProvider | string;
  store: SessionStore;
  sessionId: string;
  metadata: SessionMetadata;
  messages: CanonicalMessage[];
  resumed: boolean;
  allowProjectPersist: boolean;
  hookRunner: HookRunner;
  yolo: YoloSession | null;
}

interface HistoryEntry {
  id: number;
  kind:
    | "user"
    | "assistant"
    | "system"
    | "tool"
    | "error"
    | "header"
    | "skill";
  text: string;
  subtitle?: string;
  skillName?: string;
  skillSource?: SkillSource;
}

type ActivityState =
  | { kind: "idle"; label: "" }
  | { kind: "thinking" | "responding"; label: string }
  | { kind: "tool"; label: string; toolName: string };

function buildInitialHistory(opts: ReplOptions): HistoryEntry[] {
  const entries: HistoryEntry[] = [
    {
      id: 0,
      kind: "header",
      text: BANNER,
      subtitle: bannerSubtitle(VERSION, opts.providerName, opts.model),
    },
  ];
  if (opts.resumed) {
    entries.push({
      id: 1,
      kind: "system",
      text: `resumed session ${opts.sessionId.slice(0, 8)} with ${opts.messages.length} prior messages`,
    });
  }
  return entries;
}

function App(opts: ReplOptions): React.JSX.Element {
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
  } = opts;
  const { exit } = useApp();
  const yoloRef = useRef<YoloSession | null>(initialYolo);
  const [yoloOn, setYoloOn] = useState<boolean>(initialYolo !== null);
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
  const sessionRulesRef = useRef<RuleMap>(new Map());
  const projectRulesRef = useRef<RuleMap>(new Map());
  const providerRef = useRef<LLMProvider>(opts.provider);
  const abortRef = useRef<AbortController | null>(null);
  const idRef = useRef(initialHistory.length);
  const pastesRef = useRef<Map<number, PasteEntry>>(new Map());
  const pasteCounterRef = useRef(0);
  const inputHistoryRef = useRef<string[]>([]);
  const historyPosRef = useRef<number | null>(null);
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

  const append = useCallback((kind: HistoryEntry["kind"], text: string): void => {
    setHistory((prev) => [
      ...prev,
      { id: idRef.current++, kind, text: sanitizeForTerminal(text) },
    ]);
  }, []);

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

  const slashCtx: SlashContext = {
    get providerName() {
      return providerNameState;
    },
    get model() {
      return modelState;
    },
    setProvider: (name: string) => {
      const next = buildProvider(name);
      if (typeof next === "string") return next;
      providerRef.current = next;
      setProviderName(name);
      persistDefaultSelection(name, modelState);
      return null;
    },
    setModel: (name: string) => {
      setModel(name);
      persistDefaultSelection(providerNameState, name);
    },
    messageCount: () => messagesRef.current.length,
    skills: () => skillsRef.current,
    outputStyles: () => outputStylesRef.current,
    activeStyleName: () => activeStyle?.name ?? null,
    setStyle: (name: string) => {
      const next = outputStylesRef.current.get(name.toLowerCase());
      if (!next) {
        return `unknown output style "${name}"; run /output-style to list available`;
      }
      setActiveStyle(next);
      return null;
    },
    clearStyle: () => setActiveStyle(null),
    usageReport: (arg: string) => {
      const parsed = parseUsageArgs(arg);
      const filter: { sessionId?: string; cwd?: string; sinceIso?: string } = {};
      let scopeLabel: string;
      if (parsed.scope === "session") {
        filter.sessionId = sessionId;
        scopeLabel = `current session (${sessionId.slice(0, 8)})`;
      } else if (parsed.scope === "all") {
        scopeLabel = "all sessions";
      } else {
        filter.cwd = cwd;
        scopeLabel = `cwd ${cwd}`;
      }
      if (parsed.daysBack !== undefined) {
        const since = new Date(Date.now() - parsed.daysBack * 86_400_000);
        filter.sinceIso = since.toISOString();
        scopeLabel += `, last ${parsed.daysBack} day${parsed.daysBack === 1 ? "" : "s"}`;
      }
      const totals = store.usageTotals(filter);
      const byDay = store.usageByDay(filter, parsed.daysBack ?? 14);
      const byModel = store.usageByModel(filter);
      const bySession = store.usageBySession(filter, 10);
      const sessionTotals =
        parsed.scope === "session"
          ? undefined
          : store.usageTotals({ sessionId });
      return formatUsageReport(
        { totals, byDay, byModel, bySession },
        {
          scopeLabel,
          ...(parsed.daysBack !== undefined && { daysBack: parsed.daysBack }),
          ...(sessionTotals !== undefined && { thisSessionTotals: sessionTotals }),
        },
      );
    },
    costSummary: () => {
      const pricing = lookupPricing(providerNameState, modelState);
      const lines: string[] = [];
      const totalMissTokens = Math.max(0, totalInputTokens - totalCachedTokens);
      const lastMissTokens = Math.max(
        0,
        lastTurnInputTokens - lastTurnCachedTokens,
      );
      const totalHitPct = totalInputTokens > 0
        ? Math.round((totalCachedTokens / totalInputTokens) * 100)
        : 0;
      const lastHitPct = lastTurnInputTokens > 0
        ? Math.round((lastTurnCachedTokens / lastTurnInputTokens) * 100)
        : 0;
      lines.push(`provider/model:  ${providerNameState}/${modelState}`);
      lines.push(`turns:           ${turnCount}`);
      lines.push(
        `input (total):   ${totalInputTokens.toLocaleString()}  (hit ${totalCachedTokens.toLocaleString()} / miss ${totalMissTokens.toLocaleString()}, ${totalHitPct}% cached)`,
      );
      lines.push(`output (total):  ${totalOutputTokens.toLocaleString()}`);
      lines.push(
        `input (last):    ${lastTurnInputTokens.toLocaleString()}  (hit ${lastTurnCachedTokens.toLocaleString()} / miss ${lastMissTokens.toLocaleString()}, ${lastHitPct}% cached)`,
      );
      lines.push(`output (last):   ${lastTurnOutputTokens.toLocaleString()}`);
      lines.push(`tokens (total):  ${totalTokens.toLocaleString()}`);
      lines.push(`tokens (last):   ${lastTurnTokens.toLocaleString()}`);
      if (pricing) {
        lines.push(`cost (total):    ${formatCost(totalCost)}`);
        lines.push(`cost (last):     ${formatCost(lastTurnCost)}`);
      } else {
        lines.push(`cost:            (no pricing for ${providerNameState}/${modelState})`);
      }
      return lines.join("\n");
    },
    toolList: () => {
      const tools = registry.list();
      const lines = tools.map((t) => {
        const tag = t.isReadOnly ? "ro" : "rw";
        const perm = t.defaultPermission;
        const desc = t.description.length > 80 ? `${t.description.slice(0, 77)}...` : t.description;
        return `  ${t.name.padEnd(12)} [${tag}, ${perm}] — ${desc}`;
      });
      return `${tools.length} tool${tools.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
    },
    sessionList: () => {
      const recent = store.list({ cwd, limit: 10 });
      if (recent.length === 0) return `no sessions yet for ${cwd}`;
      const lines = recent.map((s) => {
        const id = s.sessionId.slice(0, 8);
        const when = s.updatedAt.replace("T", " ").slice(0, 19);
        const here = s.sessionId === sessionId ? " (current)" : "";
        return `  ${id}  ${when}  ${s.provider}/${s.model}  ${s.turnCount} turn${s.turnCount === 1 ? "" : "s"}${here}`;
      });
      return `recent sessions in ${cwd}:\n${lines.join("\n")}`;
    },
    clear: () => {
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
      setResizeNonce((n) => n + 1);
    },
    yoloStatus: () => {
      const y = yoloRef.current;
      if (y) {
        return `YOLO is ON. Sandbox=${cwd}. Archive=${y.archiveDir}. Checklist=${y.checklistPath ?? "(none)"}.`;
      }
      return "YOLO is OFF.";
    },
    toggleYolo: async () => {
      if (yoloRef.current) {
        yoloRef.current = null;
        systemPromptRef.current = opts.baseSystemPrompt;
        policyRef.current = basePolicyRef.current;
        setYoloOn(false);
        return "YOLO disarmed. Permission prompts are back on.";
      }
      const checklist = await findChecklist(cwd);
      if (!checklist) return checklistMissingMessage();
      const next = createYoloSession({ cwd, checklistPath: checklist.path });
      const addendum = `${yoloSystemPromptAddendum(next)}\n\n## Loaded checklist (${checklist.path})\n${checklist.contents}`;
      yoloRef.current = next;
      systemPromptRef.current = `${opts.baseSystemPrompt}\n\n${addendum}`;
      policyRef.current = {
        ...basePolicyRef.current,
        dangerouslySkipPermissions: true,
      };
      setYoloOn(true);
      return `YOLO armed. Sandbox=${cwd}. Archive=${next.archiveDir}. Checklist=${checklist.path}.`;
    },
  };

  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === "c") {
      if (pendingPermission) {
        pendingPermission.resolve("deny");
        setPendingPermission(null);
        setActivity({ kind: "thinking", label: "Resuming" });
        append("system", "permission denied (Ctrl-C)");
        return;
      }
      if (isStreaming && abortRef.current) {
        abortRef.current.abort();
        append("system", "aborted by Ctrl-C");
      } else {
        exit();
      }
      return;
    }

    if (pendingPermission) {
      const ch = inputChar.toLowerCase();
      if (ch === "y" || ch === "1") {
        pendingPermission.resolve("allow");
        setPendingPermission(null);
        setActivity({
          kind: "tool",
          label: `Running ${pendingPermission.req.toolName}`,
          toolName: pendingPermission.req.toolName,
        });
        append("system", `[${pendingPermission.req.toolName}] allowed`);
      } else if (ch === "a" || ch === "2") {
        pendingPermission.resolve("always-allow");
        setPendingPermission(null);
        setActivity({
          kind: "tool",
          label: `Running ${pendingPermission.req.toolName}`,
          toolName: pendingPermission.req.toolName,
        });
        append(
          "system",
          `[${pendingPermission.req.toolName}] always-allowed for this session`,
        );
      } else if (ch === "p" && allowProjectPersist) {
        pendingPermission.resolve("always-project");
        setPendingPermission(null);
        setActivity({
          kind: "tool",
          label: `Running ${pendingPermission.req.toolName}`,
          toolName: pendingPermission.req.toolName,
        });
        append(
          "system",
          `[${pendingPermission.req.toolName}] always-allowed for this project (saved to .squad/settings.json)`,
        );
      } else if (ch === "n" || ch === "3" || key.escape || key.return) {
        pendingPermission.resolve("deny");
        setPendingPermission(null);
        setActivity({ kind: "thinking", label: "Resuming" });
        append("system", `[${pendingPermission.req.toolName}] denied`);
      }
    }
  });

  const askPermission = useCallback(
    (req: PromptRequest): Promise<PromptOutcome> =>
      new Promise<PromptOutcome>((resolve) => {
        setActivity({
          kind: "tool",
          label: `Awaiting permission for ${req.toolName}`,
          toolName: req.toolName,
        });
        setPendingPermission({
          req,
          resolve: (outcome) => {
            store.recordPermissionDecision(sessionId, {
              tool: req.toolName,
              callId: req.callId,
              outcome,
            });
            if (outcome === "always-project" && allowProjectPersist) {
              persistProjectRule(
                cwd,
                req.toolName,
                req.scopePattern,
                "allow",
              ).catch((err: unknown) => {
                logger.warn(
                  { err: err instanceof Error ? err.message : String(err) },
                  "failed to persist project permission",
                );
              });
            }
            resolve(outcome);
          },
        });
      }),
    [sessionId, store, cwd, allowProjectPersist],
  );

  const runCompact = useCallback(async (): Promise<void> => {
    const before = messagesRef.current.length;
    if (before === 0) return;
    const tailStart = findTailStart(messagesRef.current, DEFAULT_TAIL_TURNS);
    const toSummarize = messagesRef.current.slice(0, tailStart);
    const tail = messagesRef.current.slice(tailStart);
    if (toSummarize.length === 0) {
      append(
        "system",
        `nothing to compact (only ${tail.length} message${tail.length === 1 ? "" : "s"} in protected tail)`,
      );
      return;
    }
    setIsStreaming(true);
    setActivity({ kind: "thinking", label: "Compacting" });
    try {
      const response = await providerRef.current.complete({
        model: modelState,
        system: STRUCTURED_SUMMARIZER_PROMPT,
        messages: [
          ...toSummarize,
          {
            role: "user",
            content:
              "Summarize the conversation above using the prescribed structure. Preserve every decision, file path, name, and current state.",
          },
        ],
      });
      const summary = response.text.trim() || "(empty summary)";
      messagesRef.current.length = 0;
      messagesRef.current.push({
        role: "assistant",
        content: `[Compacted summary of ${toSummarize.length} earlier message${toSummarize.length === 1 ? "" : "s"}; ${tail.length} recent message${tail.length === 1 ? "" : "s"} preserved]\n\n${summary}`,
      });
      messagesRef.current.push(...tail);
      setTotalTokens((t) => t + response.usage.totalTokens);
      setTotalInputTokens((i) => i + response.usage.inputTokens);
      setTotalOutputTokens((o) => o + response.usage.outputTokens);
      const compactCached = response.usage.cachedInputTokens ?? 0;
      if (compactCached > 0) {
        setTotalCachedTokens((c) => c + compactCached);
      }
      const compactPricing = lookupPricing(providerNameState, modelState);
      let compactCost = 0;
      if (compactPricing) {
        compactCost = calculateCost(
          compactPricing,
          response.usage.inputTokens,
          response.usage.outputTokens,
          response.usage.cachedInputTokens,
        );
        setTotalCost((c) => c + compactCost);
      }
      store.recordUsage({
        ts: new Date().toISOString(),
        sessionId,
        cwd,
        provider: providerNameState,
        model: modelState,
        inputTokens: response.usage.inputTokens,
        cachedInputTokens: compactCached,
        outputTokens: response.usage.outputTokens,
        totalTokens: response.usage.totalTokens,
        costUsd: compactCost,
        toolCalls: 0,
        slashCommand: "compact",
        source: "compact",
      });
      append(
        "system",
        `compacted ${toSummarize.length} → 1 (+ ${tail.length} preserved; cost: ${formatTokenCount(response.usage.totalTokens)} tokens)`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "compact failed");
      append("error", `compact failed: ${msg}`);
    } finally {
      setIsStreaming(false);
      setActivity({ kind: "idle", label: "" });
    }
  }, [append, modelState]);

  const runUserTurn = useCallback(
    async (llmContent: string, displayLabel: string): Promise<void> => {
      append("user", displayLabel);
      messagesRef.current.push({ role: "user", content: llmContent });
      try {
        await store.appendUserMessage(sessionId, llmContent);
      } catch (err: unknown) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "session append (user) failed",
        );
      }
      try {
        await hookRunner.fire({
          event: "UserPromptSubmit",
          sessionId,
          cwd,
          prompt: llmContent,
        });
      } catch (err: unknown) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "UserPromptSubmit hook fire failed",
        );
      }

      const abort = new AbortController();
      abortRef.current = abort;
      setIsStreaming(true);
      setStreamingText("");
      setActivity({ kind: "thinking", label: "Thinking" });

      const turnStart = Date.now();
      const turnPricing: ModelPricing | null = lookupPricing(
        providerNameState,
        modelState,
      );
      let turnCost = 0;
      let turnCachedTokens = 0;
      let turnInputTokens = 0;
      let turnOutputTokens = 0;
      let turnToolCalls = 0;
      const buffers = {
        text: "",
        reasoning: "",
        pendingToolCalls: [] as CanonicalToolCall[],
        turnTokens: 0,
      };

      const reflow = new AssistantTextReflow();
      const effectiveSystemPrompt = composeSystemPrompt(
        activeStyle,
        systemPromptRef.current,
      );
      try {
        for await (const ev of runAgentLoop({
          provider: providerRef.current,
          model: modelState,
          ...(effectiveSystemPrompt !== undefined && {
            systemPrompt: effectiveSystemPrompt,
          }),
          messages: messagesRef.current,
          registry,
          policy: policyRef.current,
          cwd,
          abort: abort.signal,
          sessionRules: sessionRulesRef.current,
          projectRules: projectRulesRef.current,
          askPermission,
          offloadLargeOutput: makeOffloadLargeOutput({ sessionId }),
          hookRunner,
          sessionId,
          ...(yoloRef.current && { yolo: yoloRef.current }),
        })) {
          await persistEvent(store, sessionId, ev, buffers);
          switch (ev.type) {
            case "text_delta": {
              const completed = reflow.push(sanitizeForTerminal(ev.text));
              if (completed.length > 0) {
                appendAssistantBlock(completed);
              }
              setStreamingText(reflow.preview());
              setActivity((prev) =>
                prev.kind === "responding"
                  ? prev
                  : { kind: "responding", label: "Responding" },
              );
              break;
            }
            case "reasoning_delta":
              setActivity((prev) =>
                prev.kind === "thinking"
                  ? prev
                  : { kind: "thinking", label: "Thinking" },
              );
              break;
            case "tool_call_delta": {
              // Track args-buffer growth so the activity label updates on every
              // chunk. A frozen counter means the upstream stream is actually
              // stalled; a climbing counter means the model is just slow on a
              // large arg payload (Write with big content, etc).
              const tracked = argBytesRef.current;
              if (tracked && tracked.id === ev.id) {
                tracked.bytes += ev.argsDelta.length;
              } else {
                argBytesRef.current = { id: ev.id, bytes: ev.argsDelta.length };
              }
              const bytes = argBytesRef.current?.bytes ?? 0;
              setActivity((prev) => {
                if (prev.kind !== "tool") return prev;
                const label = `Preparing ${prev.toolName} (${formatBytes(bytes)})`;
                return prev.label === label ? prev : { ...prev, label };
              });
              break;
            }
            case "tool_call_start":
              {
                const remaining = reflow.flush();
                if (remaining) appendAssistantBlock(remaining);
                setStreamingText("");
              }
              argBytesRef.current = { id: ev.id, bytes: 0 };
              setActivity({
                kind: "tool",
                label: `Preparing ${ev.name}`,
                toolName: ev.name,
              });
              break;
            case "tool_call_done":
              argBytesRef.current = null;
              turnToolCalls += 1;
              setActivity({
                kind: "tool",
                label: `Running ${ev.name}`,
                toolName: ev.name,
              });
              append(
                "tool",
                `[${ev.name}] ${formatToolPreview(ev.name, ev.args)}`,
              );
              break;
            case "tool_result": {
              const tag = ev.ok
                ? "ok"
                : ev.reason === "denied"
                  ? "denied"
                  : ev.reason === "aborted"
                    ? "aborted"
                    : ev.reason === "unknown_tool"
                      ? "unknown"
                      : `failed${ev.error ? ` (${ev.error})` : ""}`;
              append(ev.ok ? "tool" : "error", `[${ev.name}] ${tag}`);
              if (ev.name === "TodoWrite") updateTodos();
              setActivity({ kind: "thinking", label: "Thinking" });
              break;
            }
            case "usage": {
              setTotalTokens((t) => t + ev.usage.totalTokens);
              turnInputTokens += ev.usage.inputTokens;
              turnOutputTokens += ev.usage.outputTokens;
              setTotalInputTokens((i) => i + ev.usage.inputTokens);
              setTotalOutputTokens((o) => o + ev.usage.outputTokens);
              const cached = ev.usage.cachedInputTokens ?? 0;
              if (cached > 0) {
                turnCachedTokens += cached;
                setTotalCachedTokens((c) => c + cached);
              }
              let usageRowCost = 0;
              if (turnPricing) {
                usageRowCost = calculateCost(
                  turnPricing,
                  ev.usage.inputTokens,
                  ev.usage.outputTokens,
                  ev.usage.cachedInputTokens,
                );
                turnCost += usageRowCost;
                setTotalCost((c) => c + usageRowCost);
              }
              store.recordUsage({
                ts: new Date().toISOString(),
                sessionId,
                cwd,
                provider: providerNameState,
                model: modelState,
                inputTokens: ev.usage.inputTokens,
                cachedInputTokens: cached,
                outputTokens: ev.usage.outputTokens,
                totalTokens: ev.usage.totalTokens,
                costUsd: usageRowCost,
                toolCalls: turnToolCalls,
                source: "turn",
              });
              break;
            }
            case "error":
              append("error", `${ev.code}: ${ev.message}`);
              setActivity({ kind: "idle", label: "" });
              break;
            case "done":
              {
                const remaining = reflow.flush();
                if (remaining) appendAssistantBlock(remaining);
                setStreamingText("");
              }
              setActivity({ kind: "idle", label: "" });
              break;
          }
        }
        store.bumpUsage(sessionId, 1, buffers.turnTokens);
        setTurnCount((t) => t + 1);
        setLastTurnTokens(buffers.turnTokens);
        setLastTurnCachedTokens(turnCachedTokens);
        setLastTurnInputTokens(turnInputTokens);
        setLastTurnOutputTokens(turnOutputTokens);
        setLastTurnCost(turnCost);
        const ctxWindow = lookupContextWindow(providerNameState, modelState);
        if (shouldAutoCompact(turnInputTokens, ctxWindow)) {
          append(
            "system",
            `auto-compact triggered: ${formatTokenCount(turnInputTokens)} of ${formatTokenCount(ctxWindow ?? 0)} context tokens used`,
          );
          await runCompact();
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg }, "repl turn failed");
        append("error", `turn failed: ${msg}`);
      } finally {
        try {
          await store.flush(sessionId);
        } catch (err: unknown) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "session flush failed",
          );
        }
        setIsStreaming(false);
        setStreamingText("");
        setActivity({ kind: "idle", label: "" });
        abortRef.current = null;
        append("system", `• Worked for ${formatElapsed(Date.now() - turnStart)}`);
      }
    },
    [
      append,
      askPermission,
      cwd,
      hookRunner,
      modelState,
      policy,
      providerNameState,
      registry,
      runCompact,
      sessionId,
      store,
      systemPrompt,
      updateTodos,
    ],
  );

  const submit = useCallback(
    async (rawValue: string): Promise<void> => {
      const trimmed = rawValue.trim();
      if (!trimmed) return;

      if (isLiteralSlashCommand(trimmed)) {
        setComposer({ value: "", cursor: 0 });
        pastesRef.current.clear();
        inputHistoryRef.current.push(trimmed);
        historyPosRef.current = null;
        draftRef.current = "";
        const result = handleSlash(trimmed, slashCtx);

        if (result.followup?.kind === "list-skills") {
          const list = Array.from(skillsRef.current.values()).sort((a, b) =>
            a.name.localeCompare(b.name),
          );
          if (list.length === 0) {
            append(
              "system",
              "no skills loaded (looked in ~/.codex/skills, ~/.claude/skills, and ./.squad/skills)",
            );
          } else {
            setHistory((prev) => [
              ...prev,
              {
                id: idRef.current++,
                kind: "system",
                text: `${list.length} skill${list.length === 1 ? "" : "s"}:`,
              },
              ...list.map((s) => ({
                id: idRef.current++,
                kind: "skill" as const,
                text:
                  s.description.length > 100
                    ? s.description.slice(0, 97) + "..."
                    : s.description,
                skillName: s.name,
                skillSource: s.source,
              })),
            ]);
          }
          return;
        }

        append("system", result.message);
        if (result.followup?.kind === "compact") {
          await runCompact();
          return;
        }
        if (result.followup?.kind === "skill") {
          const { skill, args } = result.followup;
          const llm = formatSkillForLLM(skill, args);
          const display = `(invoked /${skill.name}${args ? ` ${args}` : ""})`;
          await runUserTurn(llm, display);
          return;
        }
        if (result.followup?.kind === "yolo-toggle" && slashCtx.toggleYolo) {
          const msg = await slashCtx.toggleYolo();
          append("system", msg);
          return;
        }
        if (result.exit) {
          setTimeout(() => exit(), 0);
        }
        return;
      }

      const value = expandPastes(trimmed, pastesRef.current);
      pastesRef.current.clear();
      setComposer({ value: "", cursor: 0 });
      inputHistoryRef.current.push(trimmed);
      historyPosRef.current = null;
      draftRef.current = "";

      await runUserTurn(value, value);
    },
    [append, exit, runCompact, runUserTurn, slashCtx],
  );

  useInput((inputChar, key) => {
    if (pendingPermission || isStreaming) return;

    if (isSubmitInput(inputChar, key.return)) {
      void submit(composer.value);
      return;
    }

    if (key.tab) {
      const sugg = getCompletionSuggestion(
        composer.value,
        composer.cursor,
        skillsRef.current.keys(),
      );
      if (sugg.length > 0) {
        setComposer((prev) => composerInsert(prev, sugg));
      }
      return;
    }

    if (key.ctrl) {
      const ch = inputChar.toLowerCase();
      if (ch === "a") {
        setComposer(composerHome);
        return;
      }
      if (ch === "e") {
        setComposer(composerEnd);
        return;
      }
      if (ch === "w") {
        setComposer((prev) => composerDeleteWord(prev, pastesRef.current));
        return;
      }
      return;
    }
    if (key.meta) return;

    if (key.leftArrow) {
      setComposer(composerMoveLeft);
      return;
    }
    if (key.rightArrow) {
      setComposer(composerMoveRight);
      return;
    }
    if (key.upArrow) {
      setComposer((prev) => {
        const history = inputHistoryRef.current;
        if (history.length === 0) return prev;
        if (historyPosRef.current === null) {
          draftRef.current = prev.value;
          historyPosRef.current = history.length - 1;
        } else if (historyPosRef.current > 0) {
          historyPosRef.current -= 1;
        } else {
          return prev;
        }
        const recalled = history[historyPosRef.current] ?? "";
        return { value: recalled, cursor: [...recalled].length };
      });
      return;
    }
    if (key.downArrow) {
      setComposer((prev) => {
        if (historyPosRef.current === null) return prev;
        const history = inputHistoryRef.current;
        const next = historyPosRef.current + 1;
        if (next >= history.length) {
          historyPosRef.current = null;
          const draft = draftRef.current;
          return { value: draft, cursor: [...draft].length };
        }
        historyPosRef.current = next;
        const recalled = history[next] ?? "";
        return { value: recalled, cursor: [...recalled].length };
      });
      return;
    }

    if (key.backspace || key.delete) {
      if (forwardDeleteRef.current) {
        forwardDeleteRef.current = false;
        return;
      }
      setComposer((prev) => composerBackspace(prev, pastesRef.current));
      return;
    }
    if (key.escape) {
      setComposer({ value: "", cursor: 0 });
      pastesRef.current.clear();
      historyPosRef.current = null;
      draftRef.current = "";
      return;
    }
    if (detectPaste(inputChar)) {
      const id = ++pasteCounterRef.current;
      const entry = classifyPaste(inputChar, cwd);
      pastesRef.current.set(id, entry);
      setComposer((prev) =>
        composerInsert(prev, placeholderLabel(entry, id)),
      );
      return;
    }
    const fragment = normalizeComposerValue(inputChar);
    if (fragment.length > 0) {
      setComposer((prev) => composerInsert(prev, fragment));
    }
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

  const prevPendingPermissionRef = useRef(false);
  useEffect(() => {
    if (!stdout) return;
    const isPending = pendingPermission !== null;
    const title = deriveTabTitle({
      pendingPermission: isPending,
      activityKind: activity.kind,
    });
    const justEnteredPending =
      isPending && !prevPendingPermissionRef.current;
    prevPendingPermissionRef.current = isPending;
    stdout.write(tabTitleSequence(title));
    if (justEnteredPending) stdout.write(BELL);
  }, [activity.kind, pendingPermission, stdout]);

  useEffect(() => {
    return () => {
      if (stdout) stdout.write(CLEAR_TITLE_SEQUENCE);
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

  useEffect(() => {
    if (!stdinEmitter) return;
    const onInput = (chunk: Buffer | string): void => {
      if (pendingPermissionRef.current || isStreamingRef.current) return;
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (
        s === "\x1b[H" ||
        s === "\x1b[1~" ||
        s === "\x1b[7~" ||
        s === "\x1bOH"
      ) {
        setComposer(composerHome);
        return;
      }
      if (
        s === "\x1b[F" ||
        s === "\x1b[4~" ||
        s === "\x1b[8~" ||
        s === "\x1bOF"
      ) {
        setComposer(composerEnd);
        return;
      }
      if (s === "\x1b[3~") {
        forwardDeleteRef.current = true;
        setComposer((prev) => composerForwardDelete(prev, pastesRef.current));
      }
    };
    stdinEmitter.prependListener("input", onInput);
    return () => {
      stdinEmitter.removeListener("input", onInput);
    };
  }, [stdinEmitter]);

  return (
    <Box flexDirection="column">
      <Static key={resizeNonce} items={history}>
        {(entry) => <HistoryRow key={entry.id} entry={entry} />}
      </Static>
      {isStreaming && streamingText.length > 0 ? (
        <Text wrap="wrap">{sanitizeForTerminal(streamingText)}</Text>
      ) : null}
      {todos.length > 0 && todos.some((t) => t.status !== "completed") ? (
        <TodoPanel todos={todos} />
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
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={ACCENT}
          paddingX={1}
        >
          <Text bold color={ACCENT}>
            permission required: {sanitizeForTerminal(pendingPermission.req.toolName)}
          </Text>
          <Text dimColor>{sanitizeForTerminal(pendingPermission.req.argsPreview)}</Text>
          <Text>
            <Text color={ACCENT}>[y]</Text>es allow once  <Text color={ACCENT}>[a]</Text>lways for this session  {allowProjectPersist ? (
              <>
                <Text color={ACCENT}>[p]</Text>ermanently for this project
              </>
            ) : null}<Text color={ACCENT}>[n]</Text>o (default)
          </Text>
        </Box>
      ) : (
        <Box borderStyle="round" borderColor={ACCENT} paddingX={1}>
          <ComposerLine
            value={composer.value}
            cursor={composer.cursor}
            suggestion={getCompletionSuggestion(
              composer.value,
              composer.cursor,
              skillsRef.current.keys(),
            )}
          />
        </Box>
      )}
      <Box paddingLeft={1}>
        <Text dimColor>
          {yoloOn ? <Text color={SOFT_RED} bold>{"YOLO  ·  "}</Text> : null}
          {providerNameState}/{modelState}
          {"  ·  turns "}{turnCount}
          {lastTurnInputTokens > 0
            ? ` (last: in ${formatTokenCount(lastTurnInputTokens)}${lastTurnCachedTokens > 0 ? ` [${Math.round((lastTurnCachedTokens / lastTurnInputTokens) * 100)}% cached]` : ""} · out ${formatTokenCount(lastTurnOutputTokens)}${lastTurnCost > 0 ? ` · ~${formatCost(lastTurnCost)}` : ""})`
            : ""}
          {"  ·  total in "}{formatTokenCount(totalInputTokens)}
          {totalCachedTokens > 0 && totalInputTokens > 0
            ? ` [${Math.round((totalCachedTokens / totalInputTokens) * 100)}% cached]`
            : ""}
          {" · out "}{formatTokenCount(totalOutputTokens)}
          {totalCost > 0 ? `  ·  ~${formatCost(totalCost)} est` : ""}
          {pendingPermission
            ? "  ·  awaiting permission"
            : isStreaming
              ? "  ·  streaming (Ctrl-C aborts)"
              : ""}
        </Text>
      </Box>
    </Box>
  );
}

function snapshotTodos(items: TodoItem[]): TodoItem[] {
  return items.map((item) => ({ ...item }));
}

function persistDefaultSelection(providerName: string, model: string): void {
  updateDefaultSelection(providerName, model).catch((err: unknown) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "default model selection persist failed",
    );
  });
}

export function normalizeComposerValue(value: string): string {
  return value
    .replace(/\x1b?\[200~/g, "")
    .replace(/\x1b?\[201~/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s{2,}/g, " ");
}

export function isSubmitInput(inputChar: string, isReturn: boolean): boolean {
  return isReturn && (inputChar === "\r" || inputChar === "\n");
}

export const STREAM_BUFFER_CAP = 200;

export interface ComposerState {
  value: string;
  cursor: number;
}

export function composerInsert(
  state: ComposerState,
  insertion: string,
): ComposerState {
  if (insertion.length === 0) return state;
  const arr = [...state.value];
  const cursor = Math.max(0, Math.min(state.cursor, arr.length));
  const before = arr.slice(0, cursor).join("");
  const after = arr.slice(cursor).join("");
  return {
    value: before + insertion + after,
    cursor: cursor + [...insertion].length,
  };
}

export function composerBackspace(
  state: ComposerState,
  pastes?: Map<number, PasteEntry>,
): ComposerState {
  if (state.cursor === 0) return state;
  const arr = [...state.value];
  const cursor = Math.min(state.cursor, arr.length);
  const beforeStr = arr.slice(0, cursor).join("");
  const m = beforeStr.match(new RegExp(`${PLACEHOLDER_PATTERN_SOURCE}$`));
  if (m && m.index !== undefined) {
    const id = Number.parseInt(m[1] ?? "0", 10);
    pastes?.delete(id);
    const matchPoints = [...m[0]].length;
    return {
      value:
        arr.slice(0, cursor - matchPoints).join("") +
        arr.slice(cursor).join(""),
      cursor: cursor - matchPoints,
    };
  }
  return {
    value: arr.slice(0, cursor - 1).join("") + arr.slice(cursor).join(""),
    cursor: cursor - 1,
  };
}

export function composerForwardDelete(
  state: ComposerState,
  pastes?: Map<number, PasteEntry>,
): ComposerState {
  const arr = [...state.value];
  const cursor = Math.max(0, Math.min(state.cursor, arr.length));
  if (cursor >= arr.length) return state;
  const afterStr = arr.slice(cursor).join("");
  const m = afterStr.match(new RegExp(`^${PLACEHOLDER_PATTERN_SOURCE}`));
  if (m) {
    const id = Number.parseInt(m[1] ?? "0", 10);
    pastes?.delete(id);
    const matchPoints = [...m[0]].length;
    return {
      value:
        arr.slice(0, cursor).join("") +
        arr.slice(cursor + matchPoints).join(""),
      cursor,
    };
  }
  return {
    value: arr.slice(0, cursor).join("") + arr.slice(cursor + 1).join(""),
    cursor,
  };
}

export function composerDeleteWord(
  state: ComposerState,
  pastes?: Map<number, PasteEntry>,
): ComposerState {
  if (state.cursor === 0) return state;
  const arr = [...state.value];
  const cursor = Math.min(state.cursor, arr.length);
  const beforeStr = arr.slice(0, cursor).join("");
  const placeholder = beforeStr.match(
    new RegExp(`${PLACEHOLDER_PATTERN_SOURCE}$`),
  );
  if (placeholder && placeholder.index !== undefined) {
    const id = Number.parseInt(placeholder[1] ?? "0", 10);
    pastes?.delete(id);
    const matchPoints = [...placeholder[0]].length;
    return {
      value:
        arr.slice(0, cursor - matchPoints).join("") +
        arr.slice(cursor).join(""),
      cursor: cursor - matchPoints,
    };
  }
  let i = cursor;
  while (i > 0 && /\s/.test(arr[i - 1] ?? "")) i -= 1;
  while (i > 0 && !/\s/.test(arr[i - 1] ?? "")) i -= 1;
  return {
    value: arr.slice(0, i).join("") + arr.slice(cursor).join(""),
    cursor: i,
  };
}

export function composerMoveLeft(state: ComposerState): ComposerState {
  if (state.cursor === 0) return state;
  return { value: state.value, cursor: state.cursor - 1 };
}

export function composerMoveRight(state: ComposerState): ComposerState {
  const len = [...state.value].length;
  if (state.cursor >= len) return state;
  return { value: state.value, cursor: state.cursor + 1 };
}

export function composerHome(state: ComposerState): ComposerState {
  return { value: state.value, cursor: 0 };
}

export function composerEnd(state: ComposerState): ComposerState {
  return { value: state.value, cursor: [...state.value].length };
}

export function isLiteralSlashCommand(value: string): boolean {
  if (!value.startsWith("/")) return false;
  if (new RegExp(PLACEHOLDER_PATTERN_SOURCE).test(value)) return false;
  return true;
}

export function parseUsageArgs(
  arg: string,
): { scope: "session" | "cwd" | "all"; daysBack?: number } {
  const parts = arg.trim().split(/\s+/).filter((p) => p.length > 0);
  let scope: "session" | "cwd" | "all" = "cwd";
  let daysBack: number | undefined;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "session" || lower === "cwd" || lower === "all") {
      scope = lower;
      continue;
    }
    const n = Number.parseInt(lower, 10);
    if (Number.isFinite(n) && n > 0) {
      daysBack = Math.min(n, 365);
    }
  }
  return daysBack !== undefined ? { scope, daysBack } : { scope };
}

export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hour = Math.floor(min / 60);
  const mn = min % 60;
  return `${hour}h ${mn}m ${sec}s`;
}

export const PASTE_THRESHOLD = 200;
export const PASTE_WORD_THRESHOLD = 18;

export type PasteKind = "text" | "file" | "image";
export interface PasteEntry {
  kind: PasteKind;
  content: string;
  path?: string;
}

const IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
  ".tiff",
]);

export const PLACEHOLDER_PATTERN_SOURCE =
  "\\[(?:Pasted Content|File|Image) #(\\d+)\\]";

export function detectPaste(input: string): boolean {
  const hasMarker =
    input.includes("\x1b[200~") || input.startsWith("[200~");
  const stripped = hasMarker ? stripPasteMarkers(input) : input;
  if (/[\r\n]/.test(stripped)) return true;
  if (stripped.length > PASTE_THRESHOLD) return true;
  if (hasMarker && countWords(stripped) > PASTE_WORD_THRESHOLD) return true;
  return false;
}

function countWords(s: string): number {
  const trimmed = s.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

export function classifyPaste(raw: string, cwd: string): PasteEntry {
  const cleaned = stripPasteMarkers(raw);
  const trimmed = cleaned.trim();
  const looksLikePath =
    trimmed.length > 0 &&
    trimmed.length <= 500 &&
    !trimmed.includes("\n") &&
    !trimmed.includes("\r");
  if (looksLikePath) {
    const candidate = isAbsolute(trimmed) ? trimmed : resolvePath(cwd, trimmed);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        const ext = extname(candidate).toLowerCase();
        return {
          kind: IMAGE_EXTS.has(ext) ? "image" : "file",
          content: cleaned,
          path: candidate,
        };
      }
    } catch {
      // path probe failed — fall through to text
    }
  }
  return { kind: "text", content: cleaned };
}

export function placeholderLabel(entry: PasteEntry, id: number): string {
  switch (entry.kind) {
    case "image":
      return `[Image #${id}]`;
    case "file":
      return `[File #${id}]`;
    default:
      return `[Pasted Content #${id}]`;
  }
}

export function stripPasteMarkers(value: string): string {
  return value
    .replace(/\x1b?\[200~/g, "")
    .replace(/\x1b?\[201~/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function expandPastes(
  value: string,
  pastes: Map<number, PasteEntry>,
): string {
  const re = new RegExp(PLACEHOLDER_PATTERN_SOURCE, "g");
  return value.replace(re, (match, id: string) => {
    const entry = pastes.get(Number.parseInt(id, 10));
    if (!entry) return match;
    if (entry.kind === "image") {
      return `[image at ${entry.path ?? entry.content}]`;
    }
    if (entry.kind === "file") {
      return `[file at ${entry.path ?? entry.content}]`;
    }
    return entry.content;
  });
}

function ComposerLine({
  value,
  cursor,
  suggestion,
}: {
  value: string;
  cursor: number;
  suggestion: string;
}): React.JSX.Element {
  const arr = [...value];
  const safeCursor = Math.max(0, Math.min(cursor, arr.length));
  const command = splitComposerCommand(value);
  const commandLen = command ? [...command.command].length : 0;

  const renderRange = (
    start: number,
    end: number,
    keyPrefix: string,
  ): React.ReactNode[] => {
    if (start >= end) return [];
    const segment = arr.slice(start, end);
    const styledLen = Math.max(
      0,
      Math.min(commandLen - start, segment.length),
    );
    const out: React.ReactNode[] = [];
    if (styledLen > 0) {
      out.push(
        <Text key={`${keyPrefix}-cmd`} color={ACCENT} bold>
          {segment.slice(0, styledLen).join("")}
        </Text>,
      );
    }
    if (styledLen < segment.length) {
      out.push(segment.slice(styledLen).join(""));
    }
    return out;
  };

  const cursorAtEnd = safeCursor >= arr.length;
  const cursorChar = arr[safeCursor] ?? " ";
  const cursorStyled = safeCursor < commandLen;

  return (
    <Text wrap="wrap">
      <Text color={ACCENT}>{"› "}</Text>
      {renderRange(0, safeCursor, "before")}
      {cursorStyled ? (
        <Text inverse color={ACCENT} bold>
          {cursorChar}
        </Text>
      ) : (
        <Text inverse>{cursorChar}</Text>
      )}
      {renderRange(safeCursor + 1, arr.length, "after")}
      {cursorAtEnd && suggestion.length > 0 ? (
        <Text dimColor>{suggestion}</Text>
      ) : null}
    </Text>
  );
}

export function splitComposerCommand(
  value: string,
): { command: string; rest: string } | null {
  if (!value.startsWith("/")) return null;
  const match = value.match(/^\/\S*/);
  const command = match?.[0] ?? "/";
  return {
    command,
    rest: value.slice(command.length),
  };
}

const BUILTIN_SLASH_COMMANDS = [
  "clear",
  "compact",
  "exit",
  "help",
  "model",
  "provider",
  "quit",
  "resume",
  "skills",
];

export function getCompletionSuggestion(
  value: string,
  cursor: number,
  skillNames: Iterable<string>,
): string {
  if (!value.startsWith("/")) return "";
  if (cursor !== [...value].length) return "";
  const cmd = value.slice(1).toLowerCase();
  if (cmd.length === 0) return "";
  if (/\s/.test(cmd)) return "";
  const candidates: string[] = [];
  for (const name of BUILTIN_SLASH_COMMANDS) {
    if (name.startsWith(cmd) && name !== cmd) candidates.push(name);
  }
  for (const name of skillNames) {
    const lower = name.toLowerCase();
    if (lower.startsWith(cmd) && lower !== cmd) candidates.push(lower);
  }
  if (candidates.length === 0) return "";
  candidates.sort();
  const first = candidates[0];
  if (!first) return "";
  return first.slice(cmd.length);
}

function formatToolPreview(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "called";
  const a = args as Record<string, unknown>;
  switch (name) {
    case "Read":
      return `read ${shortPath(a.path)}`;
    case "Write":
      return `wrote ${shortPath(a.path)}`;
    case "Edit":
      return `edited ${shortPath(a.path)}`;
    case "Glob":
      return `matched ${truncateText(stringOr(a.pattern, "?"), 60)}`;
    case "Grep": {
      const pattern = truncateText(stringOr(a.pattern, "?"), 50);
      const where =
        typeof a.path === "string" ? ` in ${shortPath(a.path)}` : "";
      return `searched ${pattern}${where}`;
    }
    case "Shell":
      return `ran ${truncateText(stringOr(a.command, ""), 80)}`;
    case "TodoWrite": {
      const count = Array.isArray(a.todos) ? a.todos.length : 0;
      return `updated checklist (${count} item${count === 1 ? "" : "s"})`;
    }
    default:
      return "called";
  }
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function shortPath(p: unknown): string {
  if (typeof p !== "string") return "?";
  if (p.length <= 60) return p;
  return `...${p.slice(p.length - 57)}`;
}

function truncateText(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 3)}...`;
}

function ActivityRow({
  activity,
  tick,
  bulletOn,
}: {
  activity: ActivityState;
  tick: number;
  bulletOn: boolean;
}): React.JSX.Element | null {
  if (activity.kind === "idle") return null;
  const dots = ".".repeat(tick);
  const rawLabel = activity.label.length > 0 ? activity.label : "Working";
  const label = sanitizeForTerminal(rawLabel);
  return (
    <Box paddingLeft={1}>
      <Text color={ACCENT}>{bulletOn ? "• " : "  "}</Text>
      <Text color={ACCENT}>{label}</Text>
      <Text dimColor>{dots}</Text>
    </Box>
  );
}

function TodoPanel({ todos }: { todos: TodoItem[] }): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={ACCENT}
      paddingX={1}
    >
      <Text bold color={ACCENT}>
        Checklist
      </Text>
      {todos.map((todo) => (
        <Text key={todo.id}>
          <Text color={statusColor(todo.status)}>
            {statusMark(todo.status)}
          </Text>
          {` ${todo.content}`}
        </Text>
      ))}
    </Box>
  );
}

function statusMark(status: TodoItem["status"]): string {
  switch (status) {
    case "completed":
      return "[x]";
    case "in_progress":
      return "[>]";
    case "pending":
      return "[ ]";
  }
}

function statusColor(status: TodoItem["status"]): string {
  switch (status) {
    case "completed":
      return "#9ece6a";
    case "in_progress":
      return ACCENT;
    case "pending":
      return "#565f89";
  }
}

async function persistEvent(
  store: SessionStore,
  sessionId: string,
  ev: CanonicalEvent,
  buffers: {
    text: string;
    reasoning: string;
    pendingToolCalls: CanonicalToolCall[];
    turnTokens: number;
  },
): Promise<void> {
  switch (ev.type) {
    case "text_delta":
      buffers.text += ev.text;
      return;
    case "reasoning_delta":
      buffers.reasoning += ev.text;
      return;
    case "tool_call_done":
      buffers.pendingToolCalls.push({
        id: ev.id,
        name: ev.name,
        args: ev.args,
      });
      try {
        await store.appendToolCall(sessionId, {
          callId: ev.id,
          toolName: ev.name,
          args: ev.args,
        });
      } catch (err: unknown) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "session append (tool_call) failed",
        );
      }
      return;
    case "done": {
      if (
        buffers.text.length > 0 ||
        buffers.reasoning.length > 0 ||
        buffers.pendingToolCalls.length > 0
      ) {
        const payload: Parameters<SessionStore["appendAssistantMessage"]>[1] = {
          content: buffers.text,
        };
        if (buffers.pendingToolCalls.length > 0) {
          payload.toolCalls = buffers.pendingToolCalls;
        }
        if (buffers.reasoning.length > 0) {
          payload.reasoningContent = buffers.reasoning;
        }
        try {
          await store.appendAssistantMessage(sessionId, payload);
        } catch (err: unknown) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "session append (assistant) failed",
          );
        }
      }
      buffers.text = "";
      buffers.reasoning = "";
      buffers.pendingToolCalls = [];
      return;
    }
    case "tool_result":
      try {
        await store.appendToolResult(sessionId, {
          callId: ev.id,
          toolName: ev.name,
          ok: ev.ok,
          reason: ev.reason ?? "executed",
          content: ev.content,
          contentTruncated: false,
          ...(ev.error !== undefined && { error: ev.error }),
          ...(ev.artifact && { artifact: ev.artifact }),
        });
      } catch (err: unknown) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "session append (tool_result) failed",
        );
      }
      return;
    case "usage":
      buffers.turnTokens += ev.usage.totalTokens;
      return;
    case "tool_call_start":
    case "tool_call_delta":
    case "error":
      return;
  }
}

function HistoryRow({ entry }: { entry: HistoryEntry }): React.JSX.Element {
  switch (entry.kind) {
    case "header":
      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={ACCENT}
          paddingX={2}
          paddingY={0}
          alignSelf="flex-start"
        >
          <Text color={ACCENT}>{entry.text}</Text>
          {entry.subtitle ? <Text dimColor>{entry.subtitle}</Text> : null}
        </Box>
      );
    case "user":
      return (
        <Text color={USER_DIM}>
          <Text color={ACCENT} bold>
            {"› "}
          </Text>
          {entry.text}
        </Text>
      );
    case "assistant":
      return renderAssistantLine(entry.text);
    case "tool":
      return <Text color={TOOL_GRAY}>{entry.text}</Text>;
    case "system":
      return <Text dimColor>{entry.text}</Text>;
    case "error":
      return <Text color={SOFT_RED}>{entry.text}</Text>;
    case "skill": {
      const tag =
        entry.skillSource === "project"
          ? " (project)"
          : entry.skillSource === "codex"
            ? " (codex)"
            : "";
      return (
        <Text>
          {"  "}
          <Text color={ACCENT} bold>
            /{entry.skillName}
          </Text>
          {tag.length > 0 ? <Text dimColor>{tag}</Text> : null}
          <Text dimColor> — {entry.text}</Text>
        </Text>
      );
    }
  }
}

export async function runInkRepl(opts: ReplOptions): Promise<void> {
  const stdoutTty = process.stdout.isTTY === true;
  if (stdoutTty) process.stdout.write("\x1b[?2004h");
  const restore = (): void => {
    if (stdoutTty) process.stdout.write("\x1b[?2004l");
  };
  process.once("exit", restore);
  try {
    const instance = render(<App {...opts} />);
    await instance.waitUntilExit();
  } finally {
    restore();
    process.removeListener("exit", restore);
  }
}
