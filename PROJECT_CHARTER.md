# Squad Code: Project Charter

**Created:** 2026-05-01
**Stack:** TypeScript (strict, NodeNext, ESM) on Node 22+. commander, zod, dotenv. Ink for the rich REPL with readline behind a `--simple` fallback. `@anthropic-ai/sdk`, `openai` SDK (DeepSeek via base-URL override). pino for structured logging. vitest for tests. better-sqlite3 for the audit + session index.
**Audience:** single user, local machine. MIT-licensed for any later public release per the pitch.
**LLM-facing:** yes, cloud first (DeepSeek MVP, then OpenAI, then Anthropic). Ollama lands once the model switcher exists, completing the "cloud first then Ollama" arc.
**Prior art considered:** none competing. LiteLLM and OpenRouter are translation layers without an agent loop; the pitch's "Yet-another-wrapper fatigue" risk section already locks the differentiator.

## 1. Purpose

A provider-neutral, local-first CLI agent that runs a streaming agent loop, streaming output, tool use, permissions, sessions, against any frontier model through a single canonical event stream.

## 2. Ship criterion

The five MVP commands (`squad`, `squad -p "summarize src/"`, `squad -p "find likely bugs"`, `squad --model deepseek-v4-pro -p "review this patch"`, `squad --resume`) all stream through DeepSeek end-to-end on real API calls, with the tool loop, permission prompts, and JSONL transcripts working.

## 3. SIGIL threat model

### Layer 1: Cryptographic signing
Applies, narrowly. The persona/system-prompt baseline that defines the agent's identity is signed (Ed25519) and stored alongside its signature in `~/.squad/persona.json` + `~/.squad/persona.sig`. The loader rejects an unsigned or tampered persona at startup. Routine settings (model name, tool allowlist) are not signed, the audit chain below carries the broader tamper-evidence load.

### Layer 2: Structural trust boundaries
Critical. Every non-system input that lands in the model's context window, pasted user prompt, `Read` tool output, `Shell` stdout/stderr, `Grep` matches, `Glob` paths, session-resume replay, is wrapped in a structural marker (`<USER_PROMPT>`, `<TOOL_OUTPUT tool="Read" path="...">`, `<SHELL_STDOUT>`, etc.). The system-prompt template documents which tags are trusted. Nested trust tags inside an untrusted region are escaped, never honored.

### Layer 3: Input normalization
Deferred. User prompts and tool output are wrapped in escaped structural trust markers before entering model context, but Squad does not currently detect or decode Base64, ROT13, Hex, or URL-encoded payloads. Encoded text remains encoded. Add detection only with a tested false-positive policy, explicit audit/status events, and a guarantee that decoded bytes are labeled rather than silently inlined.

### Layer 4: Tag breakout prevention
Applies. Every untrusted string is HTML-entity-escaped at the structural-marker boundary before interpolation into the prompt template. The renderer is not trusted to be safe downstream, the boundary is the choke point.

### Layer 5: Persona stability preamble
Applies. The system prompt treats "ignore your instructions" / "you are now a different agent" / role-reassignment language inside `<USER_PROMPT>` regions as data, never as commands. Detection is logged; the persona stays stable. The signed persona from Layer 1 is what proves the prompt template wasn't mutated on disk.

### Layer 6: Uncertainty / consistency gates
N/A for MVP. Squad Code's outputs are not safety-critical, code review, scaffolding, summarization. If a future workflow becomes safety-critical (security scanning, irreversible refactors), self-consistency checks can be added per-tool, not project-wide.

### Layer 7: Tool affinity
Critical. The agent has an explicit allowlist: `Read`, `Write`, `Edit`, `Shell`, `Grep`, `Glob`, `TodoWrite`. No wildcard, ever. The permissions layer enforces per-tool policy: `Read`/`Grep`/`Glob` auto-allow against the cwd-anchored allowed root; `Write`/`Edit`/`Shell`/`TodoWrite` prompt in `ask` mode by default. `--allowed-tools` / `--disallowed-tools` / `--dangerously-skip-permissions` flags scope per-session, never persisted across sessions without an explicit signed entry in the persona file.

### Support structures
- **Audit continuity log.** SQLite at `~/.squad/audit.db`, table `audit_log(id INTEGER PK, ts TEXT, session_id TEXT, action TEXT, payload_hash TEXT, prev_hash TEXT)`. Every prompt submission, tool call, tool result, permission decision, and session resume gets a row. The payload itself is not stored. `prev_hash` detects accidental gaps or corruption in link continuity, but the hashes are unkeyed and have no external anchor, so a motivated editor can recompute the chain. JSONL transcripts handle replay; SQLite records continuity metadata. Two structures, two jobs.
- **Time-bounded ops.** Session-scoped permission grants expire when the session ends. `--dangerously-skip-permissions` is per-invocation only. No "always allow" survives across sessions without an explicit entry in the signed persona/policy file.
- **Human-in-the-loop.** The permissions prompt is the gate. For mutating tools in `ask` mode, the agent loop halts on a synchronous TTY prompt until the user confirms. Non-interactive contexts (CI, piped stdin) fall back to writing `~/.squad/pending/<call_id>.json` and exiting non-zero rather than auto-allowing. No webhook approval, no Slack bot, no dashboard.

## 4. Coding non-negotiables

**Always applies:**

