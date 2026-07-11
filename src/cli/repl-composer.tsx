import { existsSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve as resolvePath } from "node:path";
import { Text } from "ink";
import type React from "react";
import { fileMentionSuggestion } from "./file-mentions.js";

const ACCENT = "#7aa2f7";
const PLACEHOLDER_PATTERN_SOURCE =
  "\\[(?:Pasted Content(?: \\d+ chars)?|File|Image) #(\\d+)\\]";

export interface ComposerState {
  value: string;
  cursor: number;
}

export type PasteKind = "text" | "file" | "image";

export interface PasteEntry {
  kind: PasteKind;
  content: string;
  path?: string;
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

export function isTerminalFocusReport(value: string): boolean {
  return /^(?:(?:\x1b\[|\u009b|\[)[IO])+$/.test(value);
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
  const match = beforeStr.match(new RegExp(`${PLACEHOLDER_PATTERN_SOURCE}$`));
  if (match && match.index !== undefined) {
    const id = Number.parseInt(match[1] ?? "0", 10);
    pastes?.delete(id);
    const matchPoints = [...match[0]].length;
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
  const match = afterStr.match(new RegExp(`^${PLACEHOLDER_PATTERN_SOURCE}`));
  if (match) {
    const id = Number.parseInt(match[1] ?? "0", 10);
    pastes?.delete(id);
    const matchPoints = [...match[0]].length;
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
  let index = cursor;
  while (index > 0 && /\s/.test(arr[index - 1] ?? "")) index -= 1;
  while (index > 0 && !/\s/.test(arr[index - 1] ?? "")) index -= 1;
  return {
    value: arr.slice(0, index).join("") + arr.slice(cursor).join(""),
    cursor: index,
  };
}

export function composerMoveLeft(state: ComposerState): ComposerState {
  if (state.cursor === 0) return state;
  return { value: state.value, cursor: state.cursor - 1 };
}

export function composerMoveRight(state: ComposerState): ComposerState {
  const length = [...state.value].length;
  if (state.cursor >= length) return state;
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

export function parseUsageArgs(arg: string): {
  scope: "session" | "cwd" | "all";
  daysBack?: number;
} {
  const parts = arg
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  let scope: "session" | "cwd" | "all" = "cwd";
  let daysBack: number | undefined;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "session" || lower === "cwd" || lower === "all") {
      scope = lower;
      continue;
    }
    const parsed = Number.parseInt(lower, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      daysBack = Math.min(parsed, 365);
    }
  }
  return daysBack !== undefined ? { scope, daysBack } : { scope };
}

export function formatTokenCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hour = Math.floor(min / 60);
  const minute = min % 60;
  return `${hour}h ${minute}m ${sec}s`;
}

const PASTE_THRESHOLD = 200;
const PASTE_WORD_THRESHOLD = 18;
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

export function detectPaste(input: string): boolean {
  const hasMarker = input.includes("\x1b[200~") || input.startsWith("[200~");
  const stripped = hasMarker ? stripPasteMarkers(input) : input;
  if (/[\r\n]/.test(stripped)) return true;
  if (stripped.length > PASTE_THRESHOLD) return true;
  if (hasMarker && countWords(stripped) > PASTE_WORD_THRESHOLD) return true;
  return false;
}

function countWords(value: string): number {
  const trimmed = value.trim();
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
      // Path probe failed; fall through to text.
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
      return `[Pasted Content ${entry.content.length} chars #${id}]`;
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
  const pattern = new RegExp(PLACEHOLDER_PATTERN_SOURCE, "g");
  return value.replace(pattern, (match, id: string) => {
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

export function ComposerLine({
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
    const styledLen = Math.max(0, Math.min(commandLen - start, segment.length));
    const output: React.ReactNode[] = [];
    if (styledLen > 0) {
      output.push(
        <Text key={`${keyPrefix}-cmd`} color={ACCENT} bold>
          {segment.slice(0, styledLen).join("")}
        </Text>,
      );
    }
    if (styledLen < segment.length) {
      output.push(segment.slice(styledLen).join(""));
    }
    return output;
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
  return { command, rest: value.slice(command.length) };
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
  fileMentions: readonly string[] = [],
): string {
  if (!value.startsWith("/")) {
    return fileMentionSuggestion(value, cursor, fileMentions);
  }
  if (cursor !== [...value].length) return "";
  const command = value.slice(1).toLowerCase();
  if (command.length === 0 || /\s/.test(command)) return "";
  const candidates: string[] = [];
  for (const name of BUILTIN_SLASH_COMMANDS) {
    if (name.startsWith(command) && name !== command) candidates.push(name);
  }
  for (const name of skillNames) {
    const lower = name.toLowerCase();
    if (lower.startsWith(command) && lower !== command) candidates.push(lower);
  }
  if (candidates.length === 0) return "";
  candidates.sort();
  const first = candidates[0];
  if (!first) return "";
  return first.slice(command.length);
}
