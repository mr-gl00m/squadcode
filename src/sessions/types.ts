import type { CanonicalToolCall } from "../providers/types.js";

export interface SessionMetadata {
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  cwd: string;
  provider: string;
  model: string;
  turnCount: number;
  totalTokens: number;
  archived: boolean;
}

export type SessionRecordType =
  | "session_meta"
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result";

export interface SessionMetaPayload {
  cwd: string;
  provider: string;
  model: string;
  systemPrompt?: string;
}

export interface UserMessagePayload {
  content: string;
}

export interface AssistantMessagePayload {
  content: string;
  toolCalls?: CanonicalToolCall[];
  reasoningContent?: string;
}

export interface ToolCallPayload {
  callId: string;
  toolName: string;
  args: unknown;
}

export interface ToolResultPayload {
  callId: string;
  toolName: string;
  ok: boolean;
  reason: "executed" | "denied" | "unknown_tool" | "aborted";
  content: string;
  contentTruncated: boolean;
  error?: string;
}

export type SessionRecordPayload =
  | { type: "session_meta"; payload: SessionMetaPayload }
  | { type: "user_message"; payload: UserMessagePayload }
  | { type: "assistant_message"; payload: AssistantMessagePayload }
  | { type: "tool_call"; payload: ToolCallPayload }
  | { type: "tool_result"; payload: ToolResultPayload };

export type SessionRecord = SessionRecordPayload & {
  ts: string;
  sessionId: string;
};

export interface ListFilter {
  cwd?: string;
  limit?: number;
  includeArchived?: boolean;
}

export interface CreateSessionInput {
  sessionId: string;
  cwd: string;
  provider: string;
  model: string;
  systemPrompt?: string;
}
