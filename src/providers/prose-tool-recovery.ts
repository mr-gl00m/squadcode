// Prose tool-call recovery: a compatibility layer for local models that emit
// tool calls as assistant text instead of as structured tool calls. Hermes and
// Qwen emit `<tool_call>{json}</tool_call>`, Anthropic-imitators emit
// `<invoke name="tool">{json}</invoke>`, and Llama derivatives emit
// `<function=tool>{json}</function>`. Left unhandled these models dead-end with
// "streamed text but no tool calls".
//
// This is NOT a general XML/HTML parser. It recognizes exactly the three
// bounded wrapper forms above, each containing exactly one JSON object, strips
// the recognized `functions.` / `default_api:` namespace prefixes from the
// recovered name, and routes the arguments through the existing arg-repair
// ladder before emitting the same canonical `tool_call_done` a native provider
// call would. It runs one level before arg-repair.ts, at the shared canonical
// event stream, so all three provider adapters share one implementation.
//
// Design notes and the documented ceiling live in
// docs/prose-tool-recovery.md.

import { ProviderError } from "../errors.js";
import { parseToolArgs } from "./arg-repair.js";
import type {
  CanonicalEvent,
  CanonicalFinishReason,
  CanonicalRequest,
  LLMProvider,
  ProviderCallOptions,
} from "./types.js";

// A single wrapper body larger than this is treated as runaway text and flushed
// verbatim rather than recovered. Generous: a real tool call's JSON is small.
const MAX_WRAPPER_LEN = 64 * 1024;

// The three opening tokens. Every wrapper starts with one of these; the scanner
// only ever needs to look for `<` or a backtick to find a candidate.
const OPEN_TOKENS = ["<tool_call", "<invoke", "<function="] as const;
type OpenToken = (typeof OPEN_TOKENS)[number];

const CLOSE_TAG: Record<OpenToken, string> = {
  "<tool_call": "</tool_call>",
  "<invoke": "</invoke>",
  "<function=": "</function>",
};

// Wrapper namespace prefixes some backends prepend to the tool name.
const NAMESPACE_PREFIXES = ["functions.", "default_api.", "default_api:"];

// A recovered tool name must look like a real tool identifier. Allowed
// punctuation: dot, underscore, hyphen. Anything else (spaces, quotes, angle
// brackets, parentheses) means we mis-parsed and should leave the text visible.
const VALID_TOOL_NAME = /^[A-Za-z0-9_.-]+$/;

interface Recovered {
  name: string;
  args: unknown;
}

function isWs(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

export function stripNamespace(name: string): string {
  let out = name.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of NAMESPACE_PREFIXES) {
      if (out.startsWith(prefix)) {
        out = out.slice(prefix.length);
        changed = true;
      }
    }
  }
  return out;
}

// Stable stringify for dedup signatures; key order independent.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

function callSignature(name: string, args: unknown): string {
  return `${name}\u0000${stableStringify(args)}`;
}

