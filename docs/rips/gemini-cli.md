# Rip-apart: gemini-cli (2026-05-20 refresh)

_Anchored against `docs/code-rip-analysis.md` (sections 1.1-1.8, 3.1) and `docs/rip-these-apart-2026-05-08.md`. Source: `N:\proj_ai_squad_code\.rnd\gemini-cli-main\`, file mtimes 2026-05-20. Latest stable release per `docs/changelogs/latest.md` is v0.42.0 (2026-05-12)._

## What changed since 2026-05-08

The package list is unchanged, still `core / cli / sdk / a2a-server / devtools / test-utils / vscode-ide-companion`. The interior of `packages/core/src/` has reshaped significantly. The headline addition is a graph-based context-management pipeline that wasn't called out in the prior rip; everything else is incremental but the volume is large.

**New top-level directories in `packages/core/src/`** (vs. the prior analysis's working set):

- `availability/`, `ModelAvailabilityService` (`packages/core/src/availability/modelAvailabilityService.ts`), error classification, policy-catalog driven model fallback. Health states `terminal` / `sticky_retry` with quota/capacity tracking.
- `confirmation-bus/`, `MessageBus` was previously nested under `tools/`; now its own top-level module with expanded message types (see below).
- `context/`, completely new context-management subsystem; replaces what was implicit in `core/`. Pipeline + graph + processors.
- `fallback/`, `handleFallback()` in `packages/core/src/fallback/handler.ts`, hooks into availability service for model fallback flow.
- `output/`, `JsonFormatter` and `StreamJsonFormatter` (`packages/core/src/output/stream-json-formatter.ts`), newline-delimited JSON for headless agent use.
- `routing/`, `ModelRouterService` with composite strategy chain. Strategies under `strategies/`: `FallbackStrategy`, `OverrideStrategy`, `ApprovalModeStrategy`, `GemmaClassifierStrategy`, `ClassifierStrategy`, `NumericalClassifierStrategy`, `DefaultStrategy`. Local Gemma classifier (LiteRT-LM) is a real option.
- `safety/`, `InProcessChecker` + `ConsecaSafetyChecker` singleton. Conseca generates fine-grained per-prompt security policies via LLM. Adjacent runners: `checker-runner.ts`, `context-builder.ts`, `registry.ts`.
- `commands/`, programmatic command modules: `init`, `restore`, `memory`, `extensions`. Pulled out of CLI into core for SDK consumption.

**Reshaped subsystems**:

- **Event types (`packages/core/src/agent/types.ts`)**, `AgentEvents` is now a typed map. Prior analysis listed `tool_call_request`, `tool_call_response`, `tool_call_confirmation`, `thought`, `citation`, `chat_compressed`. Current set: `initialize`, `session_update`, `message`, `agent_start`, `agent_end`, `tool_request`, `tool_update`, `tool_response`, `elicitation_request`, `elicitation_response`, `usage`, `error`, `custom`. Confirmation collapsed into elicitation; thought/citation collapsed into `message` content parts; chat_compressed gone (replaced by `session_update`).
- **Tool execution events split**, old single `tool_call_response` is now `tool_request` (immediate echo) + `tool_update` (ephemeral progress for long-running tools, doesn't affect model context) + `tool_response` (final). The `ToolUpdate` event explicitly notes it's display-only.
- **Scheduler (`packages/core/src/scheduler/types.ts:36-57`)**, `ToolCallRequestInfo` grew `schedulerId`, `parentCallId`, `traceId`, `originalRequestName`/`Args` (for tail calls), `inputModifiedByHook`, `forcedAsk`, `checkpoint`. The state machine itself is the same seven states, but tool calls now carry `tailToolCallRequest` for chained execution.
- **MessageBus (`packages/core/src/confirmation-bus/types.ts:18-29`)**, expanded from two message types to ten: `TOOL_CONFIRMATION_REQUEST/RESPONSE`, `TOOL_POLICY_REJECTION`, `TOOL_EXECUTION_SUCCESS/FAILURE`, `UPDATE_POLICY`, `TOOL_CALLS_UPDATE`, `ASK_USER_REQUEST/RESPONSE`, `SUBAGENT_ACTIVITY`.
- **Confirmation details serializable (`packages/core/src/confirmation-bus/types.ts:84-143`)**, new `SerializableConfirmationDetails` union for `sandbox_expansion`, `info`, `edit`, `exec`, `mcp`, `ask_user`, `exit_plan_mode`. Data-only, transmissible over the bus instead of attaching live callbacks.
- **Hook event names (`packages/core/src/hooks/types.ts:43-55`)**, prior six fired around tool use / session boundaries. Current eleven: `BeforeTool`, `AfterTool`, `BeforeAgent`, `Notification`, `AfterAgent`, `SessionStart`, `SessionEnd`, `PreCompress`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`. Model-call wrapping (`BeforeModel`/`AfterModel`) and pre-compaction (`PreCompress`) are new. `HookType.Runtime` (in-process JS hooks) is now a peer of `HookType.Command` (shell hooks).
- **Policy engine**, TOML-driven. `packages/core/src/policy/policies/*.toml` ships `agents.toml`, `conseca.toml`, `discovered.toml`, `non-interactive.toml`, `plan.toml`, `read-only.toml`, `sandbox-default.toml`, `write.toml`, `yolo.toml`. Priority bands: Default(1)→Extension(2)→Workspace(3)→User(4)→Admin(5), with `priority/1000` as intra-tier sort. Settings-based rules live in tier 4.x with documented sub-priorities (4.95 "Always Allow", 4.9 MCP exclusion, 4.4/4.3 CLI flags, 4.2/4.1 trust/allow lists).
- **Subagent system (`packages/core/src/agents/`)** matured significantly. New surface: `agent-scheduler.ts` (dedicated subagent tool scheduling with `schedulerId`/`parentCallId`/`subagent` propagation), `auth-provider/factory.ts` (api-key, oauth2, google-credentials, http providers for remote agents), `local-session-invocation.ts`/`remote-session-invocation.ts`, `local-subagent-protocol.ts`/`remote-subagent-protocol.ts`, `acknowledgedAgents.ts`, `skill-extraction-agent.ts`, and a full `browser/` subdir with snapshot superseding, input blocker, screenshot analysis, mcp tool wrapping.

