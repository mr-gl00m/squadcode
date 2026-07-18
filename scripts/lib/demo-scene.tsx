// Scripted replay behind the demo gif. Every visual element is the real
// component from src/cli rendered through Ink; this file only decides when
// each state change lands. sceneAt(t) is a pure function of time, so the
// frame sequence is deterministic and re-renderable.
import { Box, Text } from "ink";
// Value import, not type-only: tsx compiles scripts/ with the classic JSX
// transform, which emits React.createElement calls.
// biome-ignore lint/style/useImportType: classic transform needs the value binding
import React from "react";
import type { HowlEvent } from "../../src/agents/howl.js";
import { AgentPanel } from "../../src/cli/agent-panel.js";
import {
  emptyPanelState,
  type PanelState,
  reducePanels,
} from "../../src/cli/agent-panel-state.js";
import { BANNER, bannerSubtitle } from "../../src/cli/banner.js";
import { ComposerLine } from "../../src/cli/repl-composer.js";
import {
  ActivityRow,
  HistoryRow,
  StatusFooter,
  type StatusFooterProps,
  ToolLedgerView,
} from "../../src/cli/repl-presentation.js";
import type { ActivityState, HistoryEntry } from "../../src/cli/repl-types.js";
import {
  formatBytes,
  type LedgerResultInput,
  ledgerDelta,
  ledgerResult,
  ledgerRun,
  ledgerStart,
  type ToolCallRecord,
} from "../../src/cli/tool-ledger.js";

const ACCENT = "#7aa2f7";

export const FPS = 12;
export const DEMO_DURATION = 15.4;
export const TOTAL_FRAMES = Math.ceil(FPS * DEMO_DURATION);

const PROMPT =
  "Have a reviewer, red-team, and judge audit the parser change in parallel.";
const T_TYPE = 1.4;
const TYPE_RATE = 42;
const T_SUBMIT = 3.5;
const T_STREAM = 11.5;
const STREAM_RATE = 85;
const T_DONE = 13.5;

const STREAM_TEXT =
  "All three agree: the escape-path fix is sound. Red-team flagged one gap, `\\u` sequences split across chunk boundaries, with a repro in its report.";
// Pre-wrapped at the 100-column frame width, matching how the reflow buffer
// would land the block into history.
const ASSISTANT_LINES = [
  "All three agree: the escape-path fix is sound. Red-team flagged one gap, `\\u` sequences split",
  "across chunk boundaries, with a repro in its report.",
];

interface DemoCall {
  id: string;
  name: string;
  preview: string;
  start: number;
  run: number;
  done: number;
  argBytes: number;
  result: LedgerResultInput;
}

const CALLS: DemoCall[] = [
  {
    id: "c1",
    name: "Shell",
    preview: "ran git log --oneline -20",
    start: 3.7,
    run: 3.85,
    done: 4.15,
    argBytes: 38,
    result: { ok: true },
  },
  {
    id: "c2",
    name: "Glob",
    preview: "matched **/*parser*",
    start: 4.2,
    run: 4.35,
    done: 4.6,
    argBytes: 24,
    result: { ok: true },
  },
  {
    id: "c3",
    name: "Grep",
    preview: "searched (?i)parser|parse",
    start: 4.65,
    run: 4.8,
    done: 5.1,
    argBytes: 41,
    result: { ok: false, error: "GREP_BAD_REGEX" },
  },
  {
    id: "c4",
    name: "Read",
    preview: "read src/parser/escape.ts",
    start: 5.15,
    run: 5.3,
    done: 5.6,
    argBytes: 33,
    result: { ok: true },
  },
  {
    id: "c5",
    name: "Shell",
    preview: "ran git diff --stat HEAD~3..HEAD",
    start: 5.65,
    run: 5.8,
    done: 6.1,
    argBytes: 45,
    result: { ok: true },
  },
  {
    id: "c6",
    name: "Grep",
    preview: "searched parse in src/parser",
    start: 6.15,
    run: 6.3,
    done: 6.6,
    argBytes: 37,
    result: { ok: true },
  },
  {
    id: "c7",
    name: "Agent",
    preview: "called",
    start: 6.8,
    run: 7.0,
    done: 10.3,
    argBytes: 210,
    result: { ok: true },
  },
  {
    id: "c8",
    name: "Agent",
    preview: "called",
    start: 7.1,
    run: 7.3,
    done: 10.8,
    argBytes: 205,
    result: { ok: true },
  },
  {
    id: "c9",
    name: "Agent",
    preview: "called",
    start: 7.4,
    run: 7.6,
    done: 11.2,
    argBytes: 198,
    result: { ok: true },
  },
];

