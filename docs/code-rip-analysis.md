# 🔬 Code Rip Analysis: gemini-cli + DeepSeek-TUI

## Quick comparison

| | **gemini-cli** | **DeepSeek-TUI** |
|---|---|---|
| **Language** | TypeScript | Rust |
| **UI Layer** | React + Ink (terminal React) | ratatui (immediate-mode TUI) |
| **LLMs** | Gemini 3 (via @google/genai) | DeepSeek V4 (via OpenAI-compat HTTP) |
| **Monorepo style** | npm workspaces (~7 packages) | Cargo workspace (~14 crates) |
| **Extension** | MCP, A2A, skills | MCP, skills, user commands |
| **License** | Apache 2.0 | MIT |

---

## 1. GEMINI-CLI: Architecture Deep Dive

### 1.1 Package topology

```
packages/
  core/     — backend: agent loop, tools, prompts, policy, sandbox, skills, telemetry
  cli/      — terminal UI: Ink/React components, layouts, themes, editors
  sdk/      — programmatic SDK for embedding
  a2a-server/  — Agent-to-Agent protocol server
  devtools/ — built-in devtools (network/console inspector)
  test-utils/  — shared test rig
  vscode-ide-companion/ — VS Code extension
```

**Key idea**: Clean separation between `core` (zero UI dependency, pure logic) and `cli` (all React/Ink rendering). The core package defines abstract interfaces; the cli package implements them visually. This lets them ship a headless SDK by depending only on `core`.

### 1.2 Agent loop: `AgentSession` + event streaming

The central abstraction is `AgentSession`, a thin wrapper around `AgentProtocol`:

```
AgentProtocol
  .send(payload) → { streamId }
  .subscribe(callback) → unsubscribe
  .abort()
  .events → readonly event[]

AgentSession wraps this as:
  .sendStream(payload) → AsyncIterable<AgentEvent>
  .stream({ eventId?, streamId? }) → AsyncIterable<AgentEvent>
```

Events are typed: `agent_start`, `tool_call_request`, `tool_call_response`, `tool_call_confirmation`, `thought`, `citation`, `chat_compressed`, `error`, `agent_end` (with `StreamEndReason:` completed/failed/aborted/max_turns/max_budget/max_time/refusal/elicitation).

**Notable**: Event replay + late subscriber safety. The stream method subscribes early, buffers events during setup, then replays + forwards. This is battle-tested for handling re-attachment and history replay.

### 1.3 Tool system: layered abstractions

Three layers, all in `packages/core/src/tools/`:

1. **`ToolInvocation<TParams, TResult>`**, a validated, ready-to-execute tool call:
   - `getDescription()`, markdown description
   - `getDisplayTitle()`, clean UI title
   - `shouldConfirmExecute(abortSignal)` → confirmation details or false
   - `execute(options)` → result
   - `toolLocations()`, which file paths are affected
   - `getPolicyUpdateOptions()`, for narrowing policy rules after approval

2. **`BaseDeclarativeTool`/`BaseToolInvocation`**, base classes that most tools extend.

3. **`ToolRegistry`**, maps tool names → tool builders. Supports dynamic discovery (MCP tools), aliases, and legacy name mapping.

Each tool is its own file: `edit.ts`, `shell.ts`, `grep.ts`, `read-file.ts`, `write-file.ts`, `web-fetch.ts`, `web-search.ts`, `activate-skill.ts`, `memoryTool.ts`, `topicTool.ts`, `complete-task.ts`, etc.

**The edit tool** is particularly sophisticated: exact match → flexible whitespace → regex → fuzzy match (Levenshtein with 10% threshold). It also detects omission placeholders (`// ... existing code ...`) and triggers JIT context discovery to recover the real text.

### 1.4 Scheduler: tool call orchestration

The `Scheduler` (in `core/src/scheduler/`) coordinates tool execution:
- **State machine**: `Validating → Scheduled → AwaitingApproval → Executing → Success/Error/Cancelled`
- **Confirmation flow**: goes through `MessageBus` → user approval → policy check
- **Policy engine**: approval mode (yolo/auto/plan), sandbox policy, workspace trust
- **Hooks**: before/after tool execution hooks
- **Parallel execution**: supports concurrent tool calls via `FuturesUnordered`-style batching