**New tools in `packages/core/src/tools/`**:

- `ask-user.ts`, model can pose multi-question dialogs to the user. Question types: `CHOICE` (with multi-select), `TEXT`, `YESNO`. Wraps over MessageBus `ASK_USER_REQUEST/RESPONSE`.
- `enter-plan-mode.ts` / `exit-plan-mode.ts`, model-driven plan mode transitions. Plan-mode policy in `policies/plan.toml` denies writes outside `.gemini/tmp/.../plans/*.md`.
- `get-internal-docs.ts`, fetches built-in docs into context.
- `shellBackgroundTools.ts`, `list_background_processes`, `kill_background_process`, `read_background_output`. Background shell sessions managed by `ShellExecutionService.listBackgroundProcesses`.
- `shell_proactive.test.ts`, proactive shell suggestions (not just on-call).
- `trackerTools.ts` + `services/trackerService.ts`, task graph with dependencies (`tracker_create_task`, `tracker_add_dependency`, `tracker_visualize`, `tracker_list_tasks`, `tracker_update_task`, `tracker_get_task`). Tasks have parent/child + status (`OPEN`, `IN_PROGRESS`, `BLOCKED`, `CLOSED`). This is a step beyond a flat TodoWrite list.
- `write-todos.ts`, explicit todos tool. Statuses include `cancelled` and `blocked` in addition to pending/in_progress/completed.
- `read-many-files.ts`, batch reads.
- `tools/definitions/`, declaration metadata pulled into a separate folder with `model-family-sets/` per-model schemas, `modelFamilyService.ts`, and `coreToolsModelSnapshots.test.ts` for golden testing the tool schema per model family.

**New docs**:

