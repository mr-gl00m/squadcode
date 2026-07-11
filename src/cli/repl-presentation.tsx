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

const ACCENT = "#7aa2f7";
const SOFT_RED = "#f7768e";
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
        {props.pendingPermission
          ? "  ·  awaiting permission"
          : props.isStreaming
            ? "  ·  streaming (Ctrl-C aborts)"
            : ""}
      </Text>
    </Box>
  );
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatToolPreview(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "called";
  const values = args as Record<string, unknown>;
  switch (name) {
    case "Read":
      return `read ${shortPath(values.path)}`;
    case "Write":
      return `wrote ${shortPath(values.path)}`;
    case "Edit":
      return `edited ${shortPath(values.path)}`;
    case "Glob":
      return `matched ${truncateText(stringOr(values.pattern, "?"), 60)}`;
    case "Grep": {
      const pattern = truncateText(stringOr(values.pattern, "?"), 50);
      const where =
        typeof values.path === "string" ? ` in ${shortPath(values.path)}` : "";
      return `searched ${pattern}${where}`;
    }
    case "Shell":
      return `ran ${truncateText(stringOr(values.command, ""), 80)}`;
    case "TodoWrite": {
      const count = Array.isArray(values.todos) ? values.todos.length : 0;
      return `updated checklist (${count} item${count === 1 ? "" : "s"})`;
    }
    default:
      return "called";
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function shortPath(value: unknown): string {
  if (typeof value !== "string") return "?";
  if (value.length <= 60) return value;
  return `...${value.slice(value.length - 57)}`;
}

function truncateText(value: string, length: number): string {
  if (value.length <= length) return value;
  return `${value.slice(0, length - 3)}...`;
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