### 1.5 Skills system

Skills are composable instruction packs loaded from:
1. Built-in skills (lowest precedence)
2. Extension-provided skills
3. `~/.gemini/skills/` (user)
4. `.gemini/skills/` (workspace, highest precedence)

A skill is a markdown file with frontmatter metadata. Skills get injected into the system prompt and can activate other skills. The `SkillManager` handles discovery, precedence, activation, and aliasing.

### 1.6 Agent system (sub-agents)

Has a registry of specialized agents:
- **GeneralistAgent**, general-purpose coding agent
- **CodebaseInvestigatorAgent**, read-only exploration
- **LocalExecutorAgent**, executes local shell commands
- **CliHelpAgent**, self-help
- **BrowserAgent**, web browsing (A2A)

Agents can be local (same process) or remote (A2A protocol). The `AgentTool` wraps any agent as a callable tool. Sub-agents inherit a derived `MessageBus` that prefixes confirmations with the sub-agent chain (e.g., `investigator/filesystem-check`).

### 1.7 Confirmation bus (`MessageBus`)

A publish-subscribe event bus for tool confirmations and user messages:
- `MessageBusType.TOOL_CONFIRMATION_REQUEST`, tool needs approval
- `MessageBusType.QUESTION`, agent asks user a question
- Derives cleanly for sub-agents (prefixes sub-agent name)
- Ties into the `PolicyEngine` for automatic allow/deny decisions

### 1.8 Other notable subsystems

- **Sandbox**: Docker/podman-based sandboxed execution with image building
- **Policy engine**: approval modes, workspace trust, shell safety validation, topic policies
- **Telemetry**: OpenTelemetry-based tracing, metrics, logging to Google Cloud
- **Hooks**: life-cycle hooks that can block/stop agent execution
- **Voice**: voice input support
- **Billing/quotas**: Pro quota management, empty wallet detection
- **IDE integration**: diffing via IDE protocol, VS Code companion

---

## 2. DEEPSEEK-TUI: Architecture Deep Dive

### 2.1 Crate topology

```
crates/
  protocol/    (leaf) — shared types: Thread, EventFrame, ToolPayload
  config/      (leaf) — config loading, profiles, CLI overrides
  state/       (leaf) — SQLite persistence for threads/sessions/checkpoints
  tui-core/    (leaf) — shared TUI primitives

  tools/       → protocol        — tool definitions, ToolRegistry, ToolError
  mcp/         → protocol        — MCP client + stdio server
  hooks/       → protocol        — lifecycle hooks (stdout, jsonl, webhook)
  execpolicy/  → protocol        — shell approval/sandbox policy engine

  agent/       → config          — ModelRegistry (model → provider resolution)

  core/        → agent, config, execpolicy, hooks, mcp, protocol, state, tools
                                   — agent loop, session, turn orchestration

  tui/         (monolith)        — ratatui-based TUI, all features live here
  app-server/  → agent, config, core, execpolicy, hooks, mcp, protocol, state, tools
                                   — HTTP/SSE + JSON-RPC app server
  cli/         → agent, app-server, config, execpolicy, mcp, state
                                   — CLI entry point (`deepseek` dispatcher)
```

**Key observation**: The crate split is structural but `crates/tui` is still the monolith. The dependency graph is cleanly layered (leaves → tools/mcp → agent → core → app-server/tui).

### 2.2 The engine: event-driven core loop

The engine at `crates/tui/src/core/engine.rs` runs as a background tokio task:
- Communicates with the UI via channels (non-blocking UI during API calls)
- Streaming response handling via `futures_util::StreamExt`
- Tool execution via `FuturesUnordered` for parallelism
- Full cancellation support via `CancellationToken`

Config piped in as `EngineConfig`: model, workspace, approval settings, feature flags, compaction config, cycle config, capacity config, shared state (todos, plan, sub-agents, shell manager, seam manager).

