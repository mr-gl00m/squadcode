# Changelog

All notable changes to this project will be documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-05-05

Multi-provider + YOLO release. The throughline: one canonical event stream now drives four adapter kinds, and the engine loop received zero changes across all four additions. That was the architectural test the canonical layer was designed to pass.

### Highlights
- **Four adapter kinds, one loop.** `llm-chat` (DeepSeek, gpt-4o family, Together, Groq, Fireworks, OpenRouter, any OpenAI-compatible chat-completions backend), `llm-message` (Anthropic Claude with `cache_control` and thinking), `llm-response` (OpenAI gpt-5.x and o-series via the Responses API with reasoning), `llm-local` (Ollama and other keyless local servers). Adding a new backend is a JSON catalog row, not a code change.
- **YOLO mode.** `--yolo` flag and `/yolo` slash command run the agent autonomously with three rails: cwd sandbox, archive-on-delete (rewrites `rm`/`Remove-Item`/`del`/`unlink` to `mv` into `.archive/<iso-ts>/`), and a mandatory checklist (`checklist.txt` / `CHECKLIST.md` in cwd, refuses to start otherwise).
- **Harness fold-in.** Hooks, deferred-schema tool catalog, apply-patch tool, auto-compact, oversized-output artifact storage, per-turn usage ledger, OSC-2 tab-title status, pattern-based permissions with sensitive defaults — all wired into the engine and surfaced in the REPL.

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
- `src/tools/tool-search.ts` deferred-schema discovery — large tool catalogs hide their full JSON Schema until the model loads them via `select:` or keyword query, keeping the request payload small.
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
- YOLO archive: deletes are not executed — `rm`, `Remove-Item`, `del`, `unlink` get rewritten to a `mv` into `.archive/<iso-ts>/`. The rewrite note is prepended to the tool result so the model knows the file moved, not vanished. `mkdir -p` (POSIX) / `New-Item -ItemType Directory -Force` (PowerShell) ensures the archive dir exists before the move.

[1.1.0]: First multi-provider release. Compare against v1.0.0.

## [1.0.0] - 2026-05-03

First release. Everything below is new.

### Highlights
- Provider-neutral agent loop. Each provider adapter normalizes its native stream into one `CanonicalEvent` union (`text_delta`, `tool_call_done`, `tool_result`, `usage`, `done`, `error`); the loop in `src/engine/loop.ts` never sees provider-specific wire formats.
- Five MVP commands verified end-to-end on real DeepSeek: `squad`, `squad -p "summarize src/"`, `squad -p "find likely bugs"`, `squad --model <name> -p "review this patch"`, `squad --resume`.
- Local-first persistence — JSONL transcripts plus a `prev_hash`-linked SQLite audit chain, both under `~/.squad/`.

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

[1.0.0]: First release — no prior version to compare against.
[Unreleased]: HEAD

