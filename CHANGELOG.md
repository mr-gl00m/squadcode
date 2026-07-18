# Changelog

All notable changes to this project will be documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.9.1] - 2026-07-18

### Highlights
- **Compact tool ledger is the new default REPL view.** In-flight calls render in a live window above the composer, one row per call updated in place; successes stay out of scrollback, failures always land with their error code, and every turn closes with a summary line. Ctrl+O flips to the detailed stream and retroactively replays the current turn's calls.
- **The catalog caught up with the frontier.** `claude-sonnet-5`, `claude-opus-4-8`, and `gpt-5.6` ship as first-class rows, so the documented invocations resolve on a clean install; Anthropic pricing and context windows were refreshed against current list rates.
- **The README demo can no longer drift.** `npm run demo:gif` renders the gif from the actual Ink components, replaying a scripted session through the real presentation layer.

### Added
- Compact live tool ledger (default view) with a six-row window, hidden-call rollup, failure-only scrollback, per-turn close summaries, and the Ctrl+O detail toggle with retroactive replay.
- User-wide `~/.squad/instructions.md` loads ahead of project instruction files; instruction files are deduplicated by realpath target so a symlinked `AGENTS.md` cannot load twice.
- Catalog rows for `claude-sonnet-5` and `claude-opus-4-8` (1M context, thinking, `cache_control`) and `gpt-5.6` (Responses API, reasoning).
- `npm run demo:gif`: deterministic README-gif renderer built on the real REPL components (ink-testing-library capture, ANSI to SVG, headless Chrome, ffmpeg).
- Repomap `parseCap` build option; results report `parsesSkipped`.

### Changed
- Tool output defaults to the compact view; the raw per-call stream is one Ctrl+O away instead of being the baseline.
- Repomap builds cap uncached parses at 300 per boot and leave skipped files uncached on purpose, so consecutive builds warm the cache progressively instead of one boot paying for the whole repo.
- Anthropic pricing data corrected against current list rates: `claude-opus-4-7` to $5/$25 per MTok, `claude-haiku-4-5` to $1/$5, cache reads billed at a tenth of input, and 1M context windows on current-generation rows (which moves the auto-compact trigger accordingly).
- README rewritten around the current feature set, with the rendered gif as the above-the-fold demo.

### Fixed
- Daily log files are capped at 14; older dailies from prior runs are removed instead of accumulating indefinitely.

### Internal
- FETCH spec citations in the subagent layer corrected to sections that exist in the recorded spec.

## [1.9.0] - 2026-07-13

The rollover release. It consolidates the internal 1.5 through 1.8 hardening
phases and the Phase H appetite work into one public minor release. No provider,
session, or catalog format is intentionally broken, but several unsafe fallback
paths now fail closed.

### Highlights
- **Fail-closed permission boundaries.** Plan mode beats permission bypass flags; required worktree isolation aborts instead of falling back into the user's checkout; parsed shell classification replaces whitespace matching; `.git` and `.squad` stay protected; retry escalation cannot silently widen a deny; and multi-file patch approval requires every touched scope.
- **Recoverable, inspectable sessions.** Transcript and artifact sinks redact common secret forms, atomic writes preserve mode and fsync before rename, session writers recover from failed handles, audit continuity is exposed through `squad audit verify`, and `squad doctor` explains runtime/configuration provenance.
- **A safer context pipeline.** Typed fragments carry trust, visibility, merge semantics, and byte/token caps. Project instructions refresh root-to-cwd per turn, encoded payloads are labeled without silently injecting decoded bytes, file mentions are bounded and escaped, and repeated replace-fragments do not accumulate stale context.
- **Interaction you can steer and undo.** Shell output retains both head and tail, `/diff` renders the latest turn's net changes, completion notifications support external programs and OSC9/BEL, mid-turn input queues at model boundaries, and confirmed rollback reconciles the workspace snapshot, JSONL transcript, SQLite index, and visible REPL state.
- **Local-first workflows.** `squad review` targets uncommitted/base/commit diffs with its own local model; named profiles and per-project trust gate default mode; print mode supports JSON Schema output contracts and atomic last-message files; and an opt-in local Ollama guardian advises on risky prompts and YOLO escalation without overriding deterministic policy or the human decision.