const SPAWN_AT = "2026-07-18T00:00:00.000Z";
const PANEL_EVENTS: Array<{ t: number; ev: HowlEvent }> = [
  {
    t: 7.0,
    ev: {
      kind: "spawned",
      agentId: "KT-4",
      type: "reviewer",
      slotKey: 1,
      model: "deepseek-v4-pro",
      provider: "deepseek",
      at: SPAWN_AT,
    },
  },
  {
    t: 7.3,
    ev: {
      kind: "spawned",
      agentId: "MR-8",
      type: "red-team",
      slotKey: 2,
      model: "claude-sonnet-5",
      provider: "anthropic",
      at: SPAWN_AT,
    },
  },
  {
    t: 7.5,
    ev: {
      kind: "action",
      agentId: "KT-4",
      action: "Read src/parser/escape.ts",
    },
  },
  {
    t: 7.6,
    ev: {
      kind: "spawned",
      agentId: "VX-2",
      type: "judge",
      slotKey: 3,
      model: "qwen3.6:latest",
      provider: "ollama",
      at: SPAWN_AT,
    },
  },
  {
    t: 7.9,
    ev: {
      kind: "action",
      agentId: "MR-8",
      action: "Grep \\u chunk boundaries",
    },
  },
  {
    t: 8.0,
    ev: { kind: "anguish", agentId: "KT-4", value: 0.1, band: "calm" },
  },
  {
    t: 8.2,
    ev: {
      kind: "action",
      agentId: "VX-2",
      action: "Read git diff HEAD~3..HEAD",
    },
  },
  {
    t: 8.4,
    ev: { kind: "anguish", agentId: "MR-8", value: 0.35, band: "alert" },
  },
  {
    t: 8.6,
    ev: {
      kind: "action",
      agentId: "KT-4",
      action: "Grep escapeString callers",
    },
  },
  {
    t: 8.8,
    ev: { kind: "anguish", agentId: "VX-2", value: 0.2, band: "calm" },
  },
  { t: 9.0, ev: { kind: "action", agentId: "MR-8", action: "Shell npm test" } },
  {
    t: 9.2,
    ev: { kind: "anguish", agentId: "MR-8", value: 0.55, band: "alert" },
  },
  {
    t: 9.3,
    ev: { kind: "action", agentId: "VX-2", action: "Grep parse boundaries" },
  },
  {
    t: 9.4,
    ev: { kind: "anguish", agentId: "KT-4", value: 0.2, band: "calm" },
  },
  {
    t: 9.8,
    ev: { kind: "anguish", agentId: "VX-2", value: 0.45, band: "alert" },
  },
  {
    t: 10.2,
    ev: { kind: "anguish", agentId: "MR-8", value: 0.25, band: "calm" },
  },
  { t: 10.3, ev: { kind: "terminated", agentId: "KT-4", status: "completed" } },
  { t: 10.8, ev: { kind: "terminated", agentId: "MR-8", status: "completed" } },
  { t: 11.2, ev: { kind: "terminated", agentId: "VX-2", status: "completed" } },
];

interface UsagePoint {
  t: number;
  inTok: number;
  cached: number;
  outTok: number;
}

const USAGE: UsagePoint[] = [
  { t: 4.6, inTok: 4_900, cached: 0, outTok: 209 },
  { t: 6.6, inTok: 9_800, cached: 6_200, outTok: 391 },
  { t: 11.5, inTok: 19_700, cached: 13_300, outTok: 655 },
  { t: T_DONE, inTok: 27_400, cached: 18_700, outTok: 951 },
];

export interface Scene {
  history: HistoryEntry[];
  streamingText: string;
  isStreaming: boolean;
  panel: PanelState;
  panelVisible: boolean;
  ledger: readonly ToolCallRecord[];
  activity: ActivityState;
  tick: number;
  bulletOn: boolean;
  composerValue: string;
  composerCursor: number;
  footer: StatusFooterProps;
}

function ledgerAt(t: number): readonly ToolCallRecord[] {
  let ledger: readonly ToolCallRecord[] = [];
  for (const call of CALLS) {
    if (t < call.start) continue;
    ledger = ledgerStart(ledger, call.id, call.name);
    if (t < call.run) {
      const progress = (t - call.start) / (call.run - call.start);
      const bytes = Math.max(1, Math.round(progress * call.argBytes));
      ledger = ledgerDelta(ledger, call.id, bytes);
      continue;
    }
    ledger = ledgerRun(ledger, call.id, call.name, call.preview);
    if (t >= call.done) {
      ledger = ledgerResult(ledger, call.id, call.name, call.result);
    }
  }
  return ledger;
}

