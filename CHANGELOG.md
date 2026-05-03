# Changelog

All notable changes to this project will be documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-05-03

First release. Everything below is new.

### Highlights
- Provider-neutral agent loop. Each provider adapter normalizes its native stream into one `CanonicalEvent` union (`text_delta`, `tool_call_done`, `tool_result`, `usage`, `done`, `error`); the loop in `src/engine/loop.ts` never sees provider-specific wire formats.
- Five MVP commands verified end-to-end on real DeepSeek: `squad`, `squad -p "summarize src/"`, `squad -p "find likely bugs"`, `squad --model <name> -p "review this patch"`, `squad --resume`.
- Local-first persistence. JSONL transcripts plus a `prev_hash`-linked SQLite audit chain, both under `~/.squad/`.

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
- Skill loader that picks up `.md` skill definitions from `~/.codex/skills/`, `~/.claude/skills/`, and `.squad/skills/`. Loaded skills are invocable as `/<skill-name>` slash commands inside the REPL.

### Security
- Per the SIGIL threat model in `PROJECT_CHARTER.md`: structural trust markers (`<USER_PROMPT>`, `<TOOL_OUTPUT tool="...">`) wrap every untrusted input before it lands in the model context. Persona stability preamble treats role-reassignment language inside untrusted regions as data, never as commands.
- Provider URL validation: `https://` only for cloud providers, `http://localhost:` only for Ollama unless `OLLAMA_ALLOW_REMOTE=1` is explicitly set (logs a warning per call when used).
- API keys redacted from log output via pino redactor; never echoed to stdout, never written into transcripts.

[1.0.0]: First release, no prior version to compare against.
[Unreleased]: HEAD