### Added
- **Prose tool-call recovery.** Local models that emit tool calls as assistant text (Hermes/Qwen `<tool_call>{json}</tool_call>`, Anthropic-style `<invoke name="tool">{json}</invoke>`, Llama `<function=tool>{json}</function>`) now recover into canonical tool calls instead of dead-ending as untooled text. One shared incremental parser runs at the provider event stream, strips `functions.`/`default_api:` name prefixes, routes arguments through the existing arg-repair ladder, and leaves wrappers in fenced code, inline code, blockquotes, or double-quoted examples visible. Complete and partial wrappers share the 64 KiB cap. Native structured tool calls take precedence, retain the provider id, and suppress matching prose in either event order. Applied to the API-backed adapters (`llm-chat`, `llm-local`, `llm-message`, `llm-response`); design note in `docs/prose-tool-recovery.md`.
- Permission-request sound controls: `/sound [on|off]`, `/notification-sound`, `--notification-sound <on|off>`, and the persistent `notifications.permissionSound` setting.
- Cross-platform Node 22/24 CI matrix, generated stream-json schema drift test, lint warning ratchet, Ink regression snapshots, and high-severity npm-audit gate.
- `squad doctor` and `squad audit verify` CLI surfaces.
- Central configuration stack with per-key origin, version, effective layer, and disabled reason.
- Typed context fragments and migrations for prompt boundaries, tool output, hooks, jobs/timers, diagnostics, repo maps, steering, project instructions, and file mentions.
- Layer-3 Base64/ROT13/Hex/URL-encoding detection at prompt/tool boundaries with audit and REPL status visibility.
- Per-turn trajectory diff tracking, turn-completion notifications, steering queue, and confirm-before-trim rollback backed by isolated shadow-Git snapshots.
- Review presets: `squad review --uncommitted`, `--base <branch>`, and `--commit <sha>`, with separate `review_model` selection.
- Built-in `local`, `cloud`, and `review` profiles plus custom profiles, `--profile`, and canonical per-project trust records.
- Root-to-cwd `.squad/instructions.md` / `AGENTS.md` ingestion refreshed at every model boundary.
- Composer upgrades: Windows paste-burst coalescing, character-count placeholders, repomap-backed `@` file completion and bounded expansion, Ctrl+G external `$VISUAL`/`$EDITOR`, and redacted persistent history with Ctrl+R search.
- Print-mode `--output-schema <file>` validation and `--output-last-message <file>` atomic output.
- Opt-in local Ollama permission guardian with secret-redacted inputs, strict bounded assessments, explicit timeout/unavailable advice, permission-overlay rendering, and YOLO review.
- **Edit fallback ladder.** Seven increasingly forgiving matchers retain the uniqueness rail and record which stage matched.
- **Post-edit diagnostics.** In-process syntax checks run at the next turn boundary, with an optional configured project command.
- `lemonade-default` catalog row for AMD Lemonade local inference.

### Changed
- Shell output uses a bounded head-and-tail representation instead of keeping only the tail.
- Plan mode and YOLO command classification use conservative parsed structures and fail closed on unsupported syntax, expansion, redirection, or executable paths.
- Worktree-isolated agents and shootout slots require successful isolation when requested and copy explicit ignored prerequisites from `.worktreeinclude`.
- Session persistence acquires its mutex before stale checks and makes terminal writer failures observable.
- The audit chain is described accurately as unkeyed continuity checking, not tamper evidence.
- `injectPreTurn` may be asynchronous; existing synchronous injectors continue to work.
- The monolithic CLI was decomposed into focused bootstrap, resolution, controller, permission, slash-command, presentation, persistence, and interaction modules. Maintained source files target 500 lines and stop at 800.