- `docs/release-confidence.md`, the playbook prior batch flagged for theft. Three levels: automated gates (CI, E2E, post-deploy smoke), manual verification (one-week preview dogfood, CUJ checklist, tier-1/2 bug bash), telemetry/eval review (`go/gemini-cli-dash`, `go/gemini-cli-offline-evals-dash`). Explicit go/no-go checklist.
- `docs/cli/rewind.md`, `/rewind` command + double-Esc shortcut. Three modes: rewind conversation only, revert code only, or both. Side-git managed (works across compression).
- `docs/cli/auto-memory.md`, background mining of past sessions for memory/skills, candidates land in `.inbox/{private,global}/extraction.patch`. Off by default behind `experimental.autoMemory`.
- `docs/cli/git-worktrees.md`, `--worktree [name]` flag spawns isolated worktree under `.gemini/worktrees/`. Experimental behind `experimental.worktrees`.
- `docs/cli/plan-mode.md`, explicit plan mode (read-only research, Shift+Tab cycle to enter, `--approval-mode=plan` to start in it).
- `docs/cli/model-routing.md`, `docs/cli/model-steering.md`, `docs/core/gemma-setup.md`, `docs/core/local-model-routing.md`, model routing surface including local Gemma classifier.
- `docs/cli/acp-mode.md`, Agent Client Protocol mode (`--acp`), JSON-RPC over stdio for IDE integrations. Companion to (not replacement of) the VS Code companion.
- `docs/cli/notifications.md`, OSC 9 system notifications, falls back to BEL.
- `docs/cli/enterprise.md` + `docs/admin/enterprise-controls.md`, central admin policies including a "strict mode" that disables yolo organization-wide.
- `docs/core/subagents.md`, `docs/core/remote-agents.md`, A2A remote subagents now a documented public feature, not just a research surface.
- `docs/tools/{ask-user,internal-docs,planning,todos,tracker}.md`, one doc per new tool above.

**Other movement**:

- `evals/` doubled in size to ~40 evals including named ones for `ask_user`, `subagents`, `plan_mode`, `subtask_delegation`, `generalist_delegation`, `model_steering`, `concurrency-safety`, `tool_output_masking`, `auto_memory_contract`, `validation_fidelity`, `skill_extraction`, `unsafe-cloning`. The prior batch flagged delegation/concurrency/plan-mode evals as worth borrowing, they're more developed now.
- `memory-tests/` and `perf-tests/` exist with `baselines.json` and `.responses` fixtures (idle-startup, multi-turn, simple-prompt, long-chat, asian-language, skill-loading, high-volume, cold-startup). Confirms the perf/memory baseline idea from the 2026-05-08 batch.
- `integration-tests/` carries `.responses` golden files alongside `.test.ts` files now uniformly. This is the offline-replay pattern prior batch flagged.
- VS Code companion (`packages/vscode-ide-companion/`) added `diff-manager.ts`, IDE server now has tests for open-file tracking and lifecycle.

## What it is (one paragraph refresh)

Still Google's official Gemini CLI: TypeScript/Node monorepo, Ink/React TUI, model-side bound to `@google/genai`. Product shape has widened: it's now plausible to call this an IDE-grade agent platform with three coexisting consumption modes, interactive TUI, ACP (JSON-RPC stdio for editors like Zed/JetBrains), and SDK (`packages/sdk/` with `GeminiCliAgent`, `GeminiCliSession`, programmatic tools/skills). A2A remote subagents are documented public surface, not just plumbing. The auto-memory loop (mine past sessions, propose memory patches + new skills via a sandboxed `skill-extraction-agent` writing only to `.inbox/`) is the most ambitious new feature.

## Architecture at a glance: updates only

**Context management is now a graph pipeline.** This is the biggest reshape and the prior rip didn't mention it.

- `packages/core/src/context/contextManager.ts` is the entry point. The "master state" is a `ContextWorkingBuffer` holding pristine and active versions of a graph of `ConcreteNode`s.
- Each ConcreteNode wraps a `Part` 1:1 with a `NodeType` (`USER_PROMPT`, `SYSTEM_EVENT`, `AGENT_THOUGHT`, `TOOL_EXECUTION`, `MASKED_TOOL`, `AGENT_YIELD`, `SNAPSHOT`, `ROLLING_SUMMARY`) and tracks `replacesId` (for 1:1 substitutions like masking) and `abstractsIds` (for N:1 summaries). The internal name for this is "Nodes of Theseus", high-fidelity reconstruction of history through substitution chains.
- `packages/core/src/context/pipeline/orchestrator.ts` runs registered pipelines on triggers, with a mutex per pipeline and a `waitForPipelines()` "pressure barrier" the manager calls before LLM dispatch.
- Processors under `packages/core/src/context/processors/`: `blobDegradationProcessor`, `historyTruncationProcessor`, `nodeDistillationProcessor`, `nodeTruncationProcessor`, `rollingSummaryProcessor`, `stateSnapshotProcessor` + async variant, `toolMaskingProcessor`. These are the actual mutation strategies.
- Graph rendering layer (`graph/render.ts`, `graph/mapper.ts`) projects the graph back to API `Content[]` for the model. `graph/builtinBehaviors.ts` + `graph/behaviorRegistry.ts` define per-node-type rendering.
- Config-driven: `context/config/configLoader.ts`, `context/config/profiles.ts`, `context/config/schema.ts`. Profiles select which processors run.