// Extract the first balanced {...} object from `inner`, string/escape aware.
// Returns the object substring only when nothing but whitespace follows it;
// multiple or trailing JSON is ambiguous and rejected (returns null).
function extractSingleObject(inner: string): string | null {
  const start = inner.indexOf("{");
  if (start < 0) return null;
  if (inner.slice(0, start).trim().length > 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < inner.length; i += 1) {
    const ch = inner[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) {
    // The object never closes. It is unambiguously a single (truncated) object,
    // so hand the remainder to the arg-repair ladder to balance.
    return inner.slice(start);
  }
  // Anything other than whitespace after a balanced object means a second or
  // ambiguous object: reject rather than guess which one is the call.
  if (inner.slice(end + 1).trim().length > 0) return null;
  return inner.slice(start, end + 1);
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

// Turn a validated wrapper's inner text (+ optional tag-supplied name) into a
// recovered call. Returns null when the text isn't a well-formed single-object
// call; the caller then leaves the wrapper visible.
function recoverFromInner(
  inner: string,
  tagName: string | undefined,
): Recovered | null {
  const objText = extractSingleObject(inner);
  if (objText === null) return null;

  if (tagName !== undefined) {
    // <invoke name="x"> / <function=x>: the object is the arguments directly.
    const name = stripNamespace(tagName);
    if (!VALID_TOOL_NAME.test(name)) return null;
    return { name, args: parseToolArgs(objText) };
  }

  // <tool_call> / <invoke> without a name attribute: the object is
  // {name, arguments}. Repair the whole object, then read its fields.
  const parsed = asObject(parseToolArgs(objText));
  if (!parsed) return null;
  const rawName = parsed.name;
  if (typeof rawName !== "string") return null;
  const name = stripNamespace(rawName);
  if (!VALID_TOOL_NAME.test(name)) return null;
  const rawArgs = parsed.arguments ?? parsed.parameters ?? {};
  const args = typeof rawArgs === "string" ? parseToolArgs(rawArgs) : rawArgs;
  return { name, args };
}

// Find the '>' that closes an open tag starting at `from`, skipping any
// double-quoted attribute values. Returns -1 if not yet present.
function findOpenTagEnd(buf: string, from: number): number {
  let inQuote = false;
  for (let i = from; i < buf.length; i += 1) {
    const ch = buf[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ">" && !inQuote) return i;
  }
  return -1;
}

function extractNameAttr(attrs: string): string | undefined {
  const m = attrs.match(/\bname\s*=\s*"([^"]*)"/);
  return m ? m[1] : undefined;
}

type Capture =
  | { kind: "wrapper"; endIndex: number; inner: string; tagName?: string }
  | "incomplete"
  | "invalid";

// Given `buf` starting at a matched open token, try to capture a full wrapper.
function tryCapture(buf: string, token: OpenToken): Capture {
  if (token === "<tool_call") {
    let i = token.length;
    while (i < buf.length && isWs(buf[i])) i += 1;
    if (i >= buf.length) return "incomplete";
    if (buf[i] !== ">") return "invalid"; // e.g. <tool_calls>
    const openEnd = i + 1;
    const close = CLOSE_TAG[token];
    const closeStart = buf.indexOf(close, openEnd);
    if (closeStart < 0) return "incomplete";
    return {
      kind: "wrapper",
      endIndex: closeStart + close.length,
      inner: buf.slice(openEnd, closeStart),
    };
  }
  if (token === "<invoke") {
    const after = buf[token.length];
    if (after !== undefined && after !== ">" && !isWs(after)) return "invalid";
    const gt = findOpenTagEnd(buf, token.length);
    if (gt < 0) return "incomplete";
    const tagName = extractNameAttr(buf.slice(token.length, gt));
    const openEnd = gt + 1;
    const close = CLOSE_TAG[token];
    const closeStart = buf.indexOf(close, openEnd);
    if (closeStart < 0) return "incomplete";
    const capture: Capture = {
      kind: "wrapper",
      endIndex: closeStart + close.length,
      inner: buf.slice(openEnd, closeStart),
    };
    if (tagName !== undefined) capture.tagName = tagName;
    return capture;
  }
  // <function=NAME>
  let j = token.length;
  while (j < buf.length && buf[j] !== ">" && !isWs(buf[j])) j += 1;
  if (j >= buf.length) return "incomplete";
  const name = buf.slice(token.length, j);
  let k = j;
  while (k < buf.length && isWs(buf[k])) k += 1;
  if (k >= buf.length) return "incomplete";
  if (buf[k] !== ">") return "invalid";
  if (name.length === 0) return "invalid";
  const openEnd = k + 1;
  const close = CLOSE_TAG[token];
  const closeStart = buf.indexOf(close, openEnd);
  if (closeStart < 0) return "incomplete";
  return {
    kind: "wrapper",
    endIndex: closeStart + close.length,
    inner: buf.slice(openEnd, closeStart),
    tagName: name,
  };
}

function trailingBacktickRun(s: string, cap: number): number {
  let n = 0;
  for (let i = s.length - 1; i >= 0 && s[i] === "`" && n < cap; i -= 1) n += 1;
  return n;
}

// Incremental scanner. Feed text through push(); it returns visible text_delta
// events and recovered tool_call_done events in order. Wrappers inside fenced
// (```) or inline (`) code are passed through as visible text, never recovered.
export class ProseToolScanner {
  private buf = "";
  private fenceTicks = 0;
  private inlineTicks = 0;
  private atLineStart = true;
  private lineQuoted = false;
  private inDoubleQuote = false;
  private previousVisibleChar = "";
  private idCounter = 0;

  push(text: string): CanonicalEvent[] {
    this.buf += text;
    return this.drain(false);
  }

  flush(): CanonicalEvent[] {
    return this.drain(true);
  }

  private nextId(): string {
    this.idCounter += 1;
    return `prose-${this.idCounter}`;
  }

  private drain(final: boolean): CanonicalEvent[] {
    const events: CanonicalEvent[] = [];
    let out = "";
    const appendVisible = (text: string): void => {
      out += text;
      for (const ch of text) {
        if (ch === "\n") {
          this.atLineStart = true;
          this.lineQuoted = false;
        } else if (
          this.atLineStart &&
          ch !== " " &&
          ch !== "\t" &&
          ch !== "\r"
        ) {
          this.lineQuoted = ch === ">";
          this.atLineStart = false;
        }
        if (ch === '"' && this.previousVisibleChar !== "\\") {
          this.inDoubleQuote = !this.inDoubleQuote;
        } else if (ch === "“") {
          this.inDoubleQuote = true;
        } else if (ch === "”") {
          this.inDoubleQuote = false;
        }
        this.previousVisibleChar = ch;
      }
    };
    const pushText = (): void => {
      if (out.length > 0) {
        events.push({ type: "text_delta", text: out });
        out = "";
      }
    };

    for (;;) {
      if (this.buf.length === 0) break;

      if (this.fenceTicks > 0) {
        const delimiter = "`".repeat(this.fenceTicks);
        const close = this.buf.indexOf(delimiter);
        if (close >= 0) {
          appendVisible(this.buf.slice(0, close + delimiter.length));
          this.buf = this.buf.slice(close + delimiter.length);
          this.fenceTicks = 0;
          continue;
        }
        if (final) {
          appendVisible(this.buf);
          this.buf = "";
          this.fenceTicks = 0;
          break;
        }
        const hold = trailingBacktickRun(this.buf, this.fenceTicks - 1);
        appendVisible(this.buf.slice(0, this.buf.length - hold));
        this.buf = this.buf.slice(this.buf.length - hold);
        break;
      }

      if (this.inlineTicks > 0) {
        const delimiter = "`".repeat(this.inlineTicks);
        const close = this.buf.indexOf(delimiter);
        if (close >= 0) {
          appendVisible(this.buf.slice(0, close + delimiter.length));
          this.buf = this.buf.slice(close + delimiter.length);
          this.inlineTicks = 0;
          continue;
        }
        if (final) {
          appendVisible(this.buf);
          this.buf = "";
          this.inlineTicks = 0;
          break;
        }
        const hold = trailingBacktickRun(this.buf, this.inlineTicks - 1);
        appendVisible(this.buf.slice(0, this.buf.length - hold));
        this.buf = this.buf.slice(this.buf.length - hold);
        break;
      }

      // Normal mode: find the next trigger char, '<' or backtick.
      let trigger = -1;
      for (let i = 0; i < this.buf.length; i += 1) {
        const ch = this.buf[i];
        if (ch === "<" || ch === "`") {
          trigger = i;
          break;
        }
      }
      if (trigger < 0) {
        // Every token starts with '<' or a backtick; with neither present the
        // whole buffer is safe to emit (nothing can still grow into a token).
        appendVisible(this.buf);
        this.buf = "";
        break;
      }

      appendVisible(this.buf.slice(0, trigger));
      this.buf = this.buf.slice(trigger);

      if (this.buf[0] === "`") {
        const run = leadingBacktickRun(this.buf);
        if (run === this.buf.length && !final) break;
        if (run >= 3) {
          const delimiter = "`".repeat(run);
          appendVisible(delimiter);
          this.buf = this.buf.slice(run);
          this.fenceTicks = run;
          continue;
        }
        const delimiter = "`".repeat(run);
        appendVisible(delimiter);
        this.buf = this.buf.slice(run);
        this.inlineTicks = run;
        continue;
      }

      // buf starts with '<'.
      if (this.lineQuoted || this.inDoubleQuote) {
        appendVisible("<");
        this.buf = this.buf.slice(1);
        continue;
      }
      const token = OPEN_TOKENS.find((t) => this.buf.startsWith(t));
      if (token) {
        const cap = tryCapture(this.buf, token);
        if (cap === "incomplete") {
          if (final || this.buf.length > MAX_WRAPPER_LEN) {
            appendVisible(this.buf);
            this.buf = "";
            break;
          }
          break; // wait for the close tag
        }
        if (cap === "invalid") {
          appendVisible("<");
          this.buf = this.buf.slice(1);
          continue;
        }
        if (cap.endIndex > MAX_WRAPPER_LEN) {
          appendVisible(this.buf.slice(0, cap.endIndex));
          this.buf = this.buf.slice(cap.endIndex);
          continue;
        }
        const recovered = recoverFromInner(cap.inner, cap.tagName);
        if (recovered) {
          pushText();
          events.push({
            type: "tool_call_done",
            id: this.nextId(),
            name: recovered.name,
            args: recovered.args,
          });
        } else {
          // Failed recovery never discards text: leave the wrapper visible.
          appendVisible(this.buf.slice(0, cap.endIndex));
        }
        this.buf = this.buf.slice(cap.endIndex);
        continue;
      }

      if (OPEN_TOKENS.some((t) => t.startsWith(this.buf))) {
        // buf is a proper prefix of an open token (e.g. "<too"); may grow.
        if (final) {
          appendVisible(this.buf);
          this.buf = "";
          break;
        }
        break;
      }

      // A '<' that does not begin a wrapper: ordinary prose.
      appendVisible("<");
      this.buf = this.buf.slice(1);
    }

    pushText();
    return events;
  }
}

function leadingBacktickRun(s: string): number {
  let n = 0;
  while (n < s.length && s[n] === "`") n += 1;
  return n;
}

export interface ProseRecoveryOptions {
  // Disable recovery entirely (passthrough). Used to A/B or to turn the
  // compatibility layer off for a model known to emit native calls only.
  enabled?: boolean;
}

// Wrap a canonical event stream so prose-embedded tool calls are recovered.
// Native structured tool calls take precedence. Recovered calls are buffered
// until the stream reaches a terminal event so a matching provider call can
// replace the synthetic call without changing its logical position.
export async function* recoverProseToolCalls(
  events: AsyncIterable<CanonicalEvent>,
  opts: ProseRecoveryOptions = {},
): AsyncIterable<CanonicalEvent> {
  if (opts.enabled === false) {
    yield* events;
    return;
  }
  const scanner = new ProseToolScanner();
  const nativeSigs = new Set<string>();
  const buffered: CanonicalEvent[] = [];
  const recoveredIndexes = new Map<string, number>();
  let buffering = false;

  const acceptRecovered = (outputs: CanonicalEvent[]): CanonicalEvent[] => {
    const immediate: CanonicalEvent[] = [];
    for (const out of outputs) {
      if (out.type === "tool_call_done") {
        const signature = callSignature(out.name, out.args);
        if (nativeSigs.has(signature)) continue;
        buffering = true;
        if (!recoveredIndexes.has(signature)) {
          recoveredIndexes.set(signature, buffered.length);
        }
      }
      if (buffering) buffered.push(out);
      else immediate.push(out);
    }
    return immediate;
  };

  for await (const ev of events) {
    if (ev.type === "text_delta") {
      yield* acceptRecovered(scanner.push(ev.text));
      continue;
    }
    if (ev.type === "tool_call_done") {
      yield* acceptRecovered(scanner.flush());
      const signature = callSignature(ev.name, ev.args);
      nativeSigs.add(signature);
      const recoveredIndex = recoveredIndexes.get(signature);
      if (recoveredIndex !== undefined) {
        buffered[recoveredIndex] = ev;
        recoveredIndexes.delete(signature);
      } else if (buffering) buffered.push(ev);
      else yield ev;
      continue;
    }
    if (ev.type === "usage" || ev.type === "done" || ev.type === "error") {
      yield* acceptRecovered(scanner.flush());
      if (buffering) {
        buffered.push(ev);
        yield* buffered;
        buffered.length = 0;
        recoveredIndexes.clear();
        buffering = false;
      } else {
        yield ev;
      }
      continue;
    }
    // reasoning_delta, tool_call_start, tool_call_delta, tool_result pass through.
    if (buffering) buffered.push(ev);
    else yield ev;
  }

  // Stream ended without a terminal event: flush whatever remains as text.
  yield* acceptRecovered(scanner.flush());
  yield* buffered;
}

// Decorate a provider so both stream() and complete() run through recovery.
export function wrapProviderWithProseRecovery(
  provider: LLMProvider,
  opts: ProseRecoveryOptions = {},
): LLMProvider {
  const wrapped: LLMProvider = {
    name: provider.name,
    stream(req: CanonicalRequest, callOpts?: ProviderCallOptions) {
      return recoverProseToolCalls(provider.stream(req, callOpts), opts);
    },
    async complete(req: CanonicalRequest, callOpts?: ProviderCallOptions) {
      // Aggregate the recovered stream so complete() and stream() share one
      // recovery path and one behavior.
      let text = "";
      const toolCalls: { id: string; name: string; args: unknown }[] = [];
      let finishReason: CanonicalFinishReason = "stop";
      let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      for await (const ev of recoverProseToolCalls(
        provider.stream(req, callOpts),
        opts,
      )) {
        switch (ev.type) {
          case "text_delta":
            text += ev.text;
            break;
          case "tool_call_done":
            toolCalls.push({ id: ev.id, name: ev.name, args: ev.args });
            break;
          case "usage":
            usage = ev.usage;
            break;
          case "done":
            finishReason = ev.reason;
            break;
          case "error":
            throw new ProviderError(ev.message, {
              code: ev.code,
              retryable: ev.retryable,
            });
          default:
            break;
        }
      }
      return { text, toolCalls, finishReason, usage };
    },
  };
  if (provider.listModels) {
    wrapped.listModels = provider.listModels.bind(provider);
  }
  return wrapped;
}