### Fixed
- Large-output sidecars no longer re-offload identical content when read, which prevents recursive artifact chains and rapidly growing cumulative input usage.
- Sanitized child environments now apply to configured hook, router, and external-CLI subprocesses.
- HTTP hooks enforce scheme, allowlist, HTTPS, and private-network rules before dispatch.
- Grep rejects overlong and nested-quantifier regular expressions; PDF reads enforce byte/page ceilings.
- Trust markers wrap every direct and synthetic untrusted-input route.
- Dependency remediation leaves no critical or high npm advisories.
- Permission bypass no longer defeats plan-mode write denial or stored deny rules.
- Failed required worktree creation can no longer execute a supposedly isolated run in the user's checkout.
- Approval scopes for ApplyPatch no longer allow a prior partial overlap to authorize new files.
- Durable writers no longer risk torn records or silently discard buffered session items after a failed handle.
- Terminal focus-in/focus-out CSI reports no longer leak visible `[I` / `[O` fragments into the interactive composer.

### Security
- The local guardian is advisory by construction. Deterministic plan, scope, path, protected-directory, deletion/archive, and checklist rails remain authoritative even when its verdict is `allow`; a `deny` verdict likewise cannot make the decision for the user.
- File mentions are restricted to repomap-indexed paths, realpath-checked inside the project, capped per file and in aggregate, and rendered as untrusted context.
- Persistent input history is secret-redacted, capped, and written atomically under `~/.squad/`.
- YOLO remains an advisory path guard plus archive/checklist workflow, not an OS sandbox. Documentation and prompts now use the honest terminology.

### Internal
- `.rnd/` reference checkouts were surveyed, distilled into `docs/rnd-harvest-2026-07-06.md`, and removed.
- Root and CLI-scoped `AGENTS.md` files encode the LOC and module-growth invariants for future contributors.
- Architectural rationale is recorded under `.why/` for typed context, CLI decomposition, and interaction/rollback.

## [1.4.0] - 2026-07-06

The CrabMeat release. Squad can now hand model selection to an external routing
brain and be driven as an executor by one, and the round trip between the two
is verified live, not just pinned on paper. No breaking changes.

### Highlights
- **`router` provider kind.** A catalog row like `{"kind": "router", "router": {"command": [...]}}` turns model selection over to an external command: Squad writes `{prompt, system?, tools[]}` to its stdin, gets back `{provider_id, model_id, rationale?}`, resolves the pair through the normal catalog, and drives the chosen model through the canonical loop. Routes once per task, not per turn. Default use case: CrabMeat.
- **stream-json is now a versioned contract.** The `init` record carries `schema_version` so a consumer can refuse before parsing, and `integration/crabmeat-contract.md` pins every record shape plus the router wire format for both repos.
- **The round trip ran green live (2026-07-06).** CrabMeat invoked Squad with `--model crabmeat-router`, Squad's router asked CrabMeat's new `crabmeat-route` endpoint, the answer (`ollama/qwen3.6:latest`) drove a real tool-using task over local Ollama, and every stdout line parsed as contract records. This was the release gate.

### Added
- `router` provider kind: `providers/router.ts`, catalog `router` config (`command`, `timeout_ms`), route-once decision caching, and a `ROUTER_FAILED` canonical error on bad exit / non-JSON / missing fields. A router must resolve to a concrete kind; a router pointing at a router loops, which the contract doc warns against.
- `schema_version` on the stream-json `init` record (`STREAM_JSON_SCHEMA_VERSION = "1"`).
- `integration/crabmeat-contract.md`: both integration directions pinned, with the live round-trip record and the lessons it produced.
- Golden replay coverage for three loop guards that only had unit coverage: multi-tool dispatch order, the `max_turns` cap, and the consecutive-failure halt (`integration-tests/golden/`, suite 6 to 9 tests).

### Changed
- Plan mode's read-only shell classifier is stricter: a classified-read-only command that carries an out-of-project path operand (absolute path outside the project, or a `..` climb) or a path-changing verb (`cd`, `Set-Location`, `Push-Location`) downgrades from auto-allow to ask.

### Fixed
- The router provider now rewrites the delegated request's `model` to the routed `model_id`. It previously forwarded the request unchanged, so the concrete adapter sent the router row's own id on the wire and Ollama 404'd on a model named `crabmeat-router`. Found by the live round-trip smoke; offline fakes ignore `req.model`, so a regression test now pins the rewrite.

