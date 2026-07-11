// stream-json output format: the agent turn as newline-delimited typed JSON
// records on stdout, the machine-readable counterpart to the human renderer in
// print.ts. One JSON object per line, so a downstream tool (or Squad Code's own
// vetting harness) can consume a run without scraping formatted text.
//
// Record types: init (turn metadata, once at the start), message (an assistant
// text/reasoning segment), tool_use (a completed tool call with its args),
// tool_result (the tool's outcome), error (a provider/stream error), and result
// (the final per-model token + cache + cost breakdown). Assistant text deltas
// are accumulated and flushed as a single `message` record at each tool boundary
// and at turn end, mirroring how print.ts flushes text.

import type { CanonicalEvent, CanonicalUsage } from "../providers/types.js";

// Version of the NDJSON record contract. Bumped when a record's shape changes in
// a way a consumer (e.g. CrabMeat driving Squad — see
// integration/crabmeat-contract.md) would need to adapt to. Emitted on the init
// record so a consumer can check it before parsing the rest of the stream.
export const STREAM_JSON_SCHEMA_VERSION = "1";

export interface StreamJsonInit {
  sessionId: string;
  provider: string;
  model: string;
  cwd: string;
  mode?: string;
  resumed?: boolean;
}

export interface StreamJsonResult {
  sessionId: string;
  provider: string;
  model: string;
  usage: CanonicalUsage;
  costUsd: number;
  toolCalls: number;
  exitCode: number;
}

export interface StreamJsonState {
  exitCode: number;
  lastUsage?: CanonicalUsage;
  toolCalls: number;
}

export interface StreamJsonRenderer {
  init(meta: StreamJsonInit): void;
  event(ev: CanonicalEvent): void;
  result(meta: StreamJsonResult): void;
  readonly state: StreamJsonState;
}

type Writer = (line: string) => void;

export function createStreamJsonRenderer(write: Writer): StreamJsonRenderer {
  let textBuf = "";
  let reasoningBuf = "";
  const state: StreamJsonState = { exitCode: 0, toolCalls: 0 };

  function emit(record: Record<string, unknown>): void {
    write(`${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
  }

  function flushMessage(): void {
    if (textBuf.length === 0 && reasoningBuf.length === 0) return;
    const record: Record<string, unknown> = {
      type: "message",
      role: "assistant",
      text: textBuf,
    };
    if (reasoningBuf.length > 0) record.reasoning = reasoningBuf;
    emit(record);
    textBuf = "";
    reasoningBuf = "";
  }

  return {
    state,
    init(meta) {
      emit({
        type: "init",
        schema_version: STREAM_JSON_SCHEMA_VERSION,
        ...meta,
      });
    },
    event(ev) {
      switch (ev.type) {
        case "text_delta":
          textBuf += ev.text;
          return;
        case "reasoning_delta":
          reasoningBuf += ev.text;
          return;
        case "tool_call_start":
        case "tool_call_delta":
          return;
        case "tool_call_done":
          flushMessage();
          state.toolCalls += 1;
          emit({ type: "tool_use", id: ev.id, name: ev.name, args: ev.args });
          return;
        case "tool_result": {
          const record: Record<string, unknown> = {
            type: "tool_result",
            id: ev.id,
            name: ev.name,
            ok: ev.ok,
            content: ev.content,
          };
          if (ev.error !== undefined) record.error = ev.error;
          if (ev.reason !== undefined) record.reason = ev.reason;
          if (ev.artifact !== undefined) record.artifact = ev.artifact;
          emit(record);
          return;
        }
        case "usage":
          state.lastUsage = ev.usage;
          return;
        case "done":
          flushMessage();
          return;
        case "error":
          flushMessage();
          emit({
            type: "error",
            code: ev.code,
            message: ev.message,
            retryable: ev.retryable,
          });
          state.exitCode = 1;
          return;
      }
    },
    result(meta) {
      emit({
        type: "result",
        sessionId: meta.sessionId,
        provider: meta.provider,
        model: meta.model,
        usage: {
          inputTokens: meta.usage.inputTokens,
          cachedInputTokens: meta.usage.cachedInputTokens ?? 0,
          outputTokens: meta.usage.outputTokens,
          totalTokens: meta.usage.totalTokens,
        },
        costUsd: meta.costUsd,
        toolCalls: meta.toolCalls,
        exitCode: meta.exitCode,
      });
    },
  };
}