This is a real answer to the prior batch's DeepSeek-TUI-inspired note: "checkpoint-restart cycles vs. append-only layered context vs. compaction." Gemini's answer is a graph with replacement/abstraction tracking, not raw history. It lets multiple compression strategies coexist as orderable pipeline stages.

**Routing is now its own subsystem with composite strategies.**

`packages/core/src/routing/modelRouterService.ts:39-67` builds a chain: FallbackStrategy → OverrideStrategy → ApprovalModeStrategy → (GemmaClassifierStrategy if enabled) → ClassifierStrategy → NumericalClassifierStrategy → DefaultStrategy (terminal). Each `RoutingStrategy.route()` returns `RoutingDecision | null`; null means "I have no opinion, next strategy please." The local Gemma classifier path runs against `LocalLiteRtLmClient` so routing can happen without a hosted call.

**Conseca is LLM-generated, prompt-driven security policy.**

`packages/core/src/safety/conseca/conseca.ts:28-77` is a singleton checker. On a new user prompt, it calls a small Gemini Flash model with `CONSECA_POLICY_GENERATION_PROMPT` to produce a per-prompt `SecurityPolicy` (per-tool `allow` / `deny` / `ask_user` + constraints + rationale). Subsequent tool calls in that prompt are enforced by `policy-enforcer.ts` against that generated policy. Layered on top of the TOML policy engine, not replacing it. Wired into the standard safety checker registry, `policies/conseca.toml` simply registers it for `*`.

**Hooks expanded with model-wrap and pre-compress.**

`BeforeModel` / `AfterModel` hooks can synthesize a response (bypass the model entirely), modify config, modify contents (`HookEventName.BeforeModel` → `BeforeModelHookResult.modifiedContents`). `BeforeToolSelection` runs even earlier in the loop. `PreCompress` fires before compaction begins. Runtime hooks (`HookType.Runtime`) are in-process functions, not shell commands, this is the path Squad's checklist already considers via the `howl` lifecycle layer.

## Features worth stealing (new since prior analysis)

### Already-named in prior batch but more developed now

- **`docs/release-confidence.md`** (`docs/release-confidence.md`), full text matches what the 2026-05-08 batch flagged. Three levels with explicit go/no-go checklist. Squad's local version was already in the backlog; the gap is just writing it.
- **Offline integration harness with `.responses` golden files**, `integration-tests/*.responses` is uniform now. Both the prior batch's instinct (committed model fixtures + replay) and the deflake script are confirmed correct.

### Newly visible