### Internal
- Repo state audited and reconciled against the historical shipping docs (`docs/current-state-2026-07-04.md`); em and en dashes purged from docs and shipped prompts per house style.

## [1.3.0] - 2026-06-13

The subagent layer. No breaking changes, everything is additive (the one
`engine/loop.ts` change is an optional pre-turn hook). Ships the post-v1.2.0
harness work alongside it.

### Highlights
- **Subagents.** The `Agent` tool hands a self-contained task to a subagent running on its own model, tool allowlist, and permission ruleset, then returns one structured report. Depth is capped at 1, up to four run concurrently, and per-agent model selection is the vetting lever.
- **`squad shootout`.** Fan the same prompt across N backends at once (`--models a,b,c,d`), each in its own git worktree, and diff what they actually did: tool-call sequence, files touched, divergence point, verdict, tokens, cost, wall time. The thing Squad is built to do.
- **External CLI backends + isolation.** A subagent's `provider` can name a `kind: external-cli` catalog row to run a third-party agent CLI (codex, claude, aider); `isolation: worktree` keeps its edits in a throwaway checkout for review.

### Added
- Subagent layer under `src/agents/`: the `Agent` tool (`{ description, prompt, subagent_type }` → structured report), depth-1 spawning with a 4-slot concurrent ceiling, per-agent model + provider + permission-ruleset selection, `KT-4`-style identity, read-only anguish observability, HOWL pub/sub, AsyncLocalStorage context, scope lock, and memory ephemerality (a subagent returns one report; its working messages are discarded).
- Four built-in agents, `explorer`, `judge`, `red-team`, `reviewer`, definable/overridable as `.squad/agents/<name>.md` (project) or `~/.squad/agents/<name>.md` (user).
- `squad shootout <prompt> --models <list>` (+ `squad shootout report <run-id>` and the one-shot `--shootout` flag): concurrent multi-backend vetting with pairwise trajectory diffs, persisted under `~/.squad/shootouts/<run-id>/` (manifest + per-slot JSONL).
- External-CLI agent provider (`kind: external-cli`) and per-agent git-worktree isolation.
- Long-running primitives: `Shell` background mode (`background: true` → jobId), `JobStatus` / `JobKill`, and LLM-set timers (`SetTimer` / `CancelTimer`) that fire a synthetic notice at the next turn boundary; backed by per-session job + timer registries.
- Subagent TUI in the REPL: a panel per slot with anguish meter and current action, Tab/Shift+Tab focus cycle, a Ctrl+K kill picker, and Ctrl+C cascade into live subagents.
- Session resume/replay: `/replay [n]` plus `--replay <session-id>` / `--replay-limit <n>`.
- Retry backoff honoring server-issued `Retry-After` / `retry-after-ms`, falling back to exponential `2s · 2^attempt` capped at 30s.
- Layered permissions: user-level `~/.squad/permissions.json` with a new `[U]` (user-permanent) grant outcome; blanket grants default read-only. Delete guard for protected paths.
- `--output-format stream-json`; composable JSONL hook sink for tool-lifecycle telemetry; Shell child-process env allowlist; provider error taxonomy (retryable / model-visible / terminal); tool-schema preflight sanitizer; dispatch resolve telemetry; structured auto-compact summary template.

### Changed
- `engine/loop.ts`: an optional `injectPreTurn` hook (fired timers + finished background jobs injected before each turn) and `jobs` / `timers` threaded into `ToolContext`. Additive, no behavior change without them.
- Extracted a shared `persistEventToStore` used by both REPLs; reduced the public export surface; aligned the in-code `VERSION` constants with `package.json`.

### Removed
- Pruned unwired v1.1.x primitives (deadline-timer wiring, JSONL-sink loop emission, dead error taxonomy) and dead exports flagged by knip. (The deadline-timer primitive was later rebuilt for the timer registry.)

