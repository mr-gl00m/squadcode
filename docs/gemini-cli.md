# gemini-cli: analysis

## What this codebase is

Google's Gemini CLI: a TypeScript/Node 20+ ESM monorepo (npm workspaces) for a terminal-first AI coding agent. Roughly seven packages, with the bulk of the interesting logic in `packages/core` (~80+ subdirectories), agents, scheduler, policy engine, MCP, routing, sandbox, hooks, context pipeline, telemetry, sessions. UI is React+Ink in `packages/cli`. It's massive and over-built for Squad Code's needs, but it's TS-native with the same async patterns Squad Code uses, so direct lifting is more viable here than for any Rust-based agent.

The interesting bits for Squad Code are: the subagent architecture (mature, isolated registries, recursion-protection, frontmatter loaders), the policy engine + message bus pattern (clean separation between "decide" and "ask"), the streaming JSON output format, the loop-detection heuristics, and the `DeadlineTimer` utility. Most of the rest is either Gemini-API-specific or scaled for a 50-person team.

## Package map

- `packages/core`, engine. Agents, scheduler, tools, policy, routing, MCP, hooks, sandbox, context, telemetry, session recording. The only package that materially matters for cherry-picking.
- `packages/cli`, Ink-based interactive TUI + non-interactive CLI entry. React components, slash commands, ACP transport.
- `packages/sdk`, programmatic SDK (`GeminiCliAgent`, `GeminiCliSession`, `Tool<T>`) wrapping core for embedding.
- `packages/a2a-server`, experimental Agent-to-Agent server (remote subagents). HTTP+JSON-RPC.
- `packages/devtools`, embedded HTTP/WebSocket inspector for network/console traffic during dev runs.
- `packages/test-utils`, shared vitest helpers and a "test rig" for end-to-end tests.
- `packages/vscode-ide-companion`, VS Code extension that pairs with the CLI (open-files surface, diff manager).

## Cherry-pick candidates

### 1. Subagent architecture: definition / executor / invocation split

**Where:** `packages/core/src/agents/types.ts:191-297` (definitions), `packages/core/src/agents/local-executor.ts:119-320` (executor), `packages/core/src/agents/local-invocation.ts:50-80` (invocation), `packages/core/src/agents/agent-tool.ts:40-120` (the unified `invoke_agent` tool)

**What:** The subagent system has three clean layers. `LocalAgentDefinition` is a pure data record (name, description, prompt, model, tools, run limits, optional Zod output schema). `LocalAgentExecutor.create()` clones the parent message bus with `derive(name)`, builds an isolated `ToolRegistry` honoring `tools` filter (with `*`, `mcp_*`, `mcp_server_*` wildcards), and registers a mandatory `complete_task` tool that doubles as the structured-output channel. A single `invoke_agent` tool exposes any registered subagent to the main model with smart parameter mapping (single-property schemas auto-map the `prompt` arg). Recursion is blocked by skipping `Kind.Agent` tools during sub-registry build (`local-executor.ts:194`). Termination modes are explicit: `GOAL`, `MAX_TURNS`, `TIMEOUT`, `ABORTED`, `ERROR_NO_COMPLETE_TASK_CALL`.

**Fit:** **adapt-shape.** This is exactly the shape Squad Code's Phase 6+ subagent layer wants, depth=1 enforced structurally (no recursion), per-agent tool config, per-agent model selection, structured termination. The clone-and-derive pattern around the message bus / tool registry is the right answer for scope-lock. The `complete_task` tool as the exit channel is cleaner than scanning for stop conditions. Skip the `outputConfig` Zod schema piece for v1, Squad Code can lift the loop shape without forcing structured output.

### 2. Frontmatter-loaded subagent definitions

**Where:** `packages/core/src/agents/agentLoader.ts:50-260`, `packages/core/src/skills/skillLoader.ts:34-100`

