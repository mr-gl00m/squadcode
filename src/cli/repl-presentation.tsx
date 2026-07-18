import { Box, Text } from "ink";
import type React from "react";
import type { Mode } from "../permissions/plan.js";
import type { PromptRequest } from "../permissions/prompt.js";
import { formatCost } from "../pricing.js";
import { sanitizeForTerminal } from "../terminal.js";
import type { TodoItem } from "../tools/todo.js";
import { renderAssistantLine } from "./markdown.js";
import type { BacktrackViewState } from "./repl-backtrack.js";
import { formatTokenCount } from "./repl-composer.js";
import type { ActivityState, HistoryEntry } from "./repl-types.js";
import {
  formatLedgerCounts,
  ledgerWindow,
  liveRowText,
  type ToolCallRecord,
  type ToolCallStatus,
  type ViewMode,
} from "./tool-ledger.js";

const ACCENT = "#7aa2f7";
const SOFT_RED = "#f7768e";
const SOFT_YELLOW = "#e0af68";
const TOOL_GRAY = "#7a8294";
const USER_DIM = "#a89984";

export function BacktrackOverlay({
  state,
}: {
  state: BacktrackViewState;
}): React.JSX.Element {
  const start = Math.max(0, state.selected - 7);
  const visible = state.targets.slice(start, start + 8);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={ACCENT}
      paddingX={1}
    >
      <Text bold color={ACCENT}>
        Backtrack
      </Text>
      {state.status === "loading" ? (
        <Text dimColor>Loading turns...</Text>
      ) : null}
      {state.status === "rolling-back" ? (
        <Text dimColor>Restoring transcript and workspace...</Text>
      ) : null}
      {state.message ? (
        <Text {...(state.status === "error" && { color: "red" })}>
          {state.message}
        </Text>
      ) : null}
      {state.status === "ready"
        ? visible.map((target, offset) => {
            const index = start + offset;
            return (
              <Text
                key={target.turnId}
                inverse={index === state.selected}
                {...(index === state.selected && { color: ACCENT })}
              >
                {index === state.selected ? "› " : "  "}
                {target.turnNumber}. {sanitizeForTerminal(target.label)}
              </Text>
            );
          })
        : null}
      {state.status === "ready" ? (
        <Text dimColor>↑/↓ select · Enter restore · Esc cancel</Text>
      ) : null}
    </Box>
  );
}

export function PermissionOverlay({
  request,
  allowProjectPersist,
}: {
  request: PromptRequest;
  allowProjectPersist: boolean;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={ACCENT}
      paddingX={1}
    >
      <Text bold color={ACCENT}>
        permission required: {sanitizeForTerminal(request.toolName)}
      </Text>
      <Text dimColor>{sanitizeForTerminal(request.argsPreview)}</Text>
      {request.guardianAdvice ? (
        <Text color="yellow">
          advisory: {sanitizeForTerminal(request.guardianAdvice)}
        </Text>
      ) : null}
      <Text>
        <Text color={ACCENT}>[y]</Text>es allow once{" "}
        <Text color={ACCENT}>[a]</Text>lways for this session{" "}
        {allowProjectPersist ? (
          <>
            <Text color={ACCENT}>[p]</Text>ermanently for this project{" "}
          </>
        ) : null}
        <Text color={ACCENT}>[u]</Text>ser-wide <Text color={ACCENT}>[n]</Text>o
        (default)
      </Text>
    </Box>
  );
}

export interface StatusFooterProps {
  yoloOn: boolean;
  mode: Mode;
  provider: string;
  model: string;
  turnCount: number;
  lastTurnInputTokens: number;
  lastTurnCachedTokens: number;
  lastTurnOutputTokens: number;
  lastTurnCost: number;
  totalInputTokens: number;
  totalCachedTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  pendingPermission: boolean;
  isStreaming: boolean;
  viewMode: ViewMode;
}

export function StatusFooter(props: StatusFooterProps): React.ReactElement {
  return (
    <Box paddingLeft={1}>
      <Text dimColor>
        {props.yoloOn ? (
          <Text color={SOFT_RED} bold>
            {"YOLO  ·  "}
          </Text>
        ) : null}
        {props.mode === "plan" ? (
          <Text color="cyan" bold>
            {"PLAN  ·  "}
          </Text>
        ) : null}
        {props.provider}/{props.model}
        {"  ·  turns "}
        {props.turnCount}
        {props.lastTurnInputTokens > 0
          ? ` (last: in ${formatTokenCount(props.lastTurnInputTokens)}${props.lastTurnCachedTokens > 0 ? ` [${Math.round((props.lastTurnCachedTokens / props.lastTurnInputTokens) * 100)}% cached]` : ""} · out ${formatTokenCount(props.lastTurnOutputTokens)}${props.lastTurnCost > 0 ? ` · ~${formatCost(props.lastTurnCost)}` : ""})`
          : ""}
        {"  ·  total in "}
        {formatTokenCount(props.totalInputTokens)}
        {props.totalCachedTokens > 0 && props.totalInputTokens > 0
          ? ` [${Math.round((props.totalCachedTokens / props.totalInputTokens) * 100)}% cached]`
          : ""}
        {" · out "}
        {formatTokenCount(props.totalOutputTokens)}
        {props.totalCost > 0 ? `  ·  ~${formatCost(props.totalCost)} est` : ""}
        {props.viewMode === "detailed" ? "  ·  detail view (Ctrl-O)" : ""}
        {props.pendingPermission
          ? "  ·  awaiting permission"
          : props.isStreaming
            ? `  ·  streaming (Ctrl-C aborts${props.viewMode === "compact" ? " · Ctrl-O detail" : ""})`
            : ""}
      </Text>
    </Box>
  );
}

// Live tool window for the compact view: one row per call in flight or
// recently finished, updated in place. Finalized detail never lands in
// scrollback here — failures are appended by the turn controller and the
// rest collapses into the turn-close summary line.
const LEDGER_WINDOW_ROWS = 6;

function ledgerGlyph(status: ToolCallStatus): string {
  switch (status) {
    case "preparing":
    case "running":
      return "▸";
    case "ok":
      return "✓";
    case "failed":
    case "unknown":
      return "✗";
    case "denied":
      return "⊘";
    case "aborted":
    case "interrupted":
      return "-";
  }
}

function ledgerColor(status: ToolCallStatus): string {
  switch (status) {
    case "preparing":
    case "running":
      return ACCENT;
    case "ok":
      return TOOL_GRAY;
    case "failed":
    case "unknown":
      return SOFT_RED;
    case "denied":
      return SOFT_YELLOW;
    case "aborted":
    case "interrupted":
      return TOOL_GRAY;
  }
}

export function ToolLedgerView({
  ledger,
}: {
  ledger: readonly ToolCallRecord[];
}): React.JSX.Element {
  const view = ledgerWindow(ledger, LEDGER_WINDOW_ROWS);
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {view.hidden === null ? null : (
        <Text dimColor>
          {`… ${view.hidden.total} earlier · ${formatLedgerCounts(view.hidden)}`}
        </Text>
      )}
      {view.visible.map((record) => (
        <Text key={record.seq} color={ledgerColor(record.status)}>
          {`${ledgerGlyph(record.status)} ${liveRowText(record)}`}
        </Text>
      ))}
    </Box>
  );
}

export function ActivityRow({
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

export function TodoPanel({ todos }: { todos: TodoItem[] }): React.JSX.Element {
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

export function HistoryRow({
  entry,
}: {
  entry: HistoryEntry;
}): React.JSX.Element {
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
      const tag = entry.skillSource === "project" ? " (project)" : "";
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
