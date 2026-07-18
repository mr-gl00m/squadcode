# Squad Code: Project Doc

**Created:** 2026-05-01
**Status:** v1.9.0 prepared 2026-07-10, the rollover release: fail-closed permission hardening, durable persistence, typed context, decomposed CLI modules, rollback/steering interaction upgrades, review and profile workflows, structured print contracts, and the opt-in local guardian. Package/CLI report `1.9.0`; v1.4.0 is tagged at the remediated CrabMeat boundary. Prior tags: v1.0.0 (2026-05-03), v1.1.0, v1.2.0, v1.3.0 (2026-06-13), v1.4.0 (2026-07-10).
**Charter:** ./PROJECT_CHARTER.md
**Checklist:** ./checklist.txt
**Pitch:** ./docs/squad-code-pitch.md
**Shipping plan:** ./SHIPPING.md

## What it is

A local-first command-line agent that gives you the modern streaming-agent CLI shape, streaming chat, tool use, sessions, permissions, but routes through any frontier model via a single canonical event stream. One binary, one config, multiple providers behind one adapter interface. The MVP runs on DeepSeek; OpenAI and Anthropic adapters land after the canonical loop is proven.

## What it does

- Streams model output to the terminal with Ctrl-C interrupt mid-stream.
- Runs a tool loop with `Read`, `Write`, `Edit`, `Shell`, `Grep`, `Glob`, `TodoWrite`, gated by an ask/allow/deny permission policy.
- Switches provider and model live via `/provider` and `/model` slash commands or the `--model` flag, with `.env`-driven defaults.
- Writes JSONL transcripts of every turn (provider, model, cwd, messages, tool results, usage) to disk for replay and grep.
- Resumes the last session with `--resume` or replays a specific session by ID.
- Wraps every untrusted input (user prompts, tool outputs, file mentions, project instructions, and synthetic context) in escaped typed fragments before model inputs land. Base64, ROT13, Hex, and URL-encoded payloads are detected and labeled at the boundary without silently injecting decoded bytes.
- Hashes metadata for every prompt, tool call, tool result, and permission decision into a SQLite continuity chain with `prev_hash` linking, separately from JSONL transcripts. Payloads are not stored in that table, and the unkeyed chain is not a security boundary against deliberate recomputation.

## How it will be built

Six phases through MVP ship. Each phase ends end-to-end runnable. Libraries, file layout, and code structure are deferred to the scaffolding pass that runs after this doc, the phase ladder is what to build, not how.

### Phase 0: Scaffold
**Goal:** Node 22+ TypeScript project with commander wired, zod-validated `.env` loading, and `squad --help` / `squad --version` running.
**Outputs:**
- Runnable `squad --help` and `squad --version` from the `tsc`-built binary.
- `.env.example` documenting every variable from the pitch's `.env` contract.
- `~/.squad/` directory created on first run with atomic `settings.json`.
- Pino rotating logger writing to `~/.squad/logs/squad.log`.
- `LICENSE` file (MIT) at project root.

### Phase 1: Canonical event model + DeepSeek adapter
**Goal:** `squad -p "hello"` streams text from DeepSeek to the terminal, end-to-end, no tools yet.
**Outputs:**
- `providers/types.ts` defining `LLMProvider`, `CanonicalRequest`, `CanonicalResponse`, and the `CanonicalEvent` union (`text_delta`, `tool_call_start`, `tool_call_delta`, `tool_call_done`, `usage`, `done`, `error`).
- `providers/deepseek.ts` implementing `LLMProvider` against DeepSeek's OpenAI-compatible endpoint via the `openai` SDK with base-URL override.
- `engine/stream.ts` driving the conversation in one-shot mode.
- `cli/print.ts` rendering canonical events to stdout.
- Manual smoke test: `squad -p "hello"` produces streaming output from a real DeepSeek call.

### Phase 2: Tool loop + permissions
**Goal:** The agent calls tools end-to-end, gated by permission prompts, with `--allowed-tools` / `--disallowed-tools` / `--dangerously-skip-permissions` working.
**Outputs:**
- `tools/` with `Read`, `Write`, `Edit`, `Shell`, `Grep`, `Glob`, `TodoWrite` and a shared `Tool` interface.
- `permissions/policy.ts` enforcing read-only auto-allow vs. mutating-prompt defaults.
- `permissions/prompt.ts` with a synchronous TTY prompt for ask-mode decisions, falling back to `~/.squad/pending/` for non-interactive contexts.
- `engine/loop.ts` running stream → collect tool calls → execute → append → continue until no more tool calls or `max_turns` hits.
- Path-traversal validation on every filesystem-touching tool against the cwd-anchored allowed root.
- Manual smoke test: `squad -p "list .ts files in src"` triggers a `Glob` (auto-allowed), `squad -p "create README.md"` triggers a `Write` permission prompt.

### Phase 3: Ink REPL
**Goal:** Interactive `squad` (no `-p`) opens a streaming Ink REPL with slash commands and a status line.
**Outputs:**
- `cli/repl.tsx` (Ink) with prompt box, streaming output region, Ctrl-C interrupt wiring, status line showing provider/model/turn-count/tokens.
- Slash commands: `/provider <name>`, `/model <name>`, `/clear`, `/resume`, `/help`.
- `--simple` flag falls back to readline for plain terminals.
- Manual smoke test: full conversation in the REPL with at least one `/model` switch and one Ctrl-C interrupt.