### 2.3 Context management: the crown jewel

DeepSeek-TUI has the most sophisticated context management I've seen in any coding agent. Three integrated mechanisms:

#### A. **Cycle Manager** (checkpoint-restart)
Addresses the V4 retrieval degradation cliff (paper Figure 9: 128K→256K drops from 0.87→0.76). Instead of lossy summarization (which creates "Frankenstein context"), it:
1. Archives the entire cycle to JSONL on disk
2. Starts a fresh context with: original system prompt + structured state (todos, plan, working set, sub-agent handles) + a model-curated ~3,000-token "briefing" (decisions, constraints, hypotheses, failures, NOT tool output or file contents)
3. Triggers at 768K tokens (~75% of 1M window)
4. Per-model threshold overrides via `[cycle.per_model.<model>]`

#### B. **Seam Manager** (append-only layered context)
Opt-in layered summarization that preserves the prefix cache. Unlike replacement-based compaction that breaks the prefix cache (90% discount), it:
- Keeps all verbatim messages
- Appends `<archived_context>` summary blocks at soft seams
- Three levels: L1@192K, L2@384K, L3@576K (increasing density)
- Summary blocks are "navigational aids", the model reads them first, drills into verbatim when needed
- Last 16 turns always verbatim

#### C. **Compaction** (traditional summarization)
Still available but disabled by default since v0.8.11. Compacts by token threshold (800K) with a 500K hard floor. The floor exists because for V4, premature compaction rewrites the stable prefix KV cache and costs more than it saves.

### 2.4 Auto reasoning mode

When `--model auto` or `/model auto`, selects reasoning effort per turn:
- Sub-agent context → `Low`
- Message contains "debug"/"error" → `Max`
- Message contains "search"/"lookup" → `Low`
- Default → `High`

Simple heuristic, zero API calls, zero latency overhead.

### 2.5 Tool system

Tools implement a common trait with:
- Capability flags: `ReadOnly`, `WritesFiles`, `ExecutesCode`, `Network`, `Sandboxable`, `RequiresApproval`
- Approval requirement: `Auto`, `Suggest`, `Required`
- Structured errors: `InvalidInput`, `MissingField`, `PathEscape`, `ExecutionFailed`, `Timeout`, `NotAvailable`, `PermissionDenied`

The `ToolRegistryBuilder` constructs tools with `RuntimeToolServices` (shell, workspace, MCP pool, sub-agent manager, etc.).

### 2.6 Approval/policy system (`execpolicy`)

Layered priority system for shell execution policies:
- `BuiltinDefault` (priority 0) → `Agent` (1) → `User` (2)
- Per-prefix trust/deny rulesets
- `AskForApproval` modes: `UnlessTrusted`, `OnFailure`, `OnRequest`, `Reject`, `Never`
- Can dynamically propose policy amendments (e.g., "trust this prefix for this session")

### 2.7 Persistence (`state`)

SQLite-backed persistence with:
- **Threads**: metadata (id, status, cwd, model, approval_mode, git_sha, git_branch, etc.)
- **Messages**: role, content, created_at
- **Checkpoints**: serialized state snapshots
- **Dynamic tools**: position, name, schema
- **Job states**: queue items with retry metadata

### 2.8 Durable task queue

Background tasks that survive restarts:
- Persistent JSON files per task
- Bounded worker pool (default 2, max 8)
- Timeline entries with artifact offloading for large outputs
- Exponential backoff with configurable base
- Status machine: `Queued → Running → Completed/Failed/Canceled`

### 2.9 Runtime API (`deepseek serve --http`)

Full HTTP/SSE API for headless agent workflows:
- Thread CRUD: create, read, list, resume, fork, compact, set-name
- Turn: start, steer, external approval
- Tasks: create, list, get, cancel
- Automations: recurring scheduled jobs with RRULE
- Sessions: save, list, delete, resume
- Auth: optional bearer token
- CORS support for web embeddings

### 2.10 Other notable features

