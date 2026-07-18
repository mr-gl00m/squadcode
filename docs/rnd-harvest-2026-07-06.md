# .rnd harvest, 2026-07-06

Four reference checkouts lived under `.rnd/`: opencode-dev (v1.15.10, MIT,
TypeScript), forge-main (v2.3.0, AGPL-3.0, Rust), smallcode-master (v0.9.6,
MIT, Node), lemonade-10.8.0 (Apache-2.0, C++ local inference server). All four
were surveyed, the items below were either shipped this pass or queued, and
the checkouts were deleted. Everything worth keeping is in this file or in
src/. Re-fetch from GitHub if a deep re-read is ever needed.

License note: forge is AGPL. Patterns were studied, no code was copied. The
edit ladder and diagnostics implementations are written fresh against the
OpenCode (MIT) algorithm descriptions and Squad house style.

## Shipped this pass

- **Edit fallback ladder** (`src/tools/edit-match.ts`). Seven stages: exact,
  line-trimmed, whitespace-normalized, indentation-flexible,
  escape-normalized, trimmed-boundary, block-anchor (Levenshtein middle
  similarity, 0.3 threshold on multi-candidate, span cap). Uniqueness rail on
  every stage; ambiguity refuses rather than guesses. OpenCode runs the same
  shape with 9 stages; forge with 3; both enforce unique-match-or-refuse.
  Squad reports the matching stage in the tool result ("matched via
  line-trimmed fallback"), which doubles as vetting data: how sloppy was the
  model's old_string.
- **Post-edit diagnostics** (`src/engine/post-edit-diagnostics.ts`). Tier 1:
  in-process tree-sitter ERROR/missing scan over touched ts/tsx/js/py/rs/go
  plus JSON.parse for .json, drained at the turn boundary through the
  pre-turn injector. Tier 2 (opt-in): `.squad/settings.json`
  `{"diagnostics": {"command": "npm run typecheck"}}`, never auto-detected.
  OpenCode does this with a live LSP client (150ms debounce, errors-only,
  20-cap); smallcode auto-detects tsc/cargo/ruff from marker files; forge
  injects LSP results as pending hints. Squad's version is deterministic-first
  and subprocess-free by default, which fits the local-model vetting mission:
  a wrong-syntax edit gets caught in milliseconds without an LSP server.
- **Lemonade catalog row** (`lemonade-default`, kind `llm-local`, port 13305,
  `LEMONADE_BASE_URL` override). Lemonade is AMD's local inference server;
  it exposes OpenAI-compatible `/v1` like Ollama does, so the existing
  llm-local adapter covers it. Model ids are opaque catalog names
  (`Qwen3-0.6B-GGUF`) or dot-namespaced cloud routes (`fireworks.kimi-k2p5`);
  Squad already treats model ids as opaque strings. Any API key value is
  accepted when the server has no key configured.

## Queued (worth building, not this pass)

- **Prose tool-call recovery** (from forge `tool_recovery.rs`, pattern only).
  Local models emit tool calls as text: Hermes/Qwen `<tool_call>{json}`,
  Anthropic-style `<invoke>`, Llama `<function=name>{json}`. A parser at the
  provider boundary that recovers these into structured calls, strips them
  from visible text, and normalizes wrapper namespaces (`functions.`,
  `default_api:`) would rescue whole model families that currently dead-end
  with "streamed text but no tool calls". Sits next to arg-repair.ts; same
  spirit, one level earlier. Probably the highest-value remaining local-model
  harness item.
- **Prune-before-summarize compaction.** forge and OpenCode both truncate
  large old tool outputs (keep head + marker, protect recent N messages)
  before paying for an LLM summary. Squad's auto-compact goes straight to
  the summary. A zero-LLM prune pass first would cut compaction cost and
  keep more verbatim context.
- **Per-model capability profiles** (from smallcode `src/model/profiles.js`):
  context length, tool format, strengths per model id with fuzzy prefix
  match, TOML overrides. Squad's catalog capabilities block is the natural
  home; would let the vetting harness assert expected-vs-observed behavior.
- **Deterministic bench suites** (from smallcode `bench/harness.js`): small
  task sets, fresh temp workspace per task, deterministic file-content
  verify, pass/fail + duration + tool-call count per model. `squad shootout`
  already fans out; a canned suite with deterministic verifiers is the
  missing piece for repeatable vetting runs.
- **Shell error fast-path diagnosis** (from forge `pattern_diagnose`):
  pre-canned advice for "command not found" / "permission denied" /
  "address already in use" injected on shell failure, no LLM call. Cheap,
  helps small models recover.

## Explicitly not adopted

- **LSP client subsystem.** Real LSP servers per language per root (OpenCode
  `lsp/client.ts`) is the max-fidelity version of post-edit diagnostics.
  Heavy: server lifecycle, per-language installs, push/pull dedup. Tier 1
  tree-sitter catches the syntax class of breakage; the settings command
  covers type errors on projects that opt in. Revisit only if vetting data
  shows type-level breakage the current tiers miss.
- **Ollama native-adapter workaround** (forge routes ollama through `/v1`
  because the native adapter leaves Hermes tool-call XML unparsed): Squad
  already talks to Ollama through the OpenAI-compatible `/v1` endpoint, so
  the failure mode doesn't exist here. The prose-recovery item above covers
  the residual cases.
- **MarrowScript/BoneScript DSL layer** (smallcode's authoring format):
  interesting but orthogonal; Squad is plain TypeScript by charter.