**What:** Subagents and skills are both `.md` files with YAML frontmatter parsed via `js-yaml` plus a fallback simple key-value parser for descriptions containing colons. Zod schema validates `name` (slug regex), `description`, `tools` array (with wildcards), `mcp_servers` map, `model`, `temperature`, `max_turns`, `timeout_mins`. Discriminated union for local vs. remote agents with field-presence-based kind inference (`guessIntendedKind`). Project-level `.gemini/agents/*.md` and user-level `~/.gemini/agents/*.md`.

**Fit:** **lift-as-is** (with name changes). The pattern matches Cid's existing skill ecosystem exactly, `.shards`, the existing skill `.md` files, and the project-kickoff workflow. Squad Code can use the same loader shape pointed at `.squad/agents/*.md` or similar. Zod is already in Squad Code's deps via providers, `js-yaml` is one new dep. The "fallback simple parser when YAML breaks on description colons" trick is a nice resilience touch.

### 3. MessageBus with `derive(subagentName)` for confirmation routing

**Where:** `packages/core/src/confirmation-bus/message-bus.ts:15-247`

**What:** A node `EventEmitter` wrapping `PolicyEngine`. Tools publish `TOOL_CONFIRMATION_REQUEST`; the bus consults the policy engine, then either auto-resolves with `TOOL_CONFIRMATION_RESPONSE` (for ALLOW / DENY) or emits to UI listeners (for ASK_USER). Headless flow: if no listener is attached, immediately resolves with `requiresUserConfirmation: false` to avoid hanging. `derive(subagentName)` clones the bus with a wrapped `publish` that injects/composes the subagent name into messages, so policy rules can target subagent-scoped permissions. Includes a clean correlation-ID `request<TRequest, TResponse>(...)` request/response pattern.

**Fit:** **adapt-shape.** Squad Code's `permissions/policy.ts` is currently inline in the tool-execution path. Lifting this bus pattern would: (a) decouple "who decides" from "where the user clicks," (b) make subagent scope-lock trivial via `derive()`, (c) give a clean test seam. The correlation-ID request pattern is a small drop-in for any async confirmation flow. Don't lift the full policy engine, just the bus shape.

### 4. Three-decision policy engine (ALLOW / DENY / ASK_USER) with priority bands

**Where:** `packages/core/src/policy/types.ts:10-65, 280-330` (types + `PolicyDecision` enum + `ApprovalMode`), `packages/core/src/policy/policy-engine.ts:49-150`, `packages/core/src/policy/policies/plan.toml`

**What:** Three decisions instead of binary allow/deny. Rules carry priority, mode (`default`/`autoEdit`/`yolo`/`plan`), `argsPattern` regex, `toolAnnotations` matching, optional `subagent` scope, `denyMessage`. Tier-based priority: admin > user > workspace > extension > default, with fractional priorities inside each tier (e.g., 4.95 = "Always Allow" within user tier). `enter_plan_mode` / `exit_plan_mode` are first-class tools with their own policy entries. Plan Mode is a catchall DENY at priority 40 with explicit ALLOW exceptions for read-only tools and the plans directory.

**Fit:** **inspiration-only.** The three-decision shape (ASK_USER as a real decision, not a fallback) is genuinely better than a binary, and the priority band is the right answer to "how do user rules beat default rules." But Squad Code's permissions are currently lightweight pattern matching; lifting the full TOML loader, tier system, and approval-mode plumbing is overkill for a vetting harness. The lesson worth taking: model `ASK_USER` as a third explicit decision in `permissions/policy.ts` and let the bus handle prompting. Plan Mode itself is probably wrong-scale for Squad Code.

### 5. Loop detection: cheap structural + LLM second-pass

**Where:** `packages/core/src/services/loopDetectionService.ts:29-280`

