# Work Order 02 stop report: Prose Tool Recovery

Date: 2026-07-12
Working directory: N:\proj_ai_squad_code
Branch: `release/v1.9.0` (continued from the reviewed WO 01 tree; no commits made)

## Architecture chosen

One shared incremental parser over the canonical `CanonicalEvent` stream, applied
once as a provider decorator. The seam is `src/providers/prose-tool-recovery.ts`:

- `ProseToolScanner`: a single-pass incremental state machine. `push(text)`
  returns visible `text_delta` events plus recovered `tool_call_done` events;
  `flush()` drains the tail at end of stream.
- `recoverProseToolCalls(events)`: wraps an `AsyncIterable<CanonicalEvent>`,
  runs `text_delta` through the scanner, passes everything else through, flushes
  at the terminal event, and dedups native calls against recovered ones.
- `wrapProviderWithProseRecovery(provider)`: decorates an `LLMProvider` so both
  `stream()` and `complete()` share the one recovery path.

Wired in `src/providers/dispatch.ts` (the sole provider construction chokepoint)
for the four API-backed kinds only: `llm-chat`, `llm-local`, `llm-message`,
`llm-response`. Not applied to `router` (delegates to a model that is itself
dispatched and so already wrapped) or `external-cli` (does its own parsing).

Alternatives weighed and rejected: recovery inside each adapter's `stream()`
(three parsers that drift; the brief forbade this), and recovery in
`engine/loop.ts` (under the AGENTS.md stability constraint, and a provider concern
does not belong in the loop). The canonical event stream is the one representation
all adapters converge on, so a transform over it is the single seam by
construction.

Key architecture fact confirmed by reading the loop: `engine/loop.ts` decides
turn continuation purely from `pendingCalls.length` (populated from
`tool_call_done`), never from the finish reason. So recovery emits `tool_call_done`
and leaves `usage`/`done` untouched, preserving current finish-reason handling.

## Files changed

New:
- `src/providers/prose-tool-recovery.ts` (546 lines; under the 800 hard cap, over the 500 target, single cohesive responsibility)
- `test/prose-tool-recovery.test.ts` (30 unit tests)
- `test/prose-tool-recovery-integration.test.ts` (1 offline golden loop integration)
- `docs/prose-tool-recovery.md` (design note)
- `.why/prose-tool-recovery-2026-07-12.md` (architectural memory)

Modified:
- `src/providers/dispatch.ts` (extracted `dispatchProviderRaw`; wrap API-backed kinds)
- `CHANGELOG.md` (Unreleased / Added entry)
- `checklist.txt` (backlog item marked done)

`src/engine/loop.ts` was not touched.

## Grammar supported

| Dialect | Form | Name source | Body |
|---|---|---|---|
| Hermes / Qwen | `<tool_call>{json}</tool_call>` | JSON `name` | `{name, arguments}` |
| Anthropic-style | `<invoke name="tool">{json}</invoke>` | `name` attribute | arguments object |
| Anthropic-style | `<invoke>{json}</invoke>` | JSON `name` | `{name, arguments}` |
| Llama | `<function=tool>{json}</function>` | opening tag | arguments object |

`parameters` accepted as a synonym for `arguments`. Name prefixes `functions.`,
`default_api.`, `default_api:` stripped (repeatedly). Recovered name validated
against `^[A-Za-z0-9_.-]+$`. Arguments routed through the existing
`arg-repair.ts` ladder.

## Limits

- Wrapper cap 64 KiB (complete or unterminated oversized input stays visible);
  argument JSON additionally bounded by arg-repair's 1 MiB cap.
- Single JSON object per wrapper; two or more is ambiguous and rejected (stays
  visible).
- Linear single-pass scan; no quadratic backtracking.
- Wrappers inside fenced (```` ``` ````) or inline (`` ` ``) code are never
  recovered.
- Failed recovery never discards text: an unparseable body or an unterminated
  wrapper is emitted verbatim as visible prose.
- Native structured tool calls take precedence: a native `tool_call_done` whose
  `(name, args)` matches a recovered call replaces it and retains the provider id.

## Commands and results

| Command | Result |
|---|---|
| `npm run typecheck` | pass (exit 0) |
| `npm test` | 877 passed, 3 skipped (880 total), 97 files (exit 0) |
| `npm run lint` | 0 errors, 151/169 warnings, 67/68 infos (exit 0; == baseline) |
| `npm run build` | pass (exit 0) |
| `npx vitest run test/loc-policy.test.ts` | 2 passed |
| `npm run deflake -- --runs=20 --command="npx vitest run test/prose-tool-recovery*.test.ts"` | 20/20 passed, 100%, deterministic |

Baseline before this work order (the reviewed WO 01 tree): 846 passed, 3 skipped.
Net new: +31 tests (30 unit + 1 integration). No baseline test regressed.

## Test coverage (matrix)

Each supported wrapper; namespace normalization; one-character chunking; every
split point across a representative wrapper; prose before/after; two wrappers;
arg-repair of trailing comma and unclosed object; unrecoverable body preserved as
text; fenced, inline-code, blockquote, and quoted-example false positives;
ordinary angle brackets as prose; unterminated wrapper; oversized wrapper;
multiple-objects rejection; native-only passthrough; native+prose dedup; native
differing from recovered; allowed vs rejected tool-name punctuation; unicode
arguments; CRLF; disabled passthrough; collision-resistant ids. Plus one offline
golden integration driving `runAgentLoop` from a prose wrapper to a `tool_result`.

## Deferred cases

- A wrapper inside a four-space indented code block or single quotes in plain
  prose is still eligible for recovery. Documented in the design note's ceiling
  section.
- Short-form ambiguity is out of scope here (this layer is tag-delimited, not
  flag-based).
- The "model emits both a native call and a different prose call in one turn"
  case executes both; only same-`(name, args)` duplicates are suppressed.

## Public behavior change

- Local-model responses that previously streamed a tool call as visible text and
  then stalled now execute the tool. For a model that emits native structured
  tool calls, behavior is unchanged (the layer is a near-zero-cost passthrough).
- No provider request conversion changed. No schema or migration. No usage or
  finish-reason handling changed. No commit, tag, or external API call.
