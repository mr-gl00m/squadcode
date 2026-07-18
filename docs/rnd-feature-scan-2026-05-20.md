# R&D Feature Scan - 2026-05-20

Source snapshots reviewed under `.rnd/`: Aider, Cline, Codex CLI, Gemini CLI, Nanocoder, and OpenCode. This is not a line-by-line audit. It is a product/architecture harvest: features worth stealing, concepts worth adapting, and places where Squad Code already has a better story.

## Executive Take

The market is converging on five feature clusters:

- markdown-defined agents/subagents with per-agent model, prompt, and permissions
- resumable sessions with compaction, rollback/checkpointing, and thread forking
- richer permission/policy systems with allow/ask/deny, command patterns, and agent-scoped rules
- automation surfaces: SDKs, JSON/JSONL output, cron/scheduled tasks, connectors, and app-server style protocols
- IDE or browser-adjacent review surfaces: worktree Kanban, diff review, editor bridges, file explorers

Squad Code's strongest differentiator remains the provider-neutral harness: one canonical streaming event loop across `llm-chat`, `llm-message`, `llm-response`, and `llm-local`, with local-first persistence, cost tracking, tamper-evident audit, and YOLO rails. Most competitors are broader products; Squad Code is currently cleaner as a model-vetting and autonomous local coding harness.

## Highest-Value Features To Pull Forward

### 1. Subagents With Scoped Tools And Models

Seen in: Gemini CLI, OpenCode, Nanocoder, Cline, Codex collab prompts.

Useful shape:

- markdown-defined agents in project/user dirs
- `description`, `model`, `temperature`, `max turns`, `tools`/`permissions`, and prompt body
- one `Agent`/`Task` tool for primary agents to invoke subagents
- depth-1 recursion guard
- child sessions visible/navigable from the parent
- per-agent permission derivation that cannot exceed the parent

Squad fit:

- This is the v1.2 unlock. Implement the narrow version first: in-process `Agent` tool, depth=1, four slots max, child gets constrained tools and an optional catalog model override.
- Borrow OpenCode/Nanocoder's markdown agent config and Gemini's executor/definition/invocation split.

Squad already does better:

- Provider-neutral model selection is already catalog-driven, so subagents can run across local Ollama, Anthropic, OpenAI Responses, DeepSeek, OpenRouter-style providers, etc. without a new orchestration layer.

### 2. Stream JSON / Machine-Readable Run Output

Seen in: Gemini CLI and Cline CLI.

Useful shape:

- `--output-format json`
- `--output-format stream-json`
- JSONL events for `init`, text delta, tool call, tool result, usage, error, final result
- stable event IDs and call IDs so harnesses can diff runs across models

Squad fit:

- This should be near the top because Squad Code's stated job is model vetting. A stream format turns ad hoc terminal sessions into reproducible benchmark traces.
- Map it directly from Squad's canonical event union and session usage ledger.

Squad already does better:

- Squad already normalizes provider streams before the agent loop. Most tools expose JSON output after the fact; Squad can make the canonical stream itself the public contract.

### 3. Worktree Isolation For Risky Or Parallel Work

Seen in: Cline Kanban, OpenCode child sessions, Codex thread fork, Nanocoder checkpointing.

Useful shape:

- create a git worktree per task/subagent
- keep agent CWD bound to the worktree
- review/merge/discard after completion
- use child-session metadata to tie worktree to task

Squad fit:

- Add `EnterWorktree` / `ExitWorktree` or make it an option on `Agent`.
- Best initial target: subagent worktree isolation, not a full Kanban UI.

Squad already does better:

- YOLO's cwd sandbox and archive-on-delete rails are already local safety primitives. Worktrees would compose with those instead of replacing them.

### 4. Plan Mode As A First-Class Permission Profile

Seen in: OpenCode plan agent, Nanocoder plan mode, Cline Plan/Act, Gemini policy profiles.

Useful shape:

- mode/profile that allows read/search/list and denies or asks for edit/shell
- explicit transition from plan to act
- visible status in REPL/TUI

Squad fit:

- Implement as a permission profile, not a second engine. `--mode plan` and `/mode plan` can swap policy defaults.
- Keep it boring: no writes, shell ask/deny, all read/search allowed.

Squad already does better:

- Squad's permission system already has persistent project grants, sensitive defaults, and pattern matching. Plan mode can reuse that without a new conceptual model.

### 5. Checkpoint / Rollback

Seen in: Aider auto-commits, Gemini shadow git rewind, Nanocoder checkpoints, Codex `thread/rollback`.

Useful shape:

- save conversation state plus workspace state before risky tool calls
- rollback to named checkpoint or last turn boundary
- avoid using user git identity/hooks for internal snapshots

Squad fit:

- For Squad, start with conversation rollback and archive restore before shadow-git workspace snapshots.
- If workspace checkpointing lands, copy Gemini's "isolated shadow git config" idea to avoid user hooks/signing/global identity.