**What:** Two-tier detection. Tier 1: cheap structural, SHA256 of `tool_name + JSON.stringify(args)` triggers if 5 consecutive identical tool calls (`TOOL_CALL_LOOP_THRESHOLD`); content-chanting via 50-char chunked stats triggers at 10 repeats. Tier 2: after 30 turns, every 10 turns (interval scales 5-15 based on confidence), call the model with a structured-output prompt asking for `unproductive_state_analysis` + `unproductive_state_confidence`, threshold 0.9. The system prompt is precise about distinguishing "batch operation across files" from "true repetition", argument-aware comparison.

**Fit:** **adapt-shape.** Squad Code is *exactly* the project where weird local-model loops happen, that's the whole vetting purpose. The Tier-1 structural check (consecutive identical tool calls by SHA256 hash) is dirt cheap and lifts in 30 lines. Tier-2 is more ambitious but interesting: when vetting a flaky local model, kicking the trace to a different model for a "is this stuck?" check has obvious value. The prompt itself is well-crafted and worth pirating. Build Tier 1 first, hold Tier 2 until provider routing matures.

### 6. `DeadlineTimer`: pause/resume/extend abort budget

**Where:** `packages/core/src/utils/deadlineTimer.ts:11-94`

**What:** ~80 LOC wrapper around `AbortController` that owns a remaining-time budget. Supports `pause()` (clears timeout, accumulates elapsed), `resume()` (reschedules with remaining), `extend(ms)` (adds budget mid-flight), `abort(reason)` (immediate). The agent loop pauses the timer while awaiting user confirmation so the budget doesn't bleed during human-in-the-loop pauses.

**Fit:** **lift-as-is.** Drop-in utility with zero deps, useful anywhere Squad Code wants a per-task or per-tool wall-clock budget. The pause-during-confirmation use case alone is worth it, Squad Code's REPL can hang waiting for permission prompts and silently consume budget otherwise.

### 7. Streaming JSON output format (`stream-json`)

**Where:** `packages/core/src/output/types.ts:9-117`, `packages/core/src/output/stream-json-formatter.ts:18-88`

**What:** Three output formats: `TEXT`, `JSON`, `STREAM_JSON`. Stream variant is newline-delimited JSON (JSONL) with typed events: `init` (session_id + model), `message` (user/assistant + delta flag), `tool_use`, `tool_result`, `error`, `result`. Per-model token breakdown in `StreamStats` (input, output, cached, duration_ms, tool_calls). Emits straight to stdout for downstream consumers.

**Fit:** **lift-as-is.** This is the most direct value-per-LOC item in the codebase for Squad Code's vetting purpose. Squad Code is *literally* about comparing local models on tool-use loops, JSONL streaming output gives you a recording you can grep, diff, and feed into a comparison harness without any GUI. The token-and-cache breakdown per model maps cleanly onto Squad Code's known caching gaps (DeepSeek invisible auto-cache, Anthropic unimplemented). Make this the canonical capture format for vetting runs.

### 8. Composite/chain-of-responsibility routing strategies

**Where:** `packages/core/src/routing/routingStrategy.ts:14-81`, `packages/core/src/routing/strategies/compositeStrategy.ts:22-122`, `packages/core/src/routing/modelRouterService.ts:30-100`

**What:** A `RoutingStrategy` interface, `route(context) → Promise<RoutingDecision | null>` where null means "decline, try next." `CompositeStrategy` chains them with a guaranteed-terminal strategy at the end. The default chain is: fallback → override → approval-mode → (optional) gemma-classifier → classifier → numerical-classifier → default. Each strategy reports source + latency in metadata for telemetry.

**Fit:** **adapt-shape.** Squad Code has `providers/dispatch.ts` doing kind-dispatch but no concept of "complexity-classify the request and pick a model." For the vetting purpose that's actually useful: route trivial single-tool requests to a small local model (Qwen 0.6B) and complex multi-step tasks to the bigger one, then compare outcomes. The composite-with-terminal pattern is a clean way to layer override/fallback/auto-pick. The classifier strategies themselves are Gemini-specific but the *shape* is portable.

