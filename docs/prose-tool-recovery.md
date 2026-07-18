# Prose tool-call recovery

A compatibility layer for local models that emit tool calls as assistant text
instead of as structured tool calls. It runs one level before `arg-repair.ts`,
at the shared canonical event stream, so all three provider adapters get it
through a single implementation.

This is not a general XML or HTML parser. It recognizes exactly three bounded
wrapper forms, each carrying exactly one JSON object, and nothing else. Anything
it does not recognize is left in the visible assistant text untouched.

## Why it exists

Hermes, Qwen, and Llama derivatives frequently return a tool call inside prose:
the provider reports a normal text completion with no structured tool call, and
the harness would otherwise dead-end with "streamed text but no tool calls." The
`.rnd` harvest (`docs/rnd-harvest-2026-07-06.md`) flagged this as the highest
value remaining local-model harness item. This layer rescues those responses by
turning the prose wrapper into the same canonical `tool_call_done` a native
provider call produces.

## Grammar

Three opening tokens, each with a fixed closing tag:

| Dialect | Form | Name from | Body is |
|---|---|---|---|
| Hermes / Qwen | `<tool_call>{ json }</tool_call>` | the JSON `name` field | `{ "name": ..., "arguments": {...} }` |
| Anthropic-style | `<invoke name="tool">{ json }</invoke>` | the `name` attribute | the arguments object |
| Anthropic-style | `<invoke>{ json }</invoke>` | the JSON `name` field | `{ "name": ..., "arguments": {...} }` |
| Llama | `<function=tool>{ json }</function>` | the opening tag | the arguments object |

`parameters` is accepted as a synonym for `arguments`. The JSON body always runs
through the existing `arg-repair.ts` ladder, so a trailing comma or a truncated
object still recovers.

### Namespace normalization

Some backends prefix the tool name. Leading `functions.`, `default_api.`, and
`default_api:` are stripped, repeatedly, so `functions.default_api.Read` becomes
`Read`.

### Tool-name validation

A recovered name must match `^[A-Za-z0-9_.-]+$` after namespace stripping.
Allowed punctuation is dot, underscore, and hyphen. A name with any other
character (space, quote, bracket) means the parse was wrong, and the wrapper is
left as visible text rather than recovered.

## Incremental parsing

The scanner is a single pass over the streamed text. Ordinary text streams out
with minimal delay. A wrapper may span any number of chunks; a partial opening
token at a chunk boundary is buffered only up to the length of the longest
opening token, and a wrapper being captured is buffered up to a 64 KiB body cap.
Every character in the input either streams out as visible text or is consumed by
a recovered wrapper. Nothing is dropped.

## Limits and safety

- **Size cap.** A wrapper above 64 KiB is emitted as visible text whether it is
  complete or unterminated. The argument JSON itself is additionally
  bounded by `arg-repair.ts` (1 MiB).
- **Single object only.** A wrapper containing two or more JSON objects
  (`<tool_call>{}{}</tool_call>`) is ambiguous and rejected: the whole wrapper
  stays visible.
- **Linear work.** The scan is linear over bounded input. There is no nested
  re-scanning and no quadratic backtracking.
- **Code is not a call.** A wrapper inside a fenced code block (```` ``` ````) or
  inline code (`` ` ``) is never recovered. This is the false-positive defense
  for documentation and examples that quote the wrapper syntax.
- **Failed recovery never discards text.** If the body will not parse into a
  named call, or the wrapper never closes before end of stream, the exact
  original text is emitted as visible prose.

## Precedence

- **Native structured tool calls win.** A native `tool_call_done` whose `(name,
  args)` matches a recovered call replaces it, retaining the provider-issued id.
  A recovered call matching an earlier native call is discarded. A native call
  that differs from any recovered call passes through normally.
- **Recovery does not change finish-reason handling.** The agent loop decides
  whether to continue from the presence of tool calls, not from the finish
  reason, so recovery emits `tool_call_done` and leaves `usage` and `done`
  untouched.

## Integration point

`wrapProviderWithProseRecovery` decorates an `LLMProvider` so both `stream()` and
`complete()` run their canonical event stream through `recoverProseToolCalls`.
The decorator is applied in `dispatchProvider` to the four API-backed kinds
(`llm-chat`, `llm-local`, `llm-message`, `llm-response`). It is not applied to
`router` (which delegates to a model that is itself dispatched, and so already
wrapped) or `external-cli` (which does its own output parsing).

## Known ceiling

- The false-positive defense covers Markdown backtick fences, inline code spans,
  blockquotes, and examples inside straight or curly double quotes. A wrapper
  inside single quotes in plain prose is still eligible for recovery.
- Fence detection keys on backtick runs, not on full CommonMark block structure.
  A wrapper inside an indented (four-space) code block is not
  recognized as code and may be recovered.
- Recovered call ids are `prose-<n>`, unique within one response. They are not
  globally unique across responses, which is sufficient because the agent loop
  only needs uniqueness within a turn.