### Internal
- Biome (lint + format) and knip (dead-export / unused-dependency detection) tooling.
- Golden replay harness for offline agent-loop regression tests; deflake runner; advisory perf and memory baselines with committed reference numbers; release-confidence ship-gate playbook.

## [1.2.0] - 2026-05-20

Plan mode and session recap land alongside a ranked repo map and the BH-2026-05 bug-hunt fixes. No breaking changes, everything here is additive or a correctness fix.

### Highlights
- **Plan mode.** `--mode plan` / `/mode plan` drops the agent into a read-only permission profile: `Edit`/`Write`/`ApplyPatch`/`NotebookEdit` denied, reads allowed, and `Shell` classified per-command so `git status` / `ls` auto-allow while anything that could mutate asks. A hard floor, it overrides `--allowed-tools` for mutating tools and only ever makes the policy stricter.
- **Session recap.** `squad receipt <id>`, the `/receipt` slash command, a recap printed before `/clear`, and an idle auto-recap in the REPL, a markdown snapshot of goal, files touched, shell runs, tokens, outstanding todos, and next action.
- **Ranked repo map.** Tree-sitter symbol extraction + PageRank over the file-reference graph, with chat-mention personalization, so the context map leads with the files that matter to the task.
- **Eleven verified bug-hunt fixes** from the BH-2026-05-10 and BH-2026-05-20 audits, each shipped with a regression test under `test/regression/`.

### Added
- Plan mode: `src/permissions/plan.ts` (`planVerdict`, read-only Shell classifier), the `--mode plan|act` CLI flag, the `/mode` slash command, a cyan `PLAN` status-footer badge, and a plan system-prompt addendum that tells the model to read and plan rather than poke mutating tools. Plan's deny beats a user `allow` on mutating tools; sensitive denies still win. Shell classification is conservative, a command auto-allows only when every segment is a recognized read-only command (git read-only subcommands, POSIX reads, PowerShell read-only cmdlets, including pipelines and `;`-sequences), and output redirection / command substitution / `sudo` / any unrecognized verb force `ask`.
- Session recap: `src/sessions/recap.ts` (a pure renderer over session records or in-memory canonical messages), the `squad receipt <id>` subcommand, the `/receipt` slash command, and an idle auto-recap in the Ink REPL gated by `recap.idleMinutes` in `~/.squad/settings.json` (default 5, `0` disables).
- Ranked repo map under `src/repomap/`: Tree-sitter symbol extraction (`symbols.ts`, `parser.ts`, WASM grammars for Go/JS/Python/Rust/TS/TSX under `assets/repomap/wasm/`), PageRank scoring with chat-mention personalization (`pagerank.ts`), token-budget fitting (`budget.ts`), a symbol cache (`cache.ts`), and candidate rendering (`render.ts`). Wired into `src/cli/program.ts`.

### Changed
- `/clear` now prints a session recap before wiping the in-flight history, so the thread of what you were doing survives the reset.

### Fixed
- Anthropic adapter: adjacent user messages coalesce and the user-case pre-flush was dropped, keeping the alternating-roles invariant (BH-2026-05-20-001, BH-2026-05-10-002).
- Glob matching: `**` matches zero path segments via the `SENT_DSS` sentinel, and `[` / `]` are escaped as literals instead of being read as character classes (BH-2026-05-10-004, BH-2026-05-20-103).
- Tool-arg repair is string-context aware: brace/bracket balancing and trailing-comma stripping no longer corrupt `{` / `[` / `,}` that appear inside string values (BH-2026-05-20-104, BH-2026-05-10-003).
- Session sidecar paths no longer collide: assistant-message sidecars get a per-session counter and artifact sidecars are disambiguated by an id hash (BH-2026-05-20-102, BH-2026-05-20-002).
- `atomicWriteText` uses a per-call temp suffix, so concurrent writes to the same path don't clobber each other's temp file (BH-2026-05-20-101).
- `ApplyPatch` is all-or-nothing across files via a two-phase apply, a failure partway through rolls back instead of leaving a half-applied edit set (BH-2026-05-10-001).
- Hook runner sets `timedOut` from the setTimeout callback, so a hook that exceeds its budget is reported as timed out (BH-2026-05-10-005).

