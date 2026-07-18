# DeepSeek-TUI: analysis

## What this codebase is

DeepSeek-TUI (`Hmbown/DeepSeek-TUI`, v0.8.20) is a Rust terminal coding agent built around DeepSeek V4 with a 1M-token window, ratatui frontend, and an OpenAI-compatible streaming client. **It is a Codex fork in lineage and shape**, confirmed by the Takeover prompt explicitly referencing `/Volumes/VIXinSSD/codex-main` as the parity benchmark, the ACP server, the layered ruleset model, the `apply_patch` envelope, sub-agent topology, and the `execpolicy` crate name (Codex's term). The crate split is recent and largely structural: the legacy monolith still lives under `crates/tui/src/`, while `crates/{agent,core,protocol,state,tools,...}` are extraction targets that the workspace progressively pulls source into. About 17K LOC sits in the parts most relevant to Squad Code; the full TUI is much bigger but most of it is ratatui chrome.

What makes it interesting for Squad Code: sub-agent runtime with depth caps, mailbox abstraction, fork-context, and resident leases; an honest compaction implementation that pins working-set paths and enforces tool-call/tool-result pairing across pin decisions; a tiny but excellent loop guard for repeated tool calls; deterministic JSON arg-repair ladder; arity-aware shell allowlist matching; layered execpolicy rulesets; and the `subagent_output_format.md` contract that converges sub-agents on a fixed report shape.

## Crate map

- **agent**, `ModelRegistry` with provider×model catalog, alias resolution, fallback chain. Tiny (one file).
- **app-server**, Axum HTTP + JSON-RPC stdio server exposing `thread/*`, `app/*`, `prompt/*` methods. Wraps `Runtime`. Headless / ACP.
- **cli**, Dispatcher binary (`deepseek`), entry point that delegates to TUI for interactive use.
- **config**, Config crate (2.2K LOC). `~/.deepseek/config.toml`, profiles, providers, runtime overrides, validation.
- **core**, Headless agent runtime. `Runtime`, `ThreadManager`, `JobManager`. `invoke_tool` here gates everything through `ExecPolicyEngine` + emits `HookEvent`s. Persistent `JobRecord` with retry metadata, history ring, and resume-pending semantics.
- **execpolicy**, Allow/deny rulesets with priority layers (`BuiltinDefault < Agent < User`), arity-aware allow matching, deny-always-wins, session-approval cache.
- **hooks**, `HookEvent` taxonomy + `HookSink` trait with `Stdout`, `Jsonl`, and `Webhook` (with retry+backoff) implementations. Composable `HookDispatcher`.
- **mcp**, MCP manager with startup orchestration and per-server status reporting.
- **protocol**, Wire types: `EventFrame`, `ThreadRequest`/`Response`, `AppRequest`/`Response`, `ToolPayload`, `ReviewDecision`, `NetworkPolicyAmendment`. Pure types, no behavior.
- **secrets**, Credential storage (keyring + env + file fallback chain).
- **state**, SQLite-backed `StateStore`. Threads, messages, dynamic tools (per-thread tool overrides), checkpoints (state JSON keyed by `thread_id`+`checkpoint_id`), jobs. Append-only `session_index.jsonl` mirror.
- **tools**, Generic tool trait, `ToolRegistry::dispatch` with timeout + parallel-execution gating, payload-kind matching, `FunctionCallError` taxonomy. Helpers (`required_str`, `optional_u64`, etc.) for argument shape errors that name the keys actually provided.
- **tui**, The monolith. Engine, compaction, sub-agents, RLM, LSP, prompts, ratatui UI, ~50 tools.
- **tui-core**, Empty leaf placeholder for future extraction.

## Cherry-pick candidates

### 1. Loop guard: repeated identical tool call detection

**Where:** `crates/tui/src/core/engine/loop_guard.rs:1-222`

**What:** A 100-LOC pure-data guard that hashes `(tool_name, canonical_json_args)` per turn and blocks the third identical call with a clear "stop retrying it unchanged" message back to the model. Independent failure counter warns at 3 consecutive failures, halts at 8. Canonical JSON sort means `{a:1,b:2}` and `{b:2,a:1}` collapse to the same key. Paginated reads (different `offset`) don't false-positive. Tested, see lines 113-222.

**Fit:** lift-as-is. Squad Code's vetting purpose makes this a free win, a misbehaving local model that loops on the same `read_file(path)` call burns turns and tokens. Port directly to TS, drop the Rust hashing for `JSON.stringify` with sorted keys.

### 2. Deterministic tool-arg JSON repair ladder

**Where:** `crates/tui/src/tools/arg_repair.rs:1-270`

**What:** Five-stage repair for malformed `tool_calls.function.arguments`: strict parse → strip in-string control chars → strip trailing commas → balance braces → strip excess closers → fall back to `{}`. Specifically targets two failure shapes the comments call out: SSE chunk boundaries cutting inside JSON strings, and local backends emitting raw control chars inside JSON values. 1MB cap so a catastrophic input can't loop forever.

**Fit:** lift-as-is. This is **directly aligned** with Squad Code's vetting purpose, local Ollama models emit malformed tool arguments constantly, and the squad logs already document this. Port the ladder to TS (the logic is straight string manipulation). High value, low effort.

### 3. Compaction with working-set path pinning + tool-call/result pair enforcement

**Where:** `crates/tui/src/compaction.rs:387-544` (`plan_compaction` + `enforce_tool_call_pairs`)

**What:** Compaction picks pinned messages by extracting repo-relative paths from the recent N messages and pinning every message that mentions a working-set path, plus error/patch markers. Then runs a fixpoint loop that ensures any pinned `ToolUse` keeps its matching `ToolResult` (and vice versa), orphaned halves get unpinned. Permanently-removed set prevents oscillation. Prefix-cache awareness is explicit (compaction breaks the cache, so floor at 500K tokens by default). The auto-compact knob is OFF by default at the engine level (#665), they intentionally trust V4's 1M window.

**Fit:** adapt-shape. Squad Code is smaller-context (Ollama models ~32-128K), so the floor and 80% threshold need recalibration. But the **algorithm shape**, working-set path extraction, pin decisions on path mentions, tool-pair enforcement fixpoint, is exactly what Squad Code needs once sessions get long. The pair-enforcement loop in particular is non-obvious and worth lifting verbatim. Strip the V4 prefix-cache reasoning since it doesn't apply locally.

### 4. Sub-agent runtime: depth-cap, fork-context, mailbox, resident leases

**Where:** `crates/tui/src/tools/subagent/mod.rs:553-787` (`SubAgentRuntime`, depth/cancel/fork plumbing), `crates/tui/src/tools/subagent/mailbox.rs:1-200` (`MailboxMessage`, `Mailbox`)

**What:** A stack of design choices Squad Code's Phase 6+ subagent layer is converging on:
- **Depth cap** (`DEFAULT_MAX_SPAWN_DEPTH=3`, configurable). Children inherit `spawn_depth+1`; spawn rejected if it would exceed. Squad Code wants depth=1, but the mechanism is identical.
- **Cooperative cancel via `CancellationToken::child_token()`**, cancelling root cascades down. Critical for the kill-switch.
- **`fork_context: bool`**, opt-in seeding of child with parent's system prompt + leading messages, byte-identical for prefix cache. For Squad Code this matters less (no prefix cache locally) but the API shape is right.
- **Resident leases on files** (`RESIDENT_LEASES`, `crates/tui/src/tools/subagent/mod.rs:45-57`), global ownership table, agent holds lease while running. Prevents two agents fighting over the same file. Squad Code's 4-slot design needs this.
- **Mailbox**, fanout-able structured progress envelope (`Started`/`Progress`/`ToolCallStarted`/`Completed`/`Failed`/`TokenUsage`) with monotonic seq numbers and close-as-cancel semantics. The "anguish-as-observability" shape from Mister Fetch maps to this almost 1:1.
- **`from_prior_session` flag**, distinguish agents loaded from disk vs spawned this boot via a `current_session_boot_id` (a UUID per manager construction). Lets `agent_list` filter historical noise.

**Fit:** adapt-shape. This is the **most directly relevant subsystem in the entire codebase** for Squad Code's Phase 6+ work. Port the depth-cap + child token + mailbox shape directly. Skip resident leases for v1 (Squad Code's 4-slot cap and per-task assignment makes contention unlikely). Skip `fork_context` (no prefix cache to win). Keep the `from_prior_session` boot-id pattern, useful for any persisted state.

### 5. Sub-agent output contract (`subagent_output_format.md`)

**Where:** `crates/tui/src/prompts/subagent_output_format.md:1-81`

**What:** A short prompt fragment that forces every sub-agent's final assistant message into a structured report: `### SUMMARY` (one paragraph, plain prose) → `### EVIDENCE` (concrete artifacts with `path:line` citations) → `### CHANGES` (every write performed) → `### RISKS` → `### BLOCKERS`. Stop condition: produce the report and stop, do not propose follow-up work. Honesty rules: don't claim writes you didn't make; the parent audits the tool log against CHANGES.

**Fit:** lift-as-is. Plain prompt text. Squad Code can drop this into the subagent system prompt for any spawned worker, gives the parent a deterministic surface to merge results from, and the EVIDENCE+CHANGES sections are exactly what the vetting harness wants to log. Worth it just for the audit clause.

### 6. Layered execpolicy with arity-aware allow matching

**Where:** `crates/execpolicy/src/lib.rs:11-294`, `crates/tui/src/command_safety.rs:30-120` (`COMMAND_ARITY` dictionary)

**What:** Three priority layers (`BuiltinDefault < Agent < User`), deny-always-wins regardless of layer. Allow rules use an **arity dictionary** ported from opencode, `auto_allow = ["git status"]` matches `git status -s` and `git status --porcelain` but not `git push`, because `git status` is encoded as arity-2 (base+one-positional, flags don't count). The dict has ~150 prefixes for git/npm/yarn/pnpm/cargo/etc. Combines with session-approval cache for "approve once, reuse for the session."

**Fit:** adapt-shape. Squad Code's local-first posture means the YOLO/Plan/Agent split and approval gating are less load-bearing, but the **arity dict** is genuinely good prior art. If Squad Code ever adds a shell tool with allow-prefix gating (current shape doesn't, but it's a natural feature), reach for this. Lift the dictionary directly; reimplement matcher in TS.

### 7. Per-call approval cache with fingerprint keys

**Where:** `crates/tui/src/tools/approval_cache.rs:1-100`

**What:** Cache approvals keyed by **call fingerprint**, not tool name. `apply_patch` keys on hash of file paths; `exec_shell` keys on first-3-token command prefix; `fetch_url` keys on hostname; everything else falls back to tool name. Per-entry `approved_for_session` flag distinguishes one-shot grants from sticky session approvals. The whole point: an approved `exec_shell "cat foo"` MUST NOT silently pass `exec_shell "rm -rf /"`.

**Fit:** inspiration-only. Squad Code probably doesn't need the cache layer yet given its scope, but the fingerprint scheme is the right answer if/when it adds approval gating. The fingerprint-by-tool-shape pattern is worth remembering.

### 8. Hook event taxonomy + sinks

**Where:** `crates/hooks/src/lib.rs:1-170`

**What:** `HookEvent` enum with `ResponseStart`/`Delta`/`End`, `ToolLifecycle{phase}`, `JobLifecycle`, `ApprovalLifecycle`, `GenericEventFrame{frame: EventFrame}`. `HookSink` trait with three implementations, `Stdout`, `Jsonl` (with directory-create + atomic append), `Webhook` (with 200ms*n exponential retry). Composable `HookDispatcher` aggregates sinks. Errors swallowed so a failing sink doesn't abort the agent loop.

**Fit:** adapt-shape. Squad Code already has structured logging but the **`HookSink` trait + `JsonlHookSink`** is a clean way to add `.squad/events.jsonl` for vetting-run replay. The `ToolLifecycle{phase}` is more useful than Squad Code's current event shape, phases like `precheck`/`dispatching`/`completed`/`failed` per tool give a deterministic surface for downstream analysis. Skip the webhook sink; the JSONL one is the win.

### 9. Schema sanitizer for strict tool mode

**Where:** `crates/tui/src/tools/schema_sanitize.rs:1-100`

**What:** Pre-flight pass over JSON Schemas that fixes patterns that break DeepSeek's strict tool mode (and other strict OpenAI-compat endpoints): collapses Pydantic-style `anyOf:[X, {type:"null"}]` → `X` with `nullable: true`; injects `properties: {}` on bare-object schemas; prunes `required` entries that don't appear in `properties`; collapses single-element `oneOf`/`allOf`. Output cached, paid once per registration. `prepare_tools_for_strict_mode` is conservative: returns false if any tool uses root-level `oneOf`/`anyOf`/`allOf`, leaves all tools non-strict in that case.

**Fit:** adapt-shape. Squad Code's catalog supports OpenAI-compat strict mode (and Ollama which is permissive, and Anthropic which has its own conventions). The class of bugs this prevents, `anyOf` unions, missing `properties`, dangling `required`, affects Squad Code too, especially for MCP tool schemas. Port the four normalizations as standalone JS functions; skip the strict-mode all-or-nothing wrapper unless Squad Code adopts strict tool calls.

### 10. Error taxonomy + envelope

**Where:** `crates/tui/src/error_taxonomy.rs:1-120`, `crates/tui/src/llm_client/mod.rs:84-273` (`LlmError`)

**What:** Two-layer error model. `LlmError` classifies HTTP failures into `RateLimited{retry_after}`/`ServerError`/`NetworkError`/`Timeout`/`AuthenticationError`/`InvalidRequest`/`ModelError`/`ContentPolicyError`/`ParseError`/`ContextLengthError`/`Other`, with `is_retryable()` and `from_http_response(status, body)` heuristics that read body keywords (`context_length`, `content_policy`, `safety`) to disambiguate 400s. `ErrorEnvelope` then wraps that with `category`/`severity`/`recoverable`/`code`/`message` for UI and logs.

**Fit:** adapt-shape. Squad Code's provider adapters need this exact classification. Whether to lift `ErrorEnvelope` depends on how much downstream UX wants severity + recoverable flags, for a CLI vetting harness, just `LlmError` with `is_retryable` and the body-keyword heuristics is probably enough. The 400-disambiguation by body keywords is the gem here; a generic `InvalidRequest` is uselessly broad.

### 11. JobManager: durable retry/backoff/history with bounded ring buffer

**Where:** `crates/core/src/lib.rs:118-380`

**What:** `JobRecord` carries `JobRetryMetadata` (attempt, max_attempts, backoff_base_ms, next_backoff_ms, next_retry_at) and a bounded `Vec<JobHistoryEntry>` capped at 64 with FIFO drain. `fail()` increments attempt, computes deterministic exponential backoff (`base << (attempt-1)`, clamped at 1<<20), schedules retry-at. `resume_pending()` re-queues `Queued|Running` jobs after restart. Persisted as JSON in the SQLite `jobs` table, schema_version 1, encoded via `encode_persisted_detail`. Survives crashes.

**Fit:** inspiration-only. Squad Code doesn't have a durable task queue and probably shouldn't grow one yet, but if/when it does (Phase N+, batch vetting runs across many models), the JobRecord+history+backoff shape is solid prior art. The deterministic-backoff function (`1u64.checked_shl(exponent).unwrap_or(u64::MAX)`) handles the overflow case correctly, which is annoying to get right.

### 12. ModelRegistry with provider×model catalog and alias map

**Where:** `crates/agent/src/lib.rs:1-313`

**What:** Single `ModelInfo` table with `(id, provider, aliases, supports_tools, supports_reasoning)`. `resolve(requested, provider_hint)` runs an explicit fallback chain: provider-specific lookup → alias map → provider default → global default. Preserves user casing for third-party providers (`DeepSeek-V4-Pro` → that exact id back), Ollama short-circuits (`requested` becomes `id` literal because Ollama's tag space is open). `fallback_chain` is returned to the caller so failures are debuggable.

**Fit:** adapt-shape. Squad Code already has v1.1 multi-provider via a kind-dispatched catalog, the model-and-alias resolution shape here is similar in intent but more explicit about *why* a fallback fired. The `fallback_chain: Vec<String>` field is the win: when "model didn't exist, fell back to provider default, fell back to global default" happens, the user sees that lineage. Worth adding to Squad Code's catalog resolution path.

### 13. Auto-reasoning select: toy-but-honest heuristic

**Where:** `crates/tui/src/auto_reasoning.rs:1-71`

**What:** 33 lines of pure logic: subagents → Low; user message contains `"debug"`/`"error"` → Max; contains `"search"`/`"lookup"` → Low; default High. That's it. The README's auto-mode spiel about "a small flash router call to pick model + thinking" is real elsewhere, but this fallback heuristic is what runs when the router call fails or returns garbage.

**Fit:** inspiration-only. Squad Code is intentionally smaller-scope; per-turn reasoning-effort routing isn't a current goal. But the **shape**, a deterministic local heuristic as the failure fallback for an LLM-driven router, is exactly Cid's "deterministic code with LLM as escalation layer" thesis. If Squad Code ever adds per-turn settings, this is the floor: keyword heuristic always works, LLM router is a nice-to-have on top.

### 14. Skills discovery (multi-source, Claude-compatible)

**Where:** `crates/tui/src/skills/mod.rs:1-100`, `crates/tui/src/skills/install.rs`

**What:** `SKILL.md`-with-frontmatter convention (`name`, `description`, body). Discovery walks workspace dirs (`.agents/skills` → `skills` → `.opencode/skills` → `.claude/skills` → `.cursor/skills`) and home dirs (`~/.agents/skills` → `~/.claude/skills` → `~/.deepseek/skills`). Recursive walk with depth cap (8) and hidden-dir skip. `load_skill` tool lets the model auto-select skills based on description. Installable from GitHub (`/skill install github:owner/repo`) with checksum and size caps, no backend service.

**Fit:** skip-for-Squad. Cid already runs ~22 skills via Claude's first-class skill system, Squad Code shouldn't reinvent skill loading. The cross-tool compatibility (looking at `~/.claude/skills`) is a nice gesture but Squad Code's job is to vet local models, not be a daily-driver coding agent that needs its own skill ecosystem.

### 15. JSON-RPC stdio transport for headless agent control

**Where:** `crates/app-server/src/lib.rs:113-686`

**What:** `run_stdio` reads JSON-RPC 2.0 lines off stdin, dispatches `thread/*`/`app/*`/`prompt/*` methods (~25 of them), writes responses to stdout. Same backing `Runtime` as the HTTP path (`run`). Includes proper JSON-RPC error codes (-32700/-32600/-32601/-32602/-32603) and a `shutdown` method. ACP's stdio agent server (used by Zed) is built on top of this.

**Fit:** inspiration-only. Squad Code as a vetting harness probably doesn't need a JSON-RPC remote-control surface (you run it locally, you read the output). But if Cid ever wants to script `squad-code` from another tool, say feeding eval batches in from a Python harness, this is the cleanest interop shape. Cheap to add later.

## What I'm deliberately not flagging

- **The whole TUI rendering layer (`crates/tui/src/tui/*`)**, ratatui, mouse capture, OSC 8 hyperlinks, pasted-image handling, command palette. Squad Code's REPL is intentionally simpler; lifting any of this would be reinventing.
- **`StateStore` (SQLite threads/messages/checkpoints)**, Squad Code's session shape is much smaller; SQLite is overkill for the v1 vetting harness. The schema is well-designed but it's the wrong scale.
- **MCP integration (`crates/mcp`, `crates/tui/src/mcp.rs`)**, MCP is a real feature but Squad Code's local-first thesis means the value of MCP servers is lower than for a cloud-driven agent. Add if Cid actually wants a specific MCP server, not preemptively.
- **LSP subsystem (`crates/tui/src/lsp/*`)**, post-edit rust-analyzer/pyright diagnostics. Useful but heavy; Squad Code's vetting purpose doesn't need real-time IDE-grade feedback.
- **The whale nicknaming (`WHALE_NICKNAMES`, `whale_nickname_for_index`)**, cute, but pure UI flavor.
- **Capacity controller (`crates/tui/src/core/capacity.rs`, 800 LOC)**, they themselves disabled it by default in v0.8.11 because it "silently rewrites the session log and surprises the user." Comment in the file is honest about it. Skip.
- **Workspace rollback (side-git pre/post-turn snapshots)**, Squad Code is local-first vetting; the user can `git stash` themselves. Saving git snapshots in a parallel `.deepseek/snapshots` repo is a feature, not an architectural insight worth lifting.
- **Internationalization (`crates/tui/src/localization.rs`)**, DeepSeek-TUI cares about zh-Hans because it's a Chinese-market tool. Squad Code doesn't need this.
- **Auto-mode router (the small flash routing call)**, DeepSeek-Pro vs Flash routing is a DeepSeek-pricing-specific feature. Squad Code's model selection is per-task and explicit; auto-routing per turn would obscure the vetting signal.
- **`rlm_process` Python REPL with sub-LLM helpers**, interesting design (load big input as `PROMPT`, sub-agent writes Python that calls `llm_query_batched` inside a sandbox), but it's a Python sandbox plus a sub-LLM client coordinator, and Squad Code's 4-slot subagent layer covers most of the same ground without the Python sidecar. Lots of moving parts for a feature Squad Code doesn't need at its scope.
- **Prefix cache plumbing (`CacheControl`, prefix-cache cost reporting in pricing.rs)**, DeepSeek-specific economics. Squad Code's caching audit memory already notes this gap and the conclusion is Anthropic's `cache_control` is the next item, not generic prefix-cache simulation.
- **`large_output_router.rs`**, auto-routes >4096-token tool outputs through a flash synthesis sub-agent. Clever but assumes a cheap fast model is always available; for local Ollama this would just add a slow round-trip.

## Open questions

- **How does the engine actually wire `LoopGuard` into the turn loop?** I read the guard module and saw it instantiated in `turn_loop.rs:32`, but the exact emission path back to the model on `Block(_)` would be worth a short trace before porting, the hand-back-as-tool-result-error vs hand-back-as-system-message decision shapes the Squad Code port.
- **Does the mailbox actually fan out to UI cards yet?** Comments say "wired by #128 (in-transcript cards) when it lands", so the design is fully in place but only the producer side is exercised. For Squad Code adoption, the consumer side is what matters most.
- **What's the actual sub-agent → parent transcript injection format?** The `<deepseek:subagent.done>` sentinel is mentioned in `prompts/base.md` and the `SubAgentCompletion::payload` carries it, but the exact textual envelope the parent sees would matter if Squad Code wants compatible output.
- **Compaction summary prompt quality**, the compaction module spends a lot of effort planning *what* to summarize but the actual summarization request goes to the LLM. If Squad Code lifts this, the prompt needs review (and Squad's local models will write much worse summaries than DeepSeek V4).
- **`ExecPolicyEngine::resolve_prefixes` performance**, it allocates a fresh `Vec<String>` per check call by extending across all rulesets. Probably fine at small rule counts but if Squad Code ever uses this at scale, that allocation is worth noting.