function activityAt(t: number): ActivityState {
  if (t < T_SUBMIT) return { kind: "idle", label: "" };
  if (t >= T_STREAM) return { kind: "responding", label: "Responding" };
  let current: ActivityState = { kind: "thinking", label: "Thinking" };
  for (const call of CALLS) {
    if (t < call.start) break;
    if (t < call.run) {
      const progress = (t - call.start) / (call.run - call.start);
      const bytes = Math.max(1, Math.round(progress * call.argBytes));
      current = {
        kind: "tool",
        label: `Preparing ${call.name} (${formatBytes(bytes)})`,
        toolName: call.name,
      };
    } else if (t < call.done) {
      current = {
        kind: "tool",
        label: `Running ${call.name}`,
        toolName: call.name,
      };
    } else {
      current = { kind: "thinking", label: "Thinking" };
    }
  }
  return current;
}

function footerAt(t: number): StatusFooterProps {
  let usage: UsagePoint = { t: 0, inTok: 0, cached: 0, outTok: 0 };
  for (const point of USAGE) {
    if (t >= point.t) usage = point;
  }
  const finished = t >= T_DONE;
  return {
    yoloOn: false,
    mode: "act",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    turnCount: finished ? 1 : 0,
    lastTurnInputTokens: finished ? usage.inTok : 0,
    lastTurnCachedTokens: finished ? usage.cached : 0,
    lastTurnOutputTokens: finished ? usage.outTok : 0,
    lastTurnCost: finished ? 0.013 : 0,
    totalInputTokens: usage.inTok,
    totalCachedTokens: usage.cached,
    totalOutputTokens: usage.outTok,
    totalCost: finished ? 0.013 : 0,
    pendingPermission: false,
    isStreaming: t >= T_SUBMIT && t < T_DONE,
    viewMode: "compact",
  };
}

export function sceneAt(t: number): Scene {
  let nextId = 0;
  const history: HistoryEntry[] = [
    {
      id: nextId++,
      kind: "header",
      text: BANNER,
      subtitle: bannerSubtitle("1.9.1", "deepseek", "deepseek-v4-pro"),
    },
    {
      id: nextId++,
      kind: "system",
      text: "project permissions loaded: 2 rules across 2 tools (from .squad/settings.json)",
    },
  ];
  if (t >= T_SUBMIT) {
    history.push({ id: nextId++, kind: "user", text: PROMPT });
  }
  // Compact view stays quiet on success; failures land in scrollback.
  const grep = CALLS[2] as DemoCall;
  if (t >= grep.done) {
    history.push({
      id: nextId++,
      kind: "error",
      text: `[${grep.name}] ${grep.preview} · failed (${grep.result.error})`,
    });
  }
  if (t >= T_DONE) {
    for (const line of ASSISTANT_LINES) {
      history.push({ id: nextId++, kind: "assistant", text: line });
    }
    history.push({
      id: nextId++,
      kind: "system",
      text: "• Worked for 10s · 9 tool calls · 8 ok · 1 failed",
    });
  }

  const panel = reducePanels(
    emptyPanelState(4),
    PANEL_EVENTS.filter((entry) => entry.t <= t).map((entry) => entry.ev),
  );
  const panelVisible = panel.cards.some(
    (card) => card.live || card.status !== undefined,
  );

  const typedChars = Math.max(
    0,
    Math.min(PROMPT.length, Math.floor((t - T_TYPE) * TYPE_RATE)),
  );
  const composerValue = t >= T_SUBMIT ? "" : PROMPT.slice(0, typedChars);

  const streamedChars = Math.max(
    0,
    Math.min(STREAM_TEXT.length, Math.floor((t - T_STREAM) * STREAM_RATE)),
  );
  const streamingText = t >= T_DONE ? "" : STREAM_TEXT.slice(0, streamedChars);

  return {
    history,
    streamingText,
    isStreaming: t >= T_SUBMIT && t < T_DONE,
    panel,
    panelVisible,
    ledger: ledgerAt(t),
    activity: activityAt(t),
    tick: Math.floor(t / 0.35) % 4,
    bulletOn: Math.floor(t / 0.5) % 2 === 0,
    composerValue,
    composerCursor: composerValue.length,
    footer: footerAt(t),
  };
}

export function DemoFrame({ s }: { s: Scene }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {s.history.map((entry) => (
        <HistoryRow key={entry.id} entry={entry} />
      ))}
      {s.isStreaming && s.streamingText.length > 0 ? (
        <Text wrap="wrap">{s.streamingText}</Text>
      ) : null}
      {s.panelVisible ? <AgentPanel state={s.panel} /> : null}
      {s.isStreaming && s.ledger.length > 0 ? (
        <ToolLedgerView ledger={s.ledger} />
      ) : null}
      {s.isStreaming ? (
        <ActivityRow
          activity={s.activity}
          tick={s.tick}
          bulletOn={s.bulletOn}
        />
      ) : null}
      <Box borderStyle="round" borderColor={ACCENT} paddingX={1}>
        <ComposerLine
          value={s.composerValue}
          cursor={s.composerCursor}
          suggestion=""
        />
      </Box>
      <StatusFooter {...s.footer} />
    </Box>
  );
}