### Internal
- Untracked an accidentally-committed 3.5 MB backup-tool manifest (`git rm --cached`, kept on disk); gitignore now covers the audit-skill output dir `.repo-cleanup/` and backup manifests.

[1.2.0]: Plan mode, session recap, ranked repo map, and the BH-2026-05 bug-hunt fixes. Compare against v1.1.0.

## [1.1.0] - 2026-05-05

Multi-provider + YOLO release. The throughline: one canonical event stream now drives four adapter kinds, and the engine loop received zero changes across all four additions. That was the architectural test the canonical layer was designed to pass.

### Highlights
- **Four adapter kinds, one loop.** `llm-chat` (DeepSeek, gpt-4o family, Together, Groq, Fireworks, OpenRouter, any OpenAI-compatible chat-completions backend), `llm-message` (Anthropic Claude with `cache_control` and thinking), `llm-response` (OpenAI gpt-5.x and o-series via the Responses API with reasoning), `llm-local` (Ollama and other keyless local servers). Adding a new backend is a JSON catalog row, not a code change.
- **YOLO mode.** `--yolo` flag and `/yolo` slash command run the agent autonomously with three rails: cwd sandbox, archive-on-delete (rewrites `rm`/`Remove-Item`/`del`/`unlink` to `mv` into `.archive/<iso-ts>/`), and a mandatory checklist (`checklist.txt` / `CHECKLIST.md` in cwd, refuses to start otherwise).
- **Harness fold-in.** Hooks, deferred-schema tool catalog, apply-patch tool, auto-compact, oversized-output artifact storage, per-turn usage ledger, OSC-2 tab-title status, pattern-based permissions with sensitive defaults, all wired into the engine and surfaced in the REPL.