- **Working set**: repo-aware path tracking, `@`-mention fuzzy resolution with lazy file index
- **LSP diagnostics**: inline error/warning surfacing after every edit (rust-analyzer, pyright, typescript, gopls, clangd)
- **Session rollback**: side-git pre/post-turn snapshots with `/restore` and `revert_turn`, doesn't touch `.git`
- **Automations**: cron-style recurring tasks with RRULE
- **Skills system**: composable instruction packs from GitHub
- **Localization**: en, ja, zh-Hans, pt-BR with auto-detection
- **Cost tracking**: live per-turn + session token usage and cost with cache hit/miss breakdown
- **User memory**: optional persistent note file injected into system prompt
- **Workspace trust**: trust-on-first-use for directories
- **Offline eval harness**: representative tool-loop benchmark without network/LLM calls

---

## 3. Patterns & Ideas Worth Stealing

### 3.1 Gemini CLI patterns

| Pattern | What it is | Why it's good |
|---|---|---|
| **Event-driven agent protocol** | Agent emits typed events; UI subscribes | Clean decoupling; supports replay, re-attachment, programmatic consumption |
| **Tool Invocation as a validated object** | Tool params validated first → Invocation created → execute() called | Separates validation errors from execution errors; supports confirmation before execution |
| **Hierarchical MessageBus derivation** | Sub-agents get a derived bus that prefixes confirmation sources | Confirmation dialogs show the full agent chain; no confusion about "who" is asking |
| **Scheduler state machine** | Every tool call has an explicit lifecycle state | Makes retry, cancellation, and error handling deterministic |
| **Policy decision per tool** | Each tool check produces Allow/Deny/AskUser | Uniform API for different approval modes; works across sub-agents |
| **JIT context discovery** | When an edit fails, discover the real content from the file | Clever error recovery that reduces user friction |
| **Skills as markdown** | Skills are just `.md` files with frontmatter | Dead simple; no new format to learn; works with any editor |
| **`AgentLoopContext`** | Single typed context object carrying all dependencies | Clean dependency injection; testable; avoids global singletons |

### 3.2 DeepSeek-TUI patterns

| Pattern | What it is | Why it's good |
|---|---|---|
| **Checkpoint-restart cycles** | Archive old context, restart with structured state + briefing | Beats lossy summarization; preserves model retrieval accuracy; gives deterministic carry-forward |
| **Append-only layered context** | Append summary blocks at soft seams, keep all verbatim messages | Preserves the prefix cache (90% cost discount); model can drill into verbatim when needed |
| **Prefix-cache-aware design** | Decisions explicitly account for KV cache economics | Shows deep understanding of model behavior; the 500K compaction floor is a direct consequence |
| **Auto reasoning heuristics** | Keyword-based effort selection, zero latency | Simple, testable, no extra API calls; strikes a pragmatic balance |
| **Layered policy priority** | Builtin → Agent → User; longest prefix wins | Clean conflict resolution; agent can propose amendments user can override |
| **Durable task queue** | Tasks survive restarts with bounded workers | Practical for long-running batch work; matches how developers actually work |
| **Side-git snapshots** | Workspace snapshots via a parallel `.git`, not the real one | Complete rollback without contaminating user's git history |
| **RRULE-based automations** | Cron-style scheduling using standard RRULE format | Familiar scheduling model; no custom cron parser needed |

### 3.3 Cross-cutting design philosophy differences

| Aspect | Gemini CLI | DeepSeek-TUI |
|---|---|---|
| **Safety posture** | Conservative: proactive confirmation, policy gates, hook-based blocking | Per-mode: YOLO bypasses all, Plan is read-only, Agent has approval gates |
| **Context handling** | Model-agnostic; relies on Gemini's native window + compression | Model-specific; engineered around V4's paper-documented retrieval curve |
| **Extension model** | MCP (standard protocol) + A2A (agent-to-agent) + skills (markdown) | MCP (standard protocol) + skills (GitHub packs) + user commands (templates) |
| **State management** | Ephemeral in-process + config files | SQLite persistence + JSONL archives + checkpoint state |
| **Sub-agent model** | Typed specialized agents (investigator, executor, generalist) | Generic sub-agent spawn with mode/approval inheritance |
| **UI approach** | React component tree (Ink) → declarative | ratatui immediate-mode → procedural, but with a massive ~200-field `App` state |