- **Tracker tool graph (`packages/core/src/tools/trackerTools.ts`, `services/trackerService.ts`)**, task DAG with `parentId`, `dependencies`, status enum, `tracker_visualize` rendering. Beyond a flat checklist. Gives the model first-class dependency tracking. Squad's TodoWrite could grow a "blocked by X" link before going full tracker.
- **`ask_user` tool (`packages/core/src/tools/ask-user.ts`)**, model-initiated user questions with structured Question types (CHOICE/TEXT/YESNO), multi-select, "Other" free-text fallback. Routed through MessageBus `ASK_USER_REQUEST/RESPONSE`. Cleaner than encoding clarifying questions in assistant text.
- **`enter_plan_mode` / `exit_plan_mode` as model-callable tools (`packages/core/src/tools/enter-plan-mode.ts`)**, model can transition into a read-only research mode. Policy enforcement in `policies/plan.toml` denies writes outside `.gemini/tmp/.../plans/*.md`. The "plan mode is just an approval mode with explicit transition tools" framing is portable to Squad's checklist gating.
- **Background-process shell tools (`packages/core/src/tools/shellBackgroundTools.ts`)**, `list_background_processes`, `kill_background_process`, `read_background_output`. Lets the model spawn a long-running shell process and monitor it without blocking the agent loop. Useful when Squad starts running real test suites.
- **`PreCompress` and `BeforeModel`/`AfterModel` hooks (`packages/core/src/hooks/types.ts:51-54`)**, Squad's hooks fire around tool use and sessions. Wrapping the model call is the natural addition: lets hooks transparently swap model, inject system context, or shortcut to a synthetic response. Maps cleanly onto Squad's existing `HookRunner`.
- **`SerializableConfirmationDetails` union (`packages/core/src/confirmation-bus/types.ts:84-143`)**, confirmation payloads are pure data, not closures. Lets the bus serialize and replay confirmations, decouples the confirmer from the asker. Helpful when Squad's permission UI needs to live behind a worktree-isolated subagent.
- **Graph-based context pipeline (`packages/core/src/context/graph/`, `pipeline/`, `processors/`)**, not for direct theft (too heavy), but the pattern `(Node = wraps a Part 1:1) + (replacesId / abstractsIds chains)` is the right shape for "lossy summarization that's still auditable." Squad's auto-compact currently drops history wholesale; tracking replacement provenance would let `/restore` work after a compact.
- **Tail tool call requests (`packages/core/src/scheduler/types.ts:76-79`)**, `TailToolCallRequest`. A completed tool can request the scheduler run another tool immediately, before returning control to the model. Useful for "write file → run formatter on it" sequences without a model round-trip.
- **Tool definition snapshots per model family (`packages/core/src/tools/definitions/model-family-sets/`)**, tools resolve their JSON schema declarations against the active model family. Catches schema regressions per provider. Aligns with Squad's catalog-driven provider strategy: a `coreToolsModelSnapshots.test.ts` equivalent would lock in "tool X declares schema Y for adapter kind Z."
- **Skill creator as a built-in skill (`packages/core/src/skills/builtin/skill-creator/SKILL.md`)**, bootstrap skill that teaches the model how to write skills. Squad's `/skills` could ship one of these.
- **Auto-memory extraction agent with narrow write scope (`packages/core/src/agents/skill-extraction-agent.ts`)**, runs in background, gated to write only under `<projectMemoryDir>/.inbox/{private,global}/extraction.patch` and the skills dir, via the `memoryInboxAccess` and `autoMemoryExtractionWriteAccess` flags on the agent definition (`packages/core/src/agents/types.ts:240-252`). Patches are reviewed before they land. This is the right shape if Squad ever auto-mines transcripts.
- **`docs/admin/enterprise-controls.md` + strict mode**, central admin can disable yolo organization-wide. Out of scope for Squad's single-user posture, but the pattern of "a higher-priority policy tier that can't be overridden locally" is portable to "site-wide config Cid wants on every box."
- **Conseca pattern (`packages/core/src/safety/conseca/`)**, pause to note this is a Gemini-only feature in current shape (calls a hosted Flash model for policy generation), but the structural idea, "before this prompt's tool use begins, generate a least-privilege policy specific to this prompt", is the right next step beyond static permission patterns. A local-model version using Ollama is plausible for Squad post-subagents.
- **`HookType.Runtime` (`packages/core/src/hooks/types.ts:81-91`)**, in-process JS hooks that share runtime, vs. command hooks that shell out. Squad's hooks are currently command-only per `SQUAD_CODE_FEATURES.md`. Runtime hooks let extensions register handlers without a fork/exec per fire.
- **`packages/core/src/output/stream-json-formatter.ts`**, newline-delimited JSON events on stdout. Squad's backlog has "JSON and stream-JSON output formats" listed under not-shipped. This is roughly the schema to copy (event-typed JSONL on stdout, one event per line).

## What Squad Code already does better