### Phase 4: Sessions + audit chain
**Goal:** Every conversation writes a JSONL transcript and a chained audit log; `squad --resume`, `squad --continue`, `squad sessions list`, `squad sessions show <id>` all work.
**Outputs:**
- `sessions/writer.ts` appending JSONL turns atomically to `~/.squad/sessions/<id>.jsonl` with `fsync` per turn.
- `sessions/index.ts` (SQLite) for fast listing/searching by date, model, cwd.
- `audit/chain.ts` writing `prev_hash`-linked rows into `~/.squad/audit.db` for every prompt, tool call, tool result, and permission decision.
- `cli/sessions.ts` implementing the `sessions list` and `sessions show` subcommands.
- `--resume` and `--continue` flags wired into the engine so the next turn replays the prior context.
- Migration script `migrations/0001_init.sql` creating `audit_log` and `sessions_index` tables.
- Manual smoke test: run a session, kill the process mid-turn, restart with `--resume`, verify the conversation continues correctly and the audit chain validates end-to-end.

### Phase 5: Ship MVP
**Goal:** All five MVP commands verified on real DeepSeek, README written, `v1.0.0` tag pushed.
**Outputs:**
- All five commands from the ship criterion run cleanly on a real DeepSeek key with no manual intervention.
- `README.md` rewritten as a real release-quality README.
- `v1.0.0` tag on the local git repo.
- `CHANGELOG.md` and release notes initialized for v1.0.0.

## Ship criterion

The five MVP commands (`squad`, `squad -p "summarize src/"`, `squad -p "find likely bugs"`, `squad --model deepseek-v4-pro -p "review this patch"`, `squad --resume`) all stream through DeepSeek end-to-end on real API calls, with the tool loop, permission prompts, and JSONL transcripts working.

## v1.1: Multi-provider + YOLO release

The catalog-driven dispatch refactor + the three new adapter kinds, plus YOLO mode for autonomous runs. Ollama already shipped in v1.0; `cloud first then Ollama` no longer reflects the actual sequencing. Phase ladder for v1.1:

### Phase 6: Catalog scaffold
**Goal:** A read-at-startup model catalog that maps model id → adapter kind, base URL, env-key var, capabilities. User override at `~/.squad/models.json` merges by id.
**Outputs:** `src/providers/catalog.ts`, `src/providers/default-models.json` seed, `scripts/copy-assets.mjs` build copy step.

### Phase 7: Catalog-driven dispatch
**Goal:** Generalize the v1.0 `deepseek.ts`/`ollama.ts` (95% identical) into one `llm-chat.ts` adapter configured by capability flags + `llm-local.ts` thin wrapper. CLI dispatches through `src/providers/dispatch.ts`. Existing `.env`-driven URL/model defaults keep working.
**Outputs:** `src/providers/llm-chat.ts`, `src/providers/llm-local.ts`, `src/providers/dispatch.ts`. Legacy adapters deleted.

### Phase 8: llm-message (Anthropic)
**Goal:** Anthropic Messages API adapter with `cache_control` plumbing (system + last tool entry → ephemeral breakpoints), thinking blocks → canonical `reasoning_delta`, tool_result coalescing for the alternating-roles invariant.
**Outputs:** `src/providers/llm-message.ts`, `@anthropic-ai/sdk` dep added, `ANTHROPIC_MODEL` env default.

### Phase 9: llm-response (OpenAI Responses API)
**Goal:** OpenAI gpt-5.x and o-series via the Responses API. Output items tracked by `output_index`. Function-call args streamed via dedicated event types. Reasoning content surfaces as canonical `reasoning_delta` from both `response.reasoning.delta` and `response.reasoning_summary_text.delta`.
**Outputs:** `src/providers/llm-response.ts`.

### Phase 10: YOLO mode + permission rework
**Goal:** Autonomous-run mode (`--yolo` / `/yolo`) with sandbox + archive-on-delete + mandatory checklist rails. Permission `[A]`/`[P]` scope broadened (arity-prefix for Shell, parent-dir glob for path tools).
**Outputs:** `src/yolo/index.ts` (sandbox guard, archive rewrite, system-prompt addendum), `src/yolo/checklist.ts` (gate), `--yolo` flag in `src/cli/program.ts`, `/yolo` in `src/cli/slash.ts`, plumbed through `ToolContext.yolo` and both REPLs. Red `YOLO` badge in the Ink status footer when armed. `src/permissions/match.ts:103` broadens path scope to `<parent>/*`.

### Phase 11: Ship v1.1
**Goal:** README + this doc + checklist realigned, real-API smoke tests on user's side, CHANGELOG via `changelog-release-description` skill, `v1.1.0` tag.

The architectural test the v1.1 cycle was designed to pass: **zero changes to `src/engine/loop.ts` across the four adapter additions**. Verified, and held even through the YOLO plumb-through (added an optional `yolo?: YoloSession` field to `AgentLoopOptions` for context propagation, no logic changes).

## v1.2: Subagent layer

What was previously called Phases 6-9. Now slotted post-multi-provider because per-agent model selection only delivers the vetting unlock once multiple providers exist. Phase ladder is in `checklist.txt`. Briefly: agent identity, anguish meter (observability only), howl pub/sub, AsyncLocalStorage context, scope lock, depth-1 cap with 4 concurrent slots, TUI panels with anguish meters and Tab/Shift+Tab cycling, Ctrl+K kill picker, external CLI subagent backends with per-agent worktree isolation.

## Polish backlog

Markdown rendering in the REPL, syntax highlighting for code blocks, `--output-format json` / `--output-format stream-json`, hooks UI surfacing (`/hooks` slash command + settings.json schema docs), `/compact --auto` toggle and status-line indicator, `squad usage` per-project filtering polish.

## Hard wall

The pitch's deferred list, MCP servers, IDE bridge, remote sessions, hosted service, is not a roadmap. Custom agents-as-config gets a tightly-scoped form via `.squad/agents/<name>.md` in v1.2 and stops there.
