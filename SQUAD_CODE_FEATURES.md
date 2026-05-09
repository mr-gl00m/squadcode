# Squad Code Feature Inventory

Generated from the current repository state on 2026-05-08.

## Product Shape

- Local-first command-line coding agent.
- Ships two executable names: `squad` and `squadcode`.
- Supports one-shot prompt mode with `-p, --print`.
- Supports interactive REPL mode when run without `--print`.
- Supports a plain readline REPL with `--simple` for terminals where Ink is not suitable.
- Keeps state under `~/.squad/` by default.
- Does not include telemetry, hosted sessions, remote sessions, MCP server support, or an IDE bridge.

## Model And Provider Support

- Provider-neutral agent loop built around a canonical event stream.
- Catalog-driven model dispatch through `src/providers/default-models.json`.
- User model catalog overrides through `~/.squad/models.json`.
- Provider/model defaults remembered in settings.
- Provider switching through `--provider <name>` and `/provider <name>`.
- Model switching through `--model <name>` and `/model <name>`.
- Supports arbitrary catalog provider IDs instead of a hard-coded provider enum.
- Supports model aliases in catalog entries.
- Supports custom base URLs through provider-specific environment variables.

### Adapter Kinds

- `llm-chat`: OpenAI-compatible chat-completions APIs.
- `llm-message`: Anthropic Messages API.
- `llm-response`: OpenAI Responses API.
- `llm-local`: local OpenAI-compatible servers such as Ollama.

### Built-In Catalog Coverage

- DeepSeek chat and reasoner models.
- Anthropic Claude Sonnet, Opus, and Haiku entries.
- OpenAI Responses API entries for `gpt-5.1`, `o1`, and `o3` (additional model identifiers can be added via `~/.squad/models.json`).
- OpenAI chat-completions entries for `gpt-4o`, `gpt-4o-mini`, and `gpt-5.5`.
- Ollama default/local model aliases such as `llama3.2`, `llama3.1`, and `qwen2.5-coder`.

## Streaming And Reasoning

- Streams assistant text deltas to the terminal.
- Normalizes provider-specific stream events into canonical events.
- Supports tool-call streaming through canonical tool-call events.
- Supports usage events for token accounting.
- Supports reasoning deltas for models/adapters that expose reasoning output.
- Supports Anthropic thinking blocks.
- Supports OpenAI Responses reasoning configuration when the catalog capability enables it.
- Supports cached input token accounting where providers expose it.

## Agent Loop

- Runs a stream, collect tool calls, execute tools, append results, continue loop.
- Stops when no more tool calls are emitted.
- Default max-turn guard is 25 turns.
- Repeated identical tool-call guard aborts stuck loops after three consecutive identical tool-call turns.
- Consecutive tool-failure guard warns after three failures and halts after eight failures.
- Preserves provider message invariants by adding synthetic tool results when aborting mid-loop.
- Supports Ctrl-C abort in print and REPL flows.
- Wraps tool outputs in trust markers before feeding them back to the model.
- Adds platform-specific shell guidance to the system prompt.
- Encourages `TodoWrite` usage for multi-step coding tasks.

## Tools

### Core Tools

- `Read`: reads UTF-8 text files.
- `Write`: atomically creates or overwrites UTF-8 text files.
- `Edit`: replaces text in an existing file.
- `ApplyPatch`: applies unified-diff style multi-file edits.
- `Shell`: runs commands through the platform shell.
- `Grep`: searches file contents with JavaScript regex.
- `Glob`: finds files by glob.
- `TodoWrite`: maintains a working checklist during a session.
- `IndexList`: lists entries from a project manifest when available.
- `IndexFetch`: fetches indexed file summaries/content from a project manifest when available.
- `ToolSearch`: loads deferred tool schemas on demand.

### Tool Safety And Quality Features