- **Local-first by default.** Squad's catalog includes `llm-local` adapter kind with SSRF guard, explicit `OLLAMA_ALLOW_REMOTE=1` gate, and HTTPS-required for cloud providers (`SQUAD_CODE_FEATURES.md` "Security Posture"). Gemini-CLI's whole routing/availability/fallback subsystem assumes a hosted Gemini stack with quota/capacity tracking. Squad routes against a catalog, not a vendor.
- **No telemetry, period.** Gemini's release confidence Level 3 is literally "go to `go/gemini-cli-dash`." Squad's local-first rule (per CLAUDE.md and the 2026-05-08 batch) makes that a non-feature. The equivalent, local JSONL transcripts, SQLite audit chain, `squad usage` for cross-session cost, is already shipped and doesn't require dashboards.
- **Audit chain is tamper-evident.** Squad's SQLite audit DB uses `prev_hash` chain links validated in the session store (`SQUAD_CODE_FEATURES.md` "Audit And Logging"). Gemini-CLI tracks events but doesn't chain-hash them; replay relies on dashboard cross-reference.
- **JSONL session transcripts with fsync per turn.** Append-only with assistant message sidecars (`SQUAD_CODE_FEATURES.md` "Sessions And Persistence"). Squad already has the durable-timeline shape the 2026-05-08 batch identified.
- **YOLO with checklist gate.** Squad's `--yolo` requires a `checklist.txt` / `CHECKLIST.md` in cwd, sandboxes shell to cwd, rewrites deletes to archive moves under `.archive/<timestamp>/` (`SQUAD_CODE_FEATURES.md` "YOLO Mode"). Gemini-CLI's yolo mode is a policy override, admin can globally disable it via "strict mode" but the local form has no required checklist artifact. Squad's design is safer for solo unattended use.
- **Provider-neutral catalog.** Squad's `src/providers/default-models.json` + `~/.squad/models.json` overrides + per-provider environment variables for base URLs are exactly what gemini-cli's routing subsystem is trying to recover from underneath a Gemini-only assumption. Squad already won this fight.
- **Permission system has session+project persistence with broadening rules.** Shell grants use arity-prefixed prefixes, path-tool grants use parent-directory globs, repo-root literal scope (`SQUAD_CODE_FEATURES.md` "Permissions"). Gemini's policy engine has the TOML priority bands but per-tool persistence reads as more ad-hoc. Squad's specificity-sorted matcher is tighter.
- **Single-user simplicity.** Gemini-CLI ships A2A server + SDK + VS Code companion + ACP mode + IDE companion lifecycle + Management Console. Squad ships `squad` + `squadcode` binaries. The 2026-05-08 batch was right: borrow harness patterns, not the ecosystem.

## Anti-patterns / things to avoid (refresh)

- **Don't add A2A.** Remote subagents over HTTP push toward a hosted-agent posture that conflicts with local-first. The auth-provider factory alone (`packages/core/src/agents/auth-provider/{api-key,oauth2,google-credentials,http}-provider.ts`) is enterprise plumbing Squad doesn't need. The 2026-05-08 anti-pattern list already named this; current state reinforces it.
- **Don't replicate the model-availability subsystem.** `availability/modelAvailabilityService.ts` tracks `quota` / `capacity` / `retry_once_per_turn` states across a session. That's because Gemini-the-product has tiered quota with sticky retry semantics. Squad's local-first catalog has no equivalent dimension. A simpler `try → catch network error → user picks alternative` flow is correct.
- **Don't adopt Conseca-as-shipped.** It generates the per-prompt policy via a Gemini Flash call. For Squad, the right structural idea is "scope policy to the current task," but the runtime should be local, either a deterministic generator or a small local model. Don't import an LLM-mediated policy generator that bakes in a hosted vendor.
- **Don't reach for ACP yet.** Agent Client Protocol is a real cross-vendor standard, but adopting it imports an external schema and binds Squad to its evolution. Until an IDE actually wants to consume Squad, JSONL on stdout (stream-JSON formatter) is the cheaper interop layer.
- **Don't build admin/management-console scaffolding.** The enterprise-controls model assumes a fleet of users with central policy override. Squad is single-user. Site-wide config can live in `~/.squad/settings.json` precedence, no remote management plane needed.
- **Don't import the context-graph wholesale.** The pipeline + processors + graph mapper add maybe ~3K LOC and tie tightly into Gemini's `Part` type. Squad's auto-compact module is fine for its scope. The pattern to borrow is `node.replacesId` and `node.abstractsIds` tracking, provenance metadata, not the whole pipeline.
- **Don't add Gemma-classifier-style local model routing yet.** The local-LiteRT-LM classifier path is interesting, but routing decisions across local + cloud catalogs need provider diversity and usage history Squad doesn't yet have. The 2026-05-08 batch correctly flagged `--model auto` as "later"; that's still right.