---

## 4. Specific Ideas Worth Adapting

### High-impact, low-effort

1. **Auto reasoning/effort selection** (from DeepSeek-TUI): A 30-line heuristic that picks `low`/`high`/`max` reasoning effort based on the user's message. Zero latency, trivially testable.

2. **Tool Invocation pattern** (from Gemini CLI): Separate validation from execution. Every tool parse creates a validated `Invocation` with `getDescription()` and `shouldConfirmExecute()`. The actual `execute()` happens after confirmation.

3. **JIT context discovery for edits** (from Gemini CLI): When `old_string` isn't found, re-read the file and compute the actual diff to give the model accurate context. Reduces edit failures dramatically.

4. **Workspace @-mention fuzzy resolution with lazy index** (from DeepSeek-TUI): Two-pass resolution (workspace → cwd → fuzzy) backed by a `OnceLock`-built basename index. Avoids expensive directory walks on every typo.

### Medium-effort, high-payoff

5. **Checkpoint-restart cycles** (from DeepSeek-TUI): Instead of lossy mid-context summarization, archive the session, produce a model-curated ~3K token briefing, and start fresh. The model gets a homogeneous context, no "Frankenstein" half-verbatim half-summary confusion.

6. **Append-only layered context** (from DeepSeek-TUI): Keep all verbatim messages. Append summary blocks at soft seams as navigational aids. This preserves the prefix cache (massive cost savings on long sessions).

7. **Derived MessageBus for sub-agents** (from Gemini CLI): Instead of building parallel confirmation infrastructure, inherit the parent bus with a name prefix. Sub-agent confirmations automatically show the agent chain.

8. **Side-git snapshots** (from DeepSeek-TUI): Run git operations in a parallel `.deepseek-git` directory for pre/post-turn snapshots. Complete rollback without ever touching the user's `.git`.

### Architecture-level

9. **Agent protocol as typed event stream** (from Gemini CLI): Define the agent loop as `send(payload) → stream of typed events`. UI subscribes. SDK gets the same API. Testing becomes: send → collect events → assert.

10. **Durable background task queue** (from DeepSeek-TUI): Persistent JSON task files with bounded workers. Survives restarts. Perfect for long-running batch work like "fix all clippy warnings across 50 files."

11. **Prefix-cache-aware design decisions** (from DeepSeek-TUI): When designing compaction/summarization, explicitly model what happens to the KV cache. Replacement = cache invalidation = 10× cost for subsequent tokens. Append-only = cache stays hot.

---

## 5. What NOT to steal

- **Gemini CLI's ~140 Ink/React components** are overkill for a simpler tool. The component count plus the snapshot-testing infrastructure is heavy.
- **DeepSeek-TUI's monolithic `App` state struct** (~200 fields). They know this is a problem (issue #377 exists to refactor it into typed sub-states).
- **Gemini CLI's Google Cloud telemetry dependency** is not portable.
- **DeepSeek-TUI's crate split is still migrating**, the `crates/tui` monolith is the real runtime; the workspace crates are a work in progress.

---

## 6. The PROMPT_ANALYSIS.md gem

DeepSeek-TUI's `PROMPT_ANALYSIS.md` is a standout document. It's a systematic critique of their own system prompt, identifying where the prompt's conservatism actively inhibits the model's capabilities. Three key insights:

1. **RLM is framed as a last resort** when it's actually three separate patterns (chunk, batch, recurse). The prompt should be a capability guide, not a warning label.
2. **Sub-agents are gated behind planning** ("implementation, not exploration") when they're the best tool for parallel investigation.
3. **The prompt was written for less capable models** and needs updating for V4's increased autonomy.

This is a rare artifact, a team doing honest self-critique of their prompt engineering, informed by model-specific performance data.