### 9. Conversation recording with `chatRecordingService`

**Where:** `packages/core/src/services/chatRecordingService.ts:1-100`, `packages/core/src/services/chatRecordingTypes.ts:12-100`

**What:** Per-session JSONL files under a project-hash temp dir. Records `MessageRecord` (user/assistant/info/error/warning), `ToolCallRecord` with status + result, thoughts, per-message token usage (input/output/cached/thoughts/tool/total), `RewindRecord` for checkpoint markers, `MetadataUpdateRecord` for `$set` ops. ENOSPC is handled gracefully (recording continues in memory but skips disk). Supports session resume via `loadConversationRecord` reading the JSONL back.

**Fit:** **adapt-shape.** Squad Code already has `src/sessions/`, this is shape-level inspiration for what should be in the session record. The `MemoryScratchpad` (workflow summary, tool sequence, touched paths, validation status) is particularly relevant for vetting, those are exactly the fields you want to compare across model runs. The ENOSPC graceful-degrade is a nice resilience touch. Don't lift the full Gemini-specific token shape; do lift the layout (JSONL events with a typed discriminator).

### 10. Shadow git repo for checkpointing

**Where:** `packages/core/src/services/gitService.ts:22-150`

**What:** A hidden git repo under the project's history dir that snapshots the workspace before tool calls, with isolated `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` so it doesn't pick up the user's git identity or hooks. Hardcoded author "Gemini CLI <gemini-cli@google.com>", `gpgsign = false`, env-sanitized. Used by the `/rewind` command to roll the workspace back to a previous tool-call boundary.

**Fit:** **inspiration-only.** Squad Code probably doesn't need full workspace snapshot/rewind, the vetting scope is "did the model handle the tool loop right," not "let me undo what it did to my repo." But the pattern of "isolated shadow git that doesn't inherit user config" is good defensive practice and quick to build if Squad Code ever needs it. The env-sanitization for git child processes (`getShadowRepoEnv`) is the part worth remembering.

### 11. `BaseToolInvocation` lifecycle: validate / confirm / execute / display

**Where:** `packages/core/src/tools/tools.ts:47-360` (interface + base class)

**What:** Tools split into a `ToolBuilder` (creates invocations from raw params) and a `ToolInvocation` (validated, executable). Invocations have `getDescription()`, `getDisplayTitle()`, `getExplanation()`, `toolLocations()`, `shouldConfirmExecute(signal, forcedDecision)`, `execute(options)`, `getPolicyUpdateOptions(outcome)`. `BaseToolInvocation` wires `shouldConfirmExecute` to the message bus by default, subclasses override `getConfirmationDetails()` for custom confirmation UI. `respectsAutoEdit` flag bypasses confirmation in `AUTO_EDIT` mode for safe tools.

**Fit:** **adapt-shape.** Squad Code's tools (`src/tools/*.ts`) currently mix validation, confirmation, and execution. Splitting into validated-invocation objects gives a clean test seam (you can construct an invocation without executing it) and lets the scheduler reason about a queue of pending invocations. The `getDisplayTitle` / `getDescription` separation matters for any UI work. Worth refactoring during the next tools sweep.

### 12. Environment sanitization for spawned children

**Where:** `packages/core/src/services/environmentSanitization.ts:13-100`

**What:** When tools spawn child processes (shell, git, MCP servers), `sanitizeEnvironment(processEnv, config)` filters out env vars by allowlist/blocklist, with a strict mode that auto-engages in CI (`GITHUB_SHA` set or `SURFACE === 'Github'`). `ALWAYS_ALLOWED_ENVIRONMENT_VARIABLES` set covers cross-platform basics (PATH, HOME, TMP, TERM, locale). Blocks credential-shaped env vars by default.