### Added
- `src/providers/catalog.ts` reads `src/providers/default-models.json` at startup; `~/.squad/models.json` is a user override that merges by id with override-wins semantics. Aliases let `--model deepseek-v4-flash` resolve to `deepseek-chat` without duplicating the row.
- `src/providers/llm-chat.ts` generic OpenAI-compatible chat-completions adapter with capability flags (`tool_use`, `cache_control`, `reasoning`).
- `src/providers/llm-local.ts` thin wrapper for Ollama-style local servers (URL normalization, placeholder API key, SSRF guard against `OLLAMA_ALLOW_REMOTE=0`).
- `src/providers/llm-message.ts` Anthropic Messages API adapter. `cache_control` ephemeral markers on the system prompt's last block and the last tool entry when the capability flag is set. Thinking blocks surface as canonical `reasoning_delta`. `cache_creation` + `cache_read` fold into `inputTokens` for total accounting; `cache_read` separately reports as `cachedInputTokens` so `/cost` math reflects the savings. Tool-result coalescing keeps the alternating-roles invariant.
- `src/providers/llm-response.ts` OpenAI Responses API adapter. Output items tracked by `output_index`. Function-call args accumulate across `response.function_call_arguments.delta` events. `reasoning` capability gates `reasoning: { effort, summary }` on the request; `response.reasoning.delta` and `response.reasoning_summary_text.delta` both feed canonical `reasoning_delta`. `cached_tokens` from `input_tokens_details` surfaces as `cachedInputTokens` (Responses auto-caches >~1024-token inputs).
- `src/providers/dispatch.ts` maps a catalog entry to the right adapter factory.
- `@anthropic-ai/sdk` dependency.
- YOLO mode: `src/yolo/index.ts` (sandbox guard, archive-on-delete rewrite, system-prompt addendum), `src/yolo/checklist.ts` (gate). Wired into `ToolContext.yolo`, `AgentLoopOptions.yolo`, and both REPLs. The Ink REPL paints a red `YOLO` badge in the status footer when armed. `/yolo` toggles mid-session in either direction; turning on re-checks the checklist.
- Hook runner (`src/hooks/{config,match,runner}.ts`) firing `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`. Settings live under `~/.squad/settings.json` and `.squad/settings.json`.
- `src/tools/apply-patch.ts` unified-diff editor for multi-file edits in one tool call.
- `src/tools/tool-search.ts` deferred-schema discovery, large tool catalogs hide their full JSON Schema until the model loads them via `select:` or keyword query, keeping the request payload small.
- `src/engine/auto-compact.ts` context-pressure trigger that summarizes the conversation when input tokens approach the model's window. Replaces older history with a structured summary; tail turns preserved verbatim.
- `src/sessions/artifacts.ts` offloads oversized tool output to `~/.squad/sessions/<id>/artifacts/<call-id>.txt`; the in-context message gets a short reference instead of the full body. Reads of those artifact paths are auto-allowed even though they live outside cwd.
- `src/sessions/usage-ledger.ts` per-turn token + cost rows in SQLite (migration `0002`). `squad usage` and the `/usage` slash command surface totals by session, cwd, day, model. Anthropic cache_read savings show in the math; DeepSeek's auto-cache surfaces in usage too where the API exposes it.
- `src/cli/tab-title.ts` writes OSC-2 sequences so the terminal tab title reflects the current REPL state (`squad: thinking`, `squad: tool: Read`, etc.).
- Pattern-based permission rules in `.squad/settings.json`: `permissions.rules` is `{ ToolName: { pattern: "allow"|"deny"|"ask" } }` with per-tool, glob-aware scope. Specificity-sorted matching (longer patterns win). Sensitive defaults baked in: `**/.env` asks, `**/.env.example` allows, `**/id_rsa` and `**/.ssh/config` deny. The legacy `permissions.alwaysAllowed: ["ToolName"]` array still loads for backward compatibility.
- `[a]lways for this session` and `[p]ermanently for this project` permission outcomes now broaden scope intelligently. `Shell` grants apply to the arity-prefixed verb (`git *`, `npm install *`, `npm run dev *`, `docker compose up *`, `cargo install *`). `Read`/`Edit`/`Write` grants apply to the file's parent directory glob (`src/foo/*`) so a single approval covers sibling files. Repo-root files keep their literal scope so `[A]`/`[P]` can't accidentally widen to `*`.
- `--yolo` CLI flag, `/yolo` slash command, red `YOLO` status-footer badge.
- Repeated-call guard in `src/engine/loop.ts`: aborts the agent loop when the same tool call (canonicalized name + args) shows up on three consecutive turns with no fresh signature mixed in. A turn that introduces a new signature resets all streaks, so explore-glob-read-glob loops aren't false-positives.

### Changed
- `ProviderName` widened from a closed union to `string` so arbitrary catalog `provider_id`s work without a type change.
- `AI_DEFAULT_PROVIDER` env now accepts any string (catalog-driven), defaulting to `deepseek`.
- `src/cli/program.ts` rewired through `loadCatalog` + `dispatchProvider`. `/provider <name>` switches via the catalog. `--provider <name>` resolves to the catalog's first entry for that provider, refinable with `--model` or `/model`.
- `defaultSystemPrompt` builds a lighter base prompt at REPL start; YOLO appends a rail-explanation block + the loaded checklist contents on top when armed.
- `--dangerously-skip-permissions` and `--yolo` are now distinct: the former skips prompts and that's it; the latter skips prompts AND adds the three rails AND requires a checklist. Both still exist on purpose.

### Removed
- `src/providers/deepseek.ts` and `src/providers/ollama.ts` deleted. Both were 95%-identical OpenAI-compatible chat-completions adapters; their behavior is now `llm-chat` with capability flags and `llm-local` with URL normalization. `test/manual/abort-stream.ts` ported to the new dispatch path.

### Security
- SSRF guard in `llm-local`: when the catalog row's base URL points at a non-loopback host, the adapter refuses unless `OLLAMA_ALLOW_REMOTE=1` is set in the environment, and logs a warning per call when used.
- YOLO sandbox: absolute paths outside cwd, and `cd` / `Set-Location` targets that resolve outside cwd, are rejected by the `Shell` tool with a structured `YOLO_SANDBOX_VIOLATION` error code. The model sees the rejection and self-corrects.
- YOLO archive: deletes are not executed, `rm`, `Remove-Item`, `del`, `unlink` get rewritten to a `mv` into `.archive/<iso-ts>/`. The rewrite note is prepended to the tool result so the model knows the file moved, not vanished. `mkdir -p` (POSIX) / `New-Item -ItemType Directory -Force` (PowerShell) ensures the archive dir exists before the move.