- **Local-first.** SQLite (audit log + session index) and JSONL (transcripts) only. Outbound network: only the configured provider endpoints (DeepSeek, OpenAI, Anthropic) and, later, `http://localhost:11434` for Ollama. No telemetry, no analytics, no error-reporting service.
- **Atomic writes.** Persistent files: `~/.squad/settings.json`, `~/.squad/persona.json` + `.sig`, session JSONL files under `~/.squad/sessions/<session_id>.jsonl`, `~/.squad/audit.db`. Settings/persona writes go through `core/io.ts::atomicWriteJson` (`fs.mkstemp` → write → `fs.rename`). SQLite handles its own atomicity via WAL. JSONL transcripts append-only with `fs.appendFile` + `fsync` per turn (atomicity at the record level, not the file level).
- **SQLite hygiene.** WAL journal mode, `PRAGMA foreign_keys = ON`, parameterized queries only (better-sqlite3 prepared statements), numbered migration scripts in `migrations/<NNNN>_<name>.sql`, context-managed connection lifetime.
- **Full type hints.** TypeScript `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`. NodeNext module resolution. `.js` import extensions on relative imports (ESM rule). No `any` without an `// allow-any:` justification comment. Errors caught as `unknown` and narrowed, not bare `Error`.
- **Logging, not console.log.** `pino` structured logger writing JSON lines to `~/.squad/logs/squad.log` with rotation. UI output to stdout via Ink/readline is separate from telemetry. Uncaught-exception and unhandled-rejection handlers funnel into pino.
- **Never bare `catch (e)`.** Every catch narrows the error before acting. Named error classes for `ProviderError`, `ToolError`, `PermissionDenied`, `ConfigError`, `SessionCorrupted`.
- **Secrets discipline.** `.env` loaded via `dotenv`, validated by `zod` schema in `config/env.ts`. `.env` and `~/.squad/` ignored by git. API keys redacted from any log line via a pino redactor; never echoed to stdout, never written into transcripts.
- **Path traversal prevention.** Tools that touch the filesystem (`Read`, `Write`, `Edit`, `Glob`, `Shell`'s cwd) validate target paths against an allowed root (defaults to invocation cwd). Symlinks resolved with `realpath` and re-checked.
- **SSRF prevention.** Provider URLs validated by zod (`https://` only for cloud, `http://localhost:` for Ollama). `OLLAMA_ALLOW_REMOTE=1` is the only escape hatch and it logs a warning per call.
- **No prohibited deps.** No Express/Fastify/Koa (this isn't a server). No Prisma/Drizzle/TypeORM (better-sqlite3 directly). No `@aws-sdk/*` / `@google-cloud/*` / `firebase-admin`. No `@sentry/*` / `@opentelemetry/*` / `@segment/*` / `posthog-node`. No Electron. No paid SaaS dev tools. Node 22+ as the runtime, `npm` for dependency install. Never Yarn.
- **Conventional commits.** `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, `security:`. First line under 72 chars.

**Sometimes applies:**

- **Integration tests against a real database.** Yes. vitest suites for the audit chain, session writer, and tool loop run against a real on-disk SQLite file in a temp dir. No mocked DBs.
- **Dockerized dev environment.** No. Single-machine TypeScript on Node 22+ is portable enough; the cross-platform concern is non-existent for a personal CLI.
- **Signed release artifacts.** Deferred until the project ships beyond a single-user local install. Not part of v1.0.

## 5. UI & aesthetics

Terminal UI, not GUI, PySide6 rules don't apply. The rich path uses Ink, the simple path uses readline. Accent color `#7aa2f7` for prompts, status lines, and tool-call announcements; muted gray for system text; soft red for permission-denied and error states. The primary driver is "stream output and stay interruptible", Ctrl-C cancels the current turn cleanly. Slash commands (`/provider`, `/model`, `/clear`, `/resume`, `/help`) are the control surface. No emoji in chrome, tool names render as typed labels (`[Read]`, `[Shell]`, `[Edit]`), not pictographs. Status line at the bottom shows provider, model, turn count, token usage.

## 6. Voice & prose rules

Applies to: commit messages, slash command help, error messages surfaced to the user, README, CLI flag descriptions. The standard banned-vocab and banned-construction rules apply (no "leverage" as a verb, no "ensure" as filler, no "not X but Y" rhetorical pivots, no marketing tone). Em-dash limit one per 500 words in any prose artifact. Error messages are concrete ("DeepSeek returned 429; retry after 12s") not performative ("An error occurred while processing your request"). Help text is terse, one line per flag, no "this flag allows you to" preamble.

## 7. Prohibited dependencies

Express, Fastify, Koa, Hapi, NestJS. Prisma, Drizzle, TypeORM, Knex (better-sqlite3 only). `@aws-sdk/*`, `@google-cloud/*`, `firebase-admin`, `azure-*`. `@sentry/*`, `@opentelemetry/*`, `@segment/*`, `posthog-node`. `electron`, `nw.js`. Yarn. Any paid/SaaS dev tool that calls home.

## 8. License

**MIT.** Code-only, provider-neutral by design, intended for public release per the pitch's "this belongs to anyone who needs it" line. `LICENSE` file at the project root. The scaffold writes it during Phase 0.

## 9. Handoff

Charter frozen. Proj doc and checklist committed alongside. Next step: Phase 0 scaffold, Node 22+ project init, commander entry, zod-validated `.env` plumbing, `squad --help` and `squad --version` running. The scaffold reads this charter and the proj doc to know the constraints before picking a file tree.
