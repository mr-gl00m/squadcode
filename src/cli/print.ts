import type { CanonicalEvent } from "../providers/types.js";
import { sanitizeForTerminal } from "../terminal.js";
import { AssistantTextReflow } from "./text-reflow.js";

export interface PrintState {
  hadText: boolean;
  exitCode: number;
  reflow: AssistantTextReflow;
}

export function createPrintState(): PrintState {
  return { hadText: false, exitCode: 0, reflow: new AssistantTextReflow() };
}

export function renderEvent(ev: CanonicalEvent, state: PrintState): void {
  switch (ev.type) {
    case "text_delta":
      {
        const text = state.reflow.push(sanitizeForTerminal(ev.text));
        if (text.length > 0) {
          process.stdout.write(text);
          state.hadText = true;
        }
      }
      return;
    case "reasoning_delta":
      return;
    case "tool_call_start":
      flushText(state);
      if (state.hadText) process.stdout.write("\n");
      process.stdout.write(
        `[${sanitizeForTerminal(ev.name)}] requested (${sanitizeForTerminal(ev.id)})\n`,
      );
      state.hadText = false;
      return;
    case "tool_call_delta":
    case "tool_call_done":
      return;
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
      process.stdout.write(
        `[${sanitizeForTerminal(ev.name)}] ${sanitizeForTerminal(tag)}\n`,
      );
      return;
    }
    case "usage":
      return;
    case "done":
      flushText(state);
      if (state.hadText) process.stdout.write("\n");
      return;
    case "error":
      flushText(state);
      if (state.hadText) process.stderr.write("\n");
      process.stderr.write(
        `error (${sanitizeForTerminal(ev.code)}): ${sanitizeForTerminal(ev.message)}\n`,
      );
      state.exitCode = 1;
      return;
  }
}

function flushText(state: PrintState): void {
  const text = state.reflow.flush();
  if (text.length > 0) {
    process.stdout.write(text);
    state.hadText = true;
  }
}