[1.1.0]: First multi-provider release. Compare against v1.0.0.

## [1.0.0] - 2026-05-03

First release. Everything below is new.

### Highlights
- Provider-neutral agent loop. Each provider adapter normalizes its native stream into one `CanonicalEvent` union (`text_delta`, `tool_call_done`, `tool_result`, `usage`, `done`, `error`); the loop in `src/engine/loop.ts` never sees provider-specific wire formats.
- Five MVP commands verified end-to-end on real DeepSeek: `squad`, `squad -p "summarize src/"`, `squad -p "find likely bugs"`, `squad --model <name> -p "review this patch"`, `squad --resume`.
- Local-first persistence, JSONL transcripts plus a `prev_hash`-linked SQLite audit chain, both under `~/.squad/`.

### Added
- DeepSeek provider via OpenAI-compatible endpoint, Ollama provider via `/api/chat`. Adding another provider means writing one adapter, not touching the loop.
- Tool registry: `Read`, `Write`, `Edit`, `Shell`, `Grep`, `Glob`, `TodoWrite`. Path-traversal validation on every filesystem-touching call; symlinks resolved with `realpath` and re-checked against the cwd-anchored allowed root.
- Permission policy with read-only auto-allow and mutating-prompt defaults. `--allowed-tools`, `--disallowed-tools`, and `--dangerously-skip-permissions` flags scope per-invocation.
- Per-project persistent permission grants written to `.squad/settings.json` so a `Shell npm test` approval survives across sessions in that project. `SQUAD_PROJECT_PERMS=0` opts out.
- Ink REPL with status line (provider, model, turn count, token usage), Ctrl-C interrupt, and slash commands: `/provider`, `/model`, `/clear`, `/compact`, `/cost`, `/tools`, `/sessions`, `/skills`, `/help`, `/exit`. `--simple` falls back to readline for plain terminals.
- JSONL session transcripts at `~/.squad/sessions/<id>.jsonl`, append-only with `fsync` per turn. SQLite session index at `~/.squad/sessions.db` for fast `squad sessions list` and `squad sessions show <id>`.
- `--resume [id]` and `--continue` flags. Resume picks the most recent session for the current cwd if no id is given.
- Audit chain at `~/.squad/audit.db` (WAL, parameterized statements only). Every prompt, tool call, tool result, and permission decision lands as a row with a `prev_hash` link to the prior row.
- Pino structured logger writing JSON lines to `~/.squad/logs/squad.log` with rotation.
- Skill loader that picks up `.md` skill definitions from a configurable set of skill directories under the user's home directory and `.squad/skills/` in the project. Loaded skills are invocable as `/<skill-name>` slash commands inside the REPL.

### Security
- Per the SIGIL threat model in `PROJECT_CHARTER.md`: structural trust markers (`<USER_PROMPT>`, `<TOOL_OUTPUT tool="...">`) wrap every untrusted input before it lands in the model context. Persona stability preamble treats role-reassignment language inside untrusted regions as data, never as commands.
- Provider URL validation: `https://` only for cloud providers, `http://localhost:` only for Ollama unless `OLLAMA_ALLOW_REMOTE=1` is explicitly set (logs a warning per call when used).
- API keys redacted from log output via pino redactor; never echoed to stdout, never written into transcripts.

[1.0.0]: First release, no prior version to compare against.
[1.9.0]: Rollover hardening, recovery, context, interaction, and local-first workflow release. Compare against v1.4.0.
[1.9.1]: https://github.com/mr-gl00m/squadcode/compare/v1.9.0...v1.9.1
[Unreleased]: https://github.com/mr-gl00m/squadcode/compare/v1.9.1...HEAD