Squad already does better:

- The audit chain and append-only JSONL transcripts are stronger than ordinary session files for tamper evidence and replay. Checkpoints should build on that, not replace it.

### 6. Read-Only Shell Classifier

Seen in: OpenCode granular bash permissions, Codex shell escalation rules, Gemini policy engine.

Useful shape:

- split commands by shell control operators
- classify each command segment as read-only or mutating
- allow obvious reads: `git status`, `git log`, `ls`, `cat`, `rg`, `npm ls`
- always ask/deny mutating commands and ambiguous shell features

Squad fit:

- Already in `docs/v1.2-backlog.md`; still valid.
- Needs PowerShell support because this repo is developed on Windows.

Squad already does better:

- Squad's arity-prefixed shell permission grants are more defensible than broad string prefix grants.

### 7. Plugin / Hook Surface Expansion

Seen in: OpenCode plugins, Cline SDK plugins, Gemini hooks, Codex hooks listing/trust.

Useful shape:

- existing hooks plus `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `PreCompact`
- hook trust state and hash tracking for project hooks
- hooks can inject context, block/ask/approve, or annotate output

Squad fit:

- Do not jump to a full npm plugin runtime yet.
- Expand the current hook events first and expose hook status in `/hooks`.

Squad already does better:

- Hook fires already land in the audit chain. That is a stronger auditability story than most plugin systems advertise.

### 8. Dynamic Tool Discovery / Deferred Tool Schemas

Seen in: Codex dynamic tools, OpenCode custom tools, Cline SDK tools.

Useful shape:

- keep rarely used tools out of the default model tool list
- use a `ToolSearch`/discovery tool to reveal matching schemas on demand
- allow external clients/plugins to serve dynamic tool calls

Squad fit:

- Squad already has `ToolSearch`; make it the central affordance for future MCP/custom-tool growth.
- Good next step: let project skills/tools provide deferred schemas without loading every custom tool into every turn.

Squad already does better:

- The deferred-schema tool catalog is already aligned with small-context local models. Competitors often assume huge context windows.

### 9. Memory And Long-Term Context

Seen in: Codex two-phase memory pipeline, Nanocoder auto-compact, Gemini chat recording/compression.

Useful shape:

- per-session extraction to structured memories
- global consolidation into filesystem artifacts
- explicit memory eligibility per thread/project
- memory citations and stale-memory pruning

Squad fit:

- Keep this lightweight: project memory file plus session-derived summaries, opt-in only.
- The Codex two-phase pipeline is too heavy for now but the split is right: extract many sessions in parallel, consolidate serially.

Squad already does better:

- Squad has local JSONL transcripts, SQLite indexing, usage ledger, and audit records. It already has enough raw material to generate memories without adding telemetry or a hosted backend.

### 10. App Server / SDK Boundary

Seen in: Codex app-server, Cline SDK, Gemini SDK/A2A server.

Useful shape:

- programmatic `Agent`, `Session`, `Tool<T>` API
- async iterator of typed events
- JSON-RPC app-server only if there is a real client

Squad fit:

- Build a small TypeScript SDK before a daemon/server.
- Expose the canonical event loop as a library so model vetting scripts can import it.

Squad already does better:

- The internal provider abstraction is already shaped like an SDK boundary. Squad does not need to peel a UI off a monolith.

## Lower-Priority Product Features

- IDE bridge / VS Code extension: useful but not core to the harness. Nanocoder/Cline/OpenCode already show the shape: diff previews, selected-code context, diagnostics sharing.
- File explorer and `@file:line-range` autocomplete: nice REPL UX. Good polish after subagents and stream JSON.
- Web fetch/search: useful for docs research, but it changes the local-first privacy story. Add only with explicit provider/tool permissions.
- Voice-to-code and image input: Aider/Gemini have them, but this is not core for model-vetting.
- Connectors to Slack/Telegram/Discord/Linear: Cline's SDK product layer. Out of scope unless Squad becomes a service.
- Scheduled tasks/cron: good for "weekly code health" but likely after SDK/output formats.
- Kanban board: compelling orchestration UX, but start with worktree-backed subagent sessions first.

## Competitor Notes

### Aider

Strong concepts:

- repo map for large codebases
- automatic git commits and easy undo
- lint/test integration after edits
- image/web page context
- voice-to-code
- copy/paste workflow for web chat models

Useful for Squad:

- Repo map/indexing is the biggest idea. Squad's `.crabmeat` manifest support points in that direction, but Aider's "map the whole repo" is still a proven UX concept.

Squad better statements:

- Squad has a cleaner provider abstraction for modern tool-use streams, including OpenAI Responses and Anthropic Messages/thinking.
- Squad's audit chain is stronger than normal git-only accountability.
- Squad's YOLO mode is safer than plain auto-accept because it requires checklist plus sandbox plus archive-on-delete.

### Cline

Strong concepts:

- multi-surface product: CLI, SDK, VS Code, JetBrains, Kanban
- parallel task board with worktrees and inline diff comments
- SDK/plugin architecture for custom tools, hooks, connectors, scheduled jobs
- messaging connectors and cron automations
- enterprise remote configuration and MCP controls

Useful for Squad:

- SDK/event interface, worktree orchestration, scheduled non-interactive runs, and plugin lifecycle hooks.

Squad better statements:

- Squad is not tied to a hosted product or organization admin model.
- Squad's local-first/no-telemetry stance is simpler and more inspectable.
- Squad is better positioned as a model comparison harness because all providers normalize into one event loop.

### Codex CLI

Strong concepts:

- rich app-server protocol with threads, turns, items, fork/resume/rollback/compact
- skills installation/listing/config and app mentions
- experimental API gating
- memory pipeline with extraction/consolidation
- guardian/review flows and collaboration/subagent tool surface
- realtime text/audio and web search hooks

Useful for Squad:

- Thread/turn/item terminology, fork/rollback APIs, skill metadata, memory pipeline split, and experimental capability gating.

Squad better statements:

- Squad is easier to reason about because the CLI path and provider path are not hidden behind a large app-server protocol.
- Squad already supports non-OpenAI/local providers as first-class citizens through the same loop.
- Squad's project-level permission persistence and YOLO rails are practical local automation primitives.

### Gemini CLI

Strong concepts:

- mature subagent architecture
- message bus and policy engine separation
- stream JSON output
- loop detection service
- DeadlineTimer pause/resume for user approvals
- SDK shape around `Agent`, `Session`, and Zod-backed tools
- environment sanitization for child processes

Useful for Squad:

- This is the best direct TypeScript source for implementation shapes. `docs/gemini-cli.md` already has detailed cherry-pick notes.

Squad better statements:

- Squad is less Gemini-specific and much smaller.
- Squad does not need the heavy telemetry/billing/context-pipeline stack to deliver the useful parts.
- Squad's canonical event model gives a cleaner bridge from provider streams to JSONL harness output.

### Nanocoder

Strong concepts:

- local-first positioning similar to Squad
- development modes: normal, auto-accept, yolo, plan
- context compression with mechanical fallback
- checkpointing
- task management
- custom commands with parameters/aliases/autoinjection
- file explorer with token estimates
- MCP, subagents, scheduler, VS Code extension

Useful for Squad:

- Mode UX, custom commands, task management, and file explorer are all good user-facing polish.

Squad better statements:

- Squad's YOLO is more controlled because it is not "no exceptions"; it has specific rails.
- Squad's provider catalog is the cleaner path for testing multiple local/frontier backends in the same harness.
- Squad's audit/cost ledger story is stronger.

### OpenCode

Strong concepts:

- primary agents plus subagents
- markdown/JSON agent config
- agent-level permissions with allow/ask/deny
- `@` mention invocation
- child-session navigation
- plugin hooks and custom tools
- granular permissions including external-directory and doom-loop gates
- LSP, webfetch/search, MCP, sharing, desktop/web/IDE surfaces

Useful for Squad:

- Agent config schema and permission vocabulary are closest to what Squad should adopt.
- `doom_loop` as a permission gate is a nice UX: ask the user when repeated identical tool calls suggest the agent is stuck.

Squad better statements:

- Squad already has repeated tool-call and tool-failure loop guards in the engine.
- Squad's sensitive defaults and cwd jail are stricter than broad permissive defaults.
- Squad's provider model does not require `provider/model-id` coupling in user-facing config.

## Suggested Build Order

1. `--output-format stream-json` and `--output-format json`
2. In-process subagent v1 with markdown agent definitions
3. Worktree isolation option for subagents/autonomous runs
4. First-class plan mode permission profile
5. Read-only shell classifier
6. Checkpoint/rollback for conversation, then workspace
7. Hook expansion and `/hooks` visibility
8. Lightweight SDK exposing `Agent`, `Session`, and typed events
9. Project memory extraction/consolidation
10. IDE bridge or Kanban only after worktree/session primitives are solid

## Messaging: Squad Code Does Better

- Provider-neutral by construction: one canonical event loop, not a vendor-specific loop with adapters bolted on.
- Local-first and inspectable: no telemetry, no cloud session dependency, no hosted control plane.
- Stronger autonomous safety: YOLO means checklist plus cwd sandbox plus archive-on-delete, not just "skip prompts."
- Better auditability: append-only JSONL sessions plus SQLite audit chain with `prev_hash`.
- Better model-vetting fit: cost ledger, usage tracking, artifacts for oversized output, and canonical events are already present.
- Smaller surface area: Squad can adopt subagents, stream JSON, and worktrees without inheriting enterprise admin, marketplace, or IDE complexity.