## Concrete backlog inserts for Squad Code

Only items new since the 2026-05-08 batch's nine inserts. Numbered from 10 to continue that list.

10. **Add `BeforeModel` / `AfterModel` / `PreCompress` hook events.** Squad's `HookRunner` already supports `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`. Add model-wrap and pre-compact events. `BeforeModel` returning a synthetic response is a clean cancel-shortcut. `PreCompress` lets users veto or replace the compaction summary.
11. **Add `Runtime` hook type alongside command hooks.** Let extensions/skills register in-process handlers via the existing hook configuration shape, not just shell commands. Removes the fork/exec round-trip per hook fire.
12. **Add `ask_user` tool.** A model-callable tool that pauses the agent loop and surfaces structured questions (choice / yesno / text) to the user. Cleaner than encoding clarifications in assistant text, answers flow back via the same audit chain as other tool results.
13. **Add `enter_plan_mode` / `exit_plan_mode` as model-callable transitions.** Squad already has explicit permission modes; making the model able to *request* a transition is a small surface but changes the loop dynamics significantly. Plan mode allows reads + plan-file writes only.
14. **Add background-shell tools (`list_background_processes`, `kill_background_process`, `read_background_output`).** Required once Squad's subagent layer runs real test suites or watchers. The Gemini implementation (`packages/core/src/tools/shellBackgroundTools.ts:27-60`) is small enough to fork as a starting point.
15. **Add `tailToolCallRequest` to the tool result protocol.** Let a completed tool request the scheduler run another tool immediately (e.g., `write_file` → `format`). Skips a model round-trip for known sequences and stays within the existing scheduler state machine.
16. **Add per-adapter-kind tool schema snapshot tests.** Mirror `packages/core/src/tools/definitions/coreToolsModelSnapshots.test.ts`. For each Squad adapter kind (`llm-chat`, `llm-message`, `llm-response`, `llm-local`), snapshot the JSON schema each core tool emits. Catches schema drift when a provider's expected shape changes.
17. **Add `replacesId` / `abstractsIds` provenance to auto-compact.** When `/compact` rewrites history, keep a sidecar mapping `summary_node_id → [original_message_ids...]`. Doesn't change the runtime shape, it's metadata that makes `/restore` after compaction feasible.
18. **Add `SerializableConfirmationDetails`-shaped data payloads to permission prompts.** Squad's permission prompt currently couples request and UI. A serializable details union (`type: 'edit' | 'exec' | 'mcp' | 'ask_user' | ...` + fields) decouples them and is the natural carrier for the source-agent metadata the 2026-05-08 batch flagged as needed for subagents.
19. **Ship a `skill-creator` built-in skill.** A skill that teaches the model how to write skills against Squad's loader. Small lift, big multiplier on user skill authoring. Gemini's version is at `packages/core/src/skills/builtin/skill-creator/SKILL.md`.
20. **Add stream-JSON output format (newline-delimited).** Already in Squad's "not shipped" list. Gemini's `packages/core/src/output/stream-json-formatter.ts:18-34` is roughly the schema to copy: one event per line, typed `JsonStreamEvent` matching the agent event stream. Required before any external orchestrator (CI, editor extension) drives Squad.

## Bottom line

The biggest diff is the context-graph pipeline (`packages/core/src/context/`), a real engineering answer to "how do you do lossy summarization while still allowing audit and restore," and a pattern Squad's auto-compact will need to grow into. The runner-up is the maturation of subagents into a full surface (own scheduler, auth-provider factory, browser sub-agent, A2A remote agents, auto-memory extraction agent with narrow write scope), confirming the 2026-05-08 batch's read that subagents are the unlock and Squad should keep its depth=1 / 4-slot ceiling conservative. The agent-CLI space is clearly heading toward IDE-grade with three coexisting consumption surfaces (TUI + ACP + SDK); Squad's right move is to stay terminal-only and provider-neutral, but ship stream-JSON output and the model-wrap hooks so external orchestrators can drive it when that moment comes.