- Filesystem tools are jailed to the current working directory unless explicitly allowed.
- Paths are resolved and validated to prevent traversal.
- Symlink resolution is rechecked against the allowed root.
- `Read` refuses unscoped reads of very large files and asks for offset/limit windows.
- `Read` supports line-window reads with `offset` and `limit`.
- `Write` and `Edit` reject common omission placeholders that would otherwise be written literally.
- `Write` uses tmp-and-rename atomic writes.
- `Edit` preserves BOM and original line endings.
- `Edit` uses file locking.
- `Edit` checks file modification time after permission preview to avoid stale edits.
- `Edit` refuses non-unique replacements unless `replace_all:true`.
- `Shell` captures stdout and stderr.
- `Shell` has a default timeout of 120 seconds and a maximum timeout of 600 seconds.
- `Shell` terminates process trees on timeout or abort.
- `Shell` truncates very large output.
- `Grep` skips `.git`, `node_modules`, `dist`, large files, and very long lines.
- Large successful tool outputs can be offloaded into session artifacts.

## Permissions

- Read-only tools auto-allow by default.
- Mutating tools ask by default.
- CLI flags:
  - `--allowed-tools <list>`
  - `--disallowed-tools <list>`
  - `--dangerously-skip-permissions`
- Permission prompt outcomes:
  - allow once
  - always allow for this session
  - permanently allow for this project
  - deny
- Project-level permissions persist in `.squad/settings.json`.
- Project permission persistence can be disabled with `SQUAD_PROJECT_PERMS=0`.
- Pattern-based permission rules support allow, deny, and ask actions.
- Permission matching is specificity-sorted.
- Sensitive defaults are built in, including special handling for `.env`, `.env.example`, SSH keys, and SSH config.
- Session and project grants broaden intelligently:
  - shell grants use arity-prefixed command patterns.
  - path-tool grants use parent-directory globs.
  - repo-root files remain literal scopes.

## YOLO Mode

- Enabled with `--yolo` or `/yolo`.
- Skips normal permission prompts.
- Requires a checklist file in the current working directory.
- Accepted checklist filenames include `checklist.txt`, `CHECKLIST.md`, `checklist.md`, and `CHECKLIST.txt`.
- Appends checklist contents to the system prompt.
- Adds a YOLO-specific system prompt addendum describing the rails.
- Enforces a cwd sandbox for shell commands.
- Rejects absolute paths outside the cwd.
- Rejects `cd` / `Set-Location` targets outside the cwd.
- Rewrites delete commands into archive moves.
- Delete rewrites cover `rm`, `Remove-Item`, `del`, and `unlink`.
- Archives deleted files under `.archive/<timestamp>/`.
- Shows a YOLO badge/status in the Ink REPL.
- `/yolo` can toggle YOLO mode on or off during a REPL session.
- Distinct from `--dangerously-skip-permissions`, which only bypasses prompts.

## Sessions And Persistence

- Creates JSONL session transcripts under `~/.squad/sessions/`.
- Session transcripts are append-only.
- Session writer fsyncs per turn.
- SQLite session index supports fast listing and lookup.
- `--resume [id]` resumes a specific session or the most recent session for the cwd.
- `--continue` aliases resume-most-recent behavior.
- `squad sessions list` lists recent sessions.
- `squad sessions show <id>` prints a stored transcript.
- `/sessions` lists recent sessions in the current directory.
- `/clear` clears in-memory conversation history while leaving the session file intact.
- Assistant message sidecars store full assistant content for easier inspection.
- Oversized tool-output artifacts are stored under the session directory and referenced in-context.

## Audit And Logging

- SQLite audit database under `~/.squad/audit.db`.
- Audit rows include prompts, tool calls, tool results, permission decisions, hook fires, session start/resume/archive events.
- Audit chain uses `prev_hash` links for tamper-evidence.
- Audit chain validation is implemented in the session store.
- SQLite runs through migrations.
- Pino structured logger writes rotating logs under `~/.squad/logs/`.
- API keys are redacted from logs.

## Usage And Cost Tracking

