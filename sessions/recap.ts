// Recap reporter. Pure function over a session's records (or in-memory
// canonical messages) + usage totals, produces a markdown summary suitable
// for printing into a transcript or to stdout.
//
// Three callers:
//   - `squad receipt <id>` CLI subcommand (uses session records from disk)
//   - /receipt and /clear slash commands (use in-memory CanonicalMessages)
//   - the idle-timer that fires when N minutes pass without activity
//
// The CanonicalMessage path is lossy on permission-denied / aborted tool
// calls (the canonical shape doesn't carry the reason field). When that
// matters, fall through to the disk path via `squad receipt`.

import { relative } from "node:path";
import type {
  CanonicalMessage,
  CanonicalToolCall,
} from "../providers/types.js";
import type {
  AssistantMessagePayload,
  SessionMetadata,
  SessionRecord,
  ToolCallPayload,
  ToolResultPayload,
  UserMessagePayload,
} from "./types.js";
import type { UsageTotals } from "./usage-ledger.js";

interface FileTouch {
  path: string;
  kinds: Set<"read" | "edit" | "write" | "patch">;
}

interface ShellRun {
  command: string;
  ok: boolean;
  reason: string;
}

interface DeniedCall {
  tool: string;
  preview: string;
}

interface TodoSnapshot {
  open: string[];
  inProgress: string[];
}

// Normalized intermediate form. Both record-based and message-based adapters
// produce this; the renderer is the single source of truth for formatting.
export interface RecapData {
  metadata: SessionMetadata;
  goal: string;
  fileTouches: FileTouch[];
  shellRuns: ShellRun[];
  deniedCalls: DeniedCall[];
  todos: TodoSnapshot;
  lastAssistant: string;
  usage?: UsageTotals | undefined;
}

export interface RecapFromRecordsInput {
  metadata: SessionMetadata;
  records: SessionRecord[];
  usage?: UsageTotals | undefined;
}

export interface RecapFromMessagesInput {
  metadata: SessionMetadata;
  messages: CanonicalMessage[];
  usage?: UsageTotals | undefined;
}

export function formatRecap(input: RecapFromRecordsInput): string {
  return renderRecap(recapDataFromRecords(input));
}

export function formatRecapFromMessages(input: RecapFromMessagesInput): string {
  return renderRecap(recapDataFromMessages(input));
}