**Fit:** **lift-as-is.** Squad Code spawns shell processes via the `shell` tool and is going to spawn MCP servers eventually. This pattern is small, defensive, and one of those "you'll wish you had it later" utilities. Particularly valuable if Squad Code ever runs in untrusted-folder contexts where the LLM might trick a tool into reading `OPENAI_API_KEY` via a child process.

### 13. Hook system event taxonomy

**Where:** `packages/core/src/hooks/types.ts:43-160`

**What:** Eleven hook events with a clean taxonomy: `BeforeTool`, `AfterTool`, `BeforeAgent`, `AfterAgent`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `SessionStart`, `SessionEnd`, `PreCompress`, `Notification`. Two implementation types: `Command` (spawn external binary) or `Runtime` (in-process function). Hook outputs can return `decision: 'block' | 'deny' | 'approve' | 'ask'` to influence the loop, plus `systemMessage`, `stopReason`, `suppressOutput`. Source tracking (`project` / `user` / `system` / `extension`) for visibility filtering.

**Fit:** **inspiration-only.** Squad Code already has `src/hooks/` but the event taxonomy is much narrower. The 11-event surface area is over-built for a vetting harness, but the *naming* and the `BeforeToolSelection` event in particular are interesting, that's a hook fired *before* the model picks a tool, which lets you inject context or veto choices. Worth flagging as a reference if Squad Code ever expands the hook surface beyond the current set. Also: the `ask` decision returned from a hook lifts cleanly into the three-decision policy model from candidate #4.

### 14. Subagent-scoped tool isolation pattern