- Per-turn usage ledger in SQLite.
- Records provider, model, cwd, session id, token counts, cached input tokens, tool-call counts, and estimated cost.
- `squad usage` command reports cross-session usage.
- `/usage [scope] [N]` reports usage from the REPL.
- Supports filtering by cwd, all cwd, session id, provider, model, and day range.
- Groups usage by day, session, and model.
- `/cost` shows current-session token and cost summary.
- Pricing lookup includes cached-input savings when pricing data supports it.

## Hooks

- Hook configuration loaded from user and project settings.
- Hook runner supports these events:
  - `PreToolUse`
  - `PostToolUse`
  - `PostToolUseFailure`
  - `SessionStart`
  - `SessionEnd`
  - `UserPromptSubmit`
- Hook fires are recorded into the audit chain.
- Hook failures are logged without crashing the main flow.

## REPL Features

- Ink-based interactive REPL.
- Status line includes provider, model, turn count, and token usage.
- OSC-2 terminal tab title updates for current state.
- Ctrl-C interrupt support.
- Slash command help through `/help`.
- Slash commands:
  - `/provider`
  - `/model`
  - `/clear`
  - `/compact`
  - `/cost`
  - `/usage`
  - `/tools`
  - `/sessions`
  - `/yolo`
  - `/skills`
  - `/list-skills`
  - `/<skill-name>`
  - `/output-style`
  - `/style`
  - `/exit`
  - `/quit`
- `/resume` currently reports as a stub in the slash-command handler, while CLI resume is implemented.

## Skills

- Loads markdown skill definitions from a configurable set of skill directories under the user's home directory and `./.squad/skills/` in the project.
- Skills are surfaced through `/skills` and `/list-skills`.
- Loaded skills can be invoked as slash commands.
- Skill frontmatter parsing is shared with output styles.

## Output Styles

- Loads output style markdown files from:
  - `~/.squad/output-styles/`
  - `./.squad/output-styles/`
- Project output styles override user output styles with the same name.
- `/output-style` and `/style` list or activate styles.
- Passing `none` or `off` clears the active output style.
- Active output style is prepended to the system prompt.

## Project Manifest Support

- Looks for `.crabmeat/index.json` in the current project.
- Validates manifest schema before use.
- Adds manifest guidance to the system prompt when present.
- Provides `IndexList` and `IndexFetch` tools for deterministic file discovery.
- Falls back to normal glob/grep/read tools when no manifest exists.

## Auto-Compact

- Context-pressure auto-compact module is implemented.
- `/compact` summarizes the current conversation and replaces history with the summary.
- Tail turns are preserved verbatim while older turns are summarized.

## Security Posture

- Local-first design: only configured provider calls leave the machine.
- Cloud provider URLs require HTTPS.
- Local-provider adapter includes SSRF guard for non-loopback Ollama/local URLs.
- Remote local-provider URLs require explicit `OLLAMA_ALLOW_REMOTE=1`.
- Tool output is escaped and wrapped as untrusted data.
- System prompt includes explicit instruction not to follow tool-output instructions.
- Filesystem paths are resolved before execution.
- Mutating operations require permission unless explicitly allowed or in YOLO/skip-permissions mode.

## Developer And Packaging Features

- Node 22+ TypeScript project.
- Build script runs TypeScript compilation and copies catalog assets.
- Test script uses Vitest.
- Package exports both `squad` and `squadcode` binaries.
- Includes migrations for initial audit/session tables and usage ledger.
- Includes tests covering providers, tools, permissions, YOLO, hooks, sessions, usage, markdown, and loop guards.

## Roadmap Items Present In Docs But Not Shipped

- Subagent layer.
- TUI panels.
- Ctrl+K kill picker.
- External CLI subagent backends.
- Full markdown rendering and syntax highlighting polish.
- JSON and stream-JSON output formats.
- Hooks UI surfacing.
- MCP servers.
- IDE bridge.
- Hosted or remote sessions.