function renderRecap(data: RecapData): string {
  const lines: string[] = [];

  lines.push(`# Recap — session ${data.metadata.sessionId.slice(0, 8)}`);
  lines.push(
    `${data.metadata.provider}/${data.metadata.model}  ·  ${data.metadata.turnCount} turn${
      data.metadata.turnCount === 1 ? "" : "s"
    }  ·  ${data.metadata.cwd}`,
  );
  lines.push("");

  if (data.goal) {
    lines.push("## Goal");
    lines.push(data.goal);
    lines.push("");
  }

  if (data.fileTouches.length > 0) {
    lines.push("## Files touched");
    for (const t of data.fileTouches) {
      const kinds = [...t.kinds].sort().join(", ");
      lines.push(`- \`${relPath(t.path, data.metadata.cwd)}\` (${kinds})`);
    }
    lines.push("");
  }

  if (data.shellRuns.length > 0) {
    lines.push("## Shell");
    for (const s of data.shellRuns) {
      const status = s.ok ? "ok" : s.reason;
      const cmd =
        s.command.length > 100 ? `${s.command.slice(0, 97)}...` : s.command;
      lines.push(`- [${status}] \`${cmd}\``);
    }
    lines.push("");
  }

  if (data.deniedCalls.length > 0) {
    lines.push("## Denied / aborted");
    for (const d of data.deniedCalls) {
      lines.push(`- ${d.tool}: ${d.preview}`);
    }
    lines.push("");
  }

  if (data.usage && data.usage.rows > 0) {
    lines.push("## Tokens & cost");
    const u = data.usage;
    lines.push(
      `- input: ${u.inputTokens.toLocaleString()}  ·  output: ${u.outputTokens.toLocaleString()}  ·  cached: ${u.cachedInputTokens.toLocaleString()}`,
    );
    if (u.costUsd > 0) {
      lines.push(`- cost: $${u.costUsd.toFixed(4)} (estimated)`);
    }
    lines.push("");
  } else if (data.metadata.totalTokens > 0) {
    lines.push("## Tokens");
    lines.push(`- total: ${data.metadata.totalTokens.toLocaleString()}`);
    lines.push("");
  }

  if (data.todos.inProgress.length > 0 || data.todos.open.length > 0) {
    lines.push("## Outstanding todos");
    for (const t of data.todos.inProgress) {
      lines.push(`- [~] ${t}`);
    }
    for (const t of data.todos.open) {
      lines.push(`- [ ] ${t}`);
    }
    lines.push("");
  }

  const nextAction = pickNextAction(data.lastAssistant, data.todos);
  if (nextAction) {
    lines.push("## Next action");
    lines.push(nextAction);
    lines.push("");
  }

  if (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

function recapDataFromRecords(input: RecapFromRecordsInput): RecapData {
  const fileMap = new Map<string, FileTouch>();
  const shellRuns: ShellRun[] = [];
  const deniedCalls: DeniedCall[] = [];
  const pendingCalls = new Map<string, ToolCallPayload>();
  let goal = "";
  let lastAssistant = "";
  let lastTodosPayload: unknown = null;

  for (const rec of input.records) {
    if (rec.type === "user_message") {
      const u = rec.payload as UserMessagePayload;
      if (!goal) goal = trimToParagraph(u.content);
    } else if (rec.type === "assistant_message") {
      const a = rec.payload as AssistantMessagePayload;
      if (a.content.trim()) lastAssistant = a.content.trim();
    } else if (rec.type === "tool_call") {
      const c = rec.payload as ToolCallPayload;
      pendingCalls.set(c.callId, c);
      if (c.toolName === "TodoWrite") lastTodosPayload = c.args;
    } else if (rec.type === "tool_result") {
      const r = rec.payload as ToolResultPayload;
      const call = pendingCalls.get(r.callId);
      pendingCalls.delete(r.callId);
      if (!call) continue;
      if (r.reason === "denied" || r.reason === "aborted") {
        deniedCalls.push({
          tool: call.toolName,
          preview: previewArgs(call.args),
        });
        continue;
      }
      mergeFileTouch(fileMap, fileTouchFor(call));
      if (call.toolName === "Shell") {
        shellRuns.push({
          command: (call.args as { command?: string })?.command ?? "",
          ok: r.ok,
          reason: r.reason,
        });
      }
    }
  }

  return {
    metadata: input.metadata,
    goal,
    fileTouches: [...fileMap.values()],
    shellRuns,
    deniedCalls,
    todos: extractTodos(lastTodosPayload),
    lastAssistant,
    usage: input.usage,
  };
}

function recapDataFromMessages(input: RecapFromMessagesInput): RecapData {
  const fileMap = new Map<string, FileTouch>();
  const shellRuns: ShellRun[] = [];
  const pendingCalls = new Map<string, CanonicalToolCall>();
  let goal = "";
  let lastAssistant = "";
  let lastTodosPayload: unknown = null;

  for (const msg of input.messages) {
    if (msg.role === "user") {
      if (!goal) goal = trimToParagraph(msg.content);
    } else if (msg.role === "assistant") {
      if (msg.content.trim()) lastAssistant = msg.content.trim();
      for (const call of msg.toolCalls ?? []) {
        pendingCalls.set(call.id, call);
        if (call.name === "TodoWrite") lastTodosPayload = call.args;
      }
    } else if (msg.role === "tool" && msg.toolCallId) {
      const call = pendingCalls.get(msg.toolCallId);
      pendingCalls.delete(msg.toolCallId);
      if (!call) continue;
      mergeFileTouch(
        fileMap,
        fileTouchFor({
          toolName: call.name,
          args: call.args,
        }),
      );
      if (call.name === "Shell") {
        // The canonical tool message doesn't carry ok/reason, so treat as
        // executed-successfully unless the content starts with the deny
        // marker the engine emits. Best-effort — the disk-backed `squad
        // receipt` path has the full reason field.
        const looksDenied = msg.content.startsWith("[permission denied]");
        shellRuns.push({
          command: (call.args as { command?: string })?.command ?? "",
          ok: !looksDenied,
          reason: looksDenied ? "denied" : "executed",
        });
      }
    }
  }

  return {
    metadata: input.metadata,
    goal,
    fileTouches: [...fileMap.values()],
    shellRuns,
    deniedCalls: [],
    todos: extractTodos(lastTodosPayload),
    lastAssistant,
    usage: input.usage,
  };
}

function mergeFileTouch(
  fileMap: Map<string, FileTouch>,
  touch: FileTouch | null,
): void {
  if (!touch) return;
  const existing = fileMap.get(touch.path);
  if (existing) {
    for (const k of touch.kinds) existing.kinds.add(k);
  } else {
    fileMap.set(touch.path, touch);
  }
}

function fileTouchFor(call: {
  toolName: string;
  args: unknown;
}): FileTouch | null {
  const args = call.args as { path?: string; file_path?: string } | null;
  const path = args?.path ?? args?.file_path;
  if (!path || typeof path !== "string") return null;
  switch (call.toolName) {
    case "Read":
      return { path, kinds: new Set(["read"]) };
    case "Edit":
      return { path, kinds: new Set(["edit"]) };
    case "Write":
      return { path, kinds: new Set(["write"]) };
    case "ApplyPatch":
      return { path, kinds: new Set(["patch"]) };
    default:
      return null;
  }
}

function previewArgs(args: unknown): string {
  if (args == null) return "(no args)";
  try {
    const json = JSON.stringify(args);
    return json.length > 120 ? `${json.slice(0, 117)}...` : json;
  } catch {
    return String(args);
  }
}

function trimToParagraph(content: string): string {
  const trimmed = content.trim();
  const firstPara = trimmed.split(/\n\s*\n/)[0] ?? trimmed;
  if (firstPara.length <= 240) return firstPara;
  return `${firstPara.slice(0, 237)}...`;
}

function extractTodos(payload: unknown): TodoSnapshot {
  const open: string[] = [];
  const inProgress: string[] = [];
  if (!payload || typeof payload !== "object") return { open, inProgress };
  const todos = (payload as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return { open, inProgress };
  for (const t of todos) {
    if (!t || typeof t !== "object") continue;
    const status = (t as { status?: string }).status;
    const content =
      (t as { content?: string }).content ?? (t as { task?: string }).task;
    if (typeof content !== "string") continue;
    if (status === "in_progress") inProgress.push(content);
    else if (status !== "completed") open.push(content);
  }
  return { open, inProgress };
}

function pickNextAction(lastAssistant: string, todos: TodoSnapshot): string {
  if (todos.inProgress[0]) return todos.inProgress[0];
  if (todos.open[0]) return todos.open[0];
  if (!lastAssistant) return "";
  const tail =
    lastAssistant
      .split(/\n\s*\n/)
      .pop()
      ?.trim() ?? "";
  if (!tail) return "";
  if (tail.length <= 240) return tail;
  return `${tail.slice(0, 237)}...`;
}

function relPath(path: string, cwd: string): string {
  const r = relative(cwd, path).replace(/\\/g, "/");
  return r.length > 0 ? r : path;
}