**Where:** `packages/core/src/agents/local-executor.ts:158-290` (the `create()` method's registry build)

**What:** When a subagent starts, the executor walks the parent tool registry and clones each tool into a fresh per-agent `ToolRegistry` bound to a derived message bus. The clone (`tool.clone(subagentMessageBus)`) gives each agent its own state and its own confirmation routing. Agent tools (`Kind.Agent`) and the main-only `update_topic` tool are skipped. Wildcards are expanded against the parent registry: `*` (everything), `mcp_*` (all MCP), `mcp_serverName_*` (one server's tools). MCP servers can also be defined inline per-agent, isolated from the global pool.

**Fit:** **adapt-shape.** This is the "scope-lock" piece of Squad Code's Phase 6+ design, made concrete. The clone-bind-derive shape is exactly what makes scope-lock work: the subagent literally cannot publish a confirmation under a different identity because the bus it has wraps every publish. Inline MCP-per-agent is a future-proofing detail Squad Code probably wants once MCP lands. Lift the wildcard semantics directly, `*`, `mcp_*`, `mcp_<server>_*`, they're tiny and the user-facing convention should match what Gemini CLI / Claude Code already established.

### 15. SDK shape: `Agent` / `Session` / `Tool<T>` with Zod input schema

**Where:** `packages/sdk/src/agent.ts:40-120`, `packages/sdk/src/types.ts:31-242`, `packages/sdk/src/tool.ts:40-100`

**What:** A clean public API: `new GeminiCliAgent({ instructions, tools, skills, model, cwd })` → `agent.session()` → `session.sendStream(prompt)` returns an async iterator of typed events. Tools are defined with a Zod schema and an action `(params, context) => Promise<unknown>`. `SessionContext` exposes `fs`, `shell`, `transcript`, `agent`, `session` to tool actions. `instructions` can be a string or a function that takes `SessionContext` (with explicit prompt-injection warnings in the docs). `ModelVisibleError` is a sentinel that bubbles errors back to the model.

**Fit:** **adapt-shape.** Squad Code is currently CLI-only but a programmatic SDK would let it be a *library*, the vetting harness becomes something you can `import` and run from a test or another tool. The Zod-schema-for-tool-input pattern is cleaner than what Squad Code has now and integrates nicely with provider tool-call schemas. The `ModelVisibleError` distinction (this error goes to the model vs. this error stops the loop) is a useful primitive worth lifting even without the full SDK.

## What I'm deliberately not flagging

- **Sandbox managers (Linux/macOS/Windows)**: bwrap, sandbox-exec, Windows seatbelt. Significant code and OS-specific. Squad Code's vetting purpose doesn't need full process isolation, running on a trusted dev box. Revisit if Squad Code ever runs untrusted code.
- **Browser agent (`packages/core/src/agents/browser/`)**: tied to chrome-devtools-mcp, accessibility-tree navigation, visual model integration. Cool but completely off-scope.
- **A2A server (`packages/a2a-server`)**: remote subagent protocol. Squad Code is local-first; remote subagents are anti-thesis.
- **Devtools network/console inspector (`packages/devtools`)**: web-based inspector for the Gemini API traffic. Useful for Google's API debugging, irrelevant for local-Ollama vetting.
- **VS Code companion (`packages/vscode-ide-companion`)**: out of scope, Squad Code is a TUI/CLI.
- **Gemini-specific routing strategies (`gemmaClassifierStrategy`, `numericalClassifierStrategy`)**: tied to LiteRT-LM runtime and Gemma-specific tokens. Replace with whatever local-classification setup Squad Code wants if/when it adopts the composite-strategy pattern.
- **Code Assist / billing (`packages/core/src/billing/`, `code_assist/`)**: Google One AI credits, OAuth, quota management. None of this exists for Squad Code's domain.
- **OAuth token storage / keychain integration**: useful pattern but Squad Code uses local API keys via env. Lift only if cloud providers become primary, which they won't.
- **Voice subsystem (`packages/core/src/voice/`)**: Whisper, Gemini Live transcription. Not in scope.
- **Telemetry (OpenTelemetry, dev-trace spans)**: heavy; Squad Code's logging via `pino` is the right scale.
- **Context pipeline (`packages/core/src/context/pipeline/`)**: blob degradation, node distillation, rolling summary, tool masking, sophisticated context-management pipeline aimed at 1M-token windows. Squad Code testing local models with 8K-32K windows can use simpler truncation. The chat-compression service alone (`chatCompressionService.ts`) is more directly applicable.
- **CLI Ink/React UI (`packages/cli/src/ui/`)**: heavy React+Ink, custom hooks, IDE nudges. Squad Code's TUI is much simpler; lifting components costs more than rebuilding the few it needs.
- **The whole `safety/conseca` external safety-checker bridge**: external HTTP service for safety checks. Production-scale concern, not Squad Code's problem.
- **Memory/Skills builtin set**: skill loading is worth flagging (and is in cherry-pick #2), but the actual built-in skills (`packages/core/src/skills/builtin`) are Gemini-team-specific.
- **Conversation rewind (`/rewind`) command**: depends on the shadow git repo (#10). Skip for the same reason.

## Open questions

- **How does `tool.clone(subagentMessageBus)` actually work for stateful tools?** I read the registry-build path but didn't trace into `clone()` on a real tool to see whether the cloned tool keeps caches or starts fresh. Matters for Squad Code's scope-lock semantics, if the cloned tool shares state, scope-lock leaks.
- **Streaming JSON event ordering guarantees.** The format (#7) is clean but I didn't verify that `tool_use` always precedes its matching `tool_result` in the JSONL. Squad Code's downstream comparison harness will assume that.
- **How does the policy engine handle conflicting same-priority rules?** I saw the priority-band scheme but didn't trace the tiebreaker. If Squad Code lifts the three-decision shape, the tiebreaker matters.
- **Hook timeout semantics under `Runtime` type.** Command hooks have a clear spawn+timeout model; runtime hooks pass an `AbortSignal` but I didn't verify what happens when a runtime hook ignores the signal. Worth knowing before lifting.
- **`onBeforeTurn` hook on `LocalAgentDefinition`** (`agents/types.ts:268`), runs after compression, before model call, can mutate chat history. Powerful but easy to footgun. Didn't get to see how the built-in agents use it (or don't).
