# Why: Rip-apart batch, 2026-05-20

_aider + cline + codex + gemini-cli (refresh) + nanocoder + opencode. Squad Code v1.2/v1.3 planning input. Companion to the 2026-05-08 batch (DeepSeek-TUI + gemini-cli initial)._

The agent-CLI space is consolidating. Several of the closed-vendor offerings (Claude Code, Codex on the OpenAI account path, Cursor's agent surface) are pulling back from open-source posture; the ones that remain open are either community projects with clear local-first thesis (aider, nanocoder), official-but-still-open from a major vendor (codex, gemini-cli, cline), or community alternatives with bigger ambitions than Squad's charter allows (opencode). This pass is to snag the ideas worth folding into Squad before more of them disappear behind release walls.

Each of the six target projects has a dedicated deep-dive under `docs/rips/<name>.md`. This document is the index, per-project framing, then cross-cutting steals/avoid/backlog/bottom-line. Read the per-project files for file:line anchors and full reasoning.

## What was in the batch

- **aider** (`docs/rips/aider.md`), Python 3.10+, prompt_toolkit REPL, litellm-backed provider abstraction, SEARCH/REPLACE edit format. The OG terminal pair-programmer with roughly six years of LLM-edit-failure scars baked into the codebase. Signature feature is the tree-sitter + pagerank repo map. Architecturally dated (god-class `Coder` + 14 subclasses, auto-commit-everything default) but the failure-mode catalogue is unmatched.

- **cline** (`docs/rips/cline.md`), TypeScript, VS Code-first with a standalone gRPC runtime, ~40 hand-written provider files, MCP-heavy. The product surface is huge: scheduled agents, Slack/Telegram/Discord connectors, Puppeteer browser tool, shadow-git checkpoint store, JetBrains plugin, Kanban web UI for parallel agents. Most of it fights Squad's local-first charter; the two clean steals are the plan/act mode split and the granular auto-approve matrix.

- **codex** (`docs/rips/codex.md`), OpenAI's official, Rust core (120-crate Cargo workspace), TS shim that downloads platform-native binaries, Responses-API-only wire, ChatGPT-account-default auth. The genuinely portable contribution is the sandbox stack, Seatbelt + bwrap + Landlock + Windows restricted-token with a `WritableRoot { read_only_subpaths, protected_metadata_names }` policy shape that protects `.git/hooks` from a writable cwd. The V4A patch format is the second-best idea; everything else is vendor-shaped (Bazel + Nix + Cargo build, opt-in-by-default telemetry, cloud-tasks UI inside the CLI).

- **gemini-cli refresh** (`docs/rips/gemini-cli.md`), same Google monorepo as the 2026-05-08 analysis, but the interior reshaped significantly. The headline addition is a graph-based context-management pipeline (`packages/core/src/context/`), a "Nodes of Theseus" model tracking `replacesId` / `abstractsIds` for every compression substitution, which is the most serious answer to lossy-summarization in the agent-CLI space. Subagents fully matured (own scheduler, A2A remote-agent auth provider, browser sub-agent, `skill-extraction-agent` doing background memory mining with narrow scoped write access). Hooks gained `BeforeModel` / `AfterModel` / `PreCompress`. Stream-JSON output formatter shipped. The product is now three coexisting surfaces (TUI + ACP + SDK).

- **nanocoder** (`docs/rips/nanocoder.md`), TS/Node 22+, pnpm workspace, Ink REPL, Vercel AI SDK v6 as the provider substrate. The closest peer to Squad on the local-first axis and the most useful target in the pile for direct feature comparison. Signature contribution is markdown custom tools, a complete user-facing extension contract using `.md` files with YAML frontmatter and Mustache-templated shell bodies, with shell-quoted parameter substitution as the load-bearing safety property. Has MCP, LSP, VS Code companion, OAuth providers, scheduler, checkpoints, notifications. Lacks tamper-evident audit, YOLO checklist gate, SSRF guard, areas where Squad genuinely wins against the closest peer.

- **opencode** (`docs/rips/opencode.md`), TS/Bun monorepo, Effect-typed, daemon-with-many-clients architecture. Not a Go-TUI/TS-server split as commonly assumed (no Go in the tree); the "TUI" is OpenTUI/SolidJS in-process. Multi-language SDK generation from a server-side OpenAPI spec, Cloudflare/SST cloud story for share URLs, plugin hook surface with `chat.params` and `tool.definition` cut points. The genuinely portable kernels are markdown-frontmatter agent definitions, side-snapshot revert via per-project git store, and LSP diagnostics injection.

## Strong steals (cross-cutting, prioritized)

**Markdown-frontmatter extension contracts.** Three projects (nanocoder, opencode, gemini-cli's skill-creator) converge on the same shape: `.md` file with YAML frontmatter + body, loaded from `<project>/.<tool>/<kind>/` and `<home>/.<tool>/<kind>/`, project shadows user shadows built-in. Nanocoder applies it to custom *tools* (frontmatter declares JSON-Schema-ish params + approval + read_only + timeout + shell, body is a Mustache-templated shell script with shell-quoted substitutions). Opencode applies it to *agents* (frontmatter declares model + permissions + mode + steps, body is the system prompt). Squad already does this for skills and output-styles; the missing surface is agents (planned for v1.3) and user-defined tools (new, high-value steal). Adding both means Squad has a unified `~/.squad/{agents,tools,skills,output-styles,commands}/` extension model with one parser, one cascade, and one mental model.

**The repo map.** Aider's `repomap.py` is unique in the batch, nothing else has anything like it. Tree-sitter symbol extraction across the repo, networkx pagerank with personalization vector biased toward in-chat files and mentioned identifiers, binary-search the prefix length to fit a token budget, render only the lines-of-interest via tree-context. Solves a real Squad gap: today Squad has no repo-aware context layer beyond the optional `.crabmeat/index.json` manifest. Port to TS using `web-tree-sitter` with aider's `.scm` queries (MIT-licensed, bundle them); cache by mtime under `~/.squad/cache/repomap/<project-hash>/`.

**SEARCH/REPLACE edit format with named failure modes.** Aider's six-year accumulation of LLM-edit failure scars, uniform-leading-whitespace mismatch, ellipsis-split chunks, "REPLACE lines already in file" detection, `find_similar_lines` "did you mean these?" hint via SequenceMatcher. Squad's `Edit` tool currently surfaces flat "old_string not found" errors. Either improve `Edit`'s error messages to include the same diagnostics, or add a sibling `SearchReplace` tool that uses the format wholesale.

**Plan/act mode as a distinct agent or mode.** Cline does it as a session flag (`mode = "plan" | "act"`) with a strict gate on mutating tools at the executor level. Opencode does it as a distinct agent (`plan` agent with `edit: deny` everywhere except `.opencode/plans/*.md`). Gemini-cli does it as `enter_plan_mode` / `exit_plan_mode` model-callable tools. Pick one (the opencode shape is the cleanest because it composes with the agent-definition surface above) and ship it as a built-in `plan` agent in v1.2. Adds clear "explore before you write" UX with trivial implementation cost.

**Side-snapshot revert outside the user's `.git`.** Three projects (cline shadow-git, opencode `snapshot/index.ts`, codex via session checkpoints) all settled on the same answer: per-project git-as-storage in the agent's state dir, never touch the user's `.git`. Squad's YOLO archive-on-delete is a narrow slice of this. Opencode's implementation is the production-shipping reference. Insert as `revert_turn` with snapshots under `~/.squad/snapshots/<project-hash>/`; pair with a `/revert <turn-id>` slash command. Already named in the 2026-05-08 backlog, these refs reinforce it.

**Cross-platform sandbox primitives for shell.** Codex's `sandboxing/` is the gold standard: Seatbelt-policy-from-Chrome-renderer on macOS, bubblewrap+seccomp+Landlock on Linux, restricted-token+WFP on Windows. Squad can't ship native Landlock from Node, but it can shell out, detect `bwrap` / `firejail` on PATH and wrap `Shell` invocations with a generated argv; detect `/usr/bin/sandbox-exec` on macOS with a generated `.sbpl` profile. Don't try to match codex's depth; match its discipline. Minimum viable: in YOLO mode on Linux, wrap shell commands with `bwrap --ro-bind / / --bind <cwd> <cwd> --proc /proc --dev /dev --unshare-all <cmd>` and refuse if `bwrap` isn't installed.

**Graph-based context provenance.** Gemini-cli's context graph (`replacesId` / `abstractsIds` tracking on every compression substitution) is too heavy to port wholesale (~3K LOC, tied to Gemini's `Part` type), but the pattern is right. Squad's auto-compact currently drops history wholesale; adding provenance metadata to summary nodes (`summary_node_id → [original_message_ids...]`) makes `/restore` after a compact feasible and gives the audit chain something to anchor against.

**Granular auto-approve dials.** Cline's `autoApprovalSettings.actions` map: `readLocal / readExternal / editLocal / editExternal / shellSafe / shellAll / browser / mcp / web` as separate booleans. The shape fits inside Squad's existing pattern-based permission rules, no UI complexity needed, and unlocks "trust the agent to read anywhere in the workspace but always ask before reading `~/.aws/`" without flipping the whole jail.

**Background-process shell tools.** Gemini-cli ships `list_background_processes` / `kill_background_process` / `read_background_output`. Required once Squad's subagent layer runs real test suites or watchers. Nanocoder doesn't have this; it's a clean differentiator if Squad adds it during v1.2.

**`ask_user` as a structured tool.** Gemini-cli, codex, and nanocoder all expose this. Model-initiated structured questions (CHOICE / TEXT / YESNO / multi-select / "Other" fallback) routed through the existing permission/UI bus. Cleaner than encoding clarifying questions in assistant text, and answers flow through the same audit chain as other tool results.

**Benchmark harness with `help_hash` regression check.** Nanocoder's `benchmarks/measure.ts` uses module-count as the primary deterministic perf signal (wall-clock is included but labeled approximate, so CI doesn't trip on flaky timing) and sha256s `--help` output as a stability metric (`help_hash` drift fails the build, catching accidental flag removals). Cheapest possible CI regression gate. Pair with the `npm run deflake` script from the 2026-05-08 batch.

**Stream-JSON output format.** Gemini-cli's `stream-json-formatter.ts` plus codex's `exec --json` plus opencode's SSE pattern all converge on newline-delimited JSON with typed event names. Squad's "JSON and stream-JSON output formats" backlog item should match the gemini-cli schema (one event per line, typed `JsonStreamEvent` matching the agent event stream). Prerequisite for any external orchestrator (CI, editor extension, ACP bridge) driving Squad.

**AGENTS.md adoption alongside CLAUDE.md.** Codex made AGENTS.md canonical; opencode uses it; gemini-cli has migrated to it. Low-effort cross-tool compatibility play, Squad already loads CLAUDE.md, adding AGENTS.md as an additional recognized name with the same precedence rules means Squad users in a mixed-tool team aren't forced to choose.

**Model-aware tool routing.** Opencode dispatches `apply_patch` to GPT-5+ and `Edit/Write` to everything else, based on the empirical observation that GPT family handles V4A patches well and other model families do better with surgical edits. Squad currently exposes all edit tools to every model. A small model-to-tool-preference table in `default-models.json` would let DeepSeek/Anthropic see Edit/Write while GPT-5+ gets ApplyPatch.

**`BeforeModel` / `AfterModel` / `PreCompress` hook events.** Gemini-cli added these; codex has comparable `PreCompact`/`PostCompact` plus `PermissionRequest`. Squad's hooks fire around tool use and sessions; adding model-wrap and pre-compact events lets hooks transparently swap models, inject system context, or shortcut to a synthetic response. Required surface area for the deterministic-code-with-LLM-as-escalation-layer thesis.

## V1.2-relevant ideas

**Subagents as agent-definitions, not a separate concept.** Opencode's load-path treats primary agents and subagents identically, same markdown frontmatter parser, same permission ruleset, distinguished only by `mode: "subagent"`. The `task` tool reads the registry, filters for non-primary agents, and exposes them to the model as callable sub-tasks. Squad's planned subagent layer should follow this shape: a subagent is just an agent with `mode: "subagent"` and a tool whitelist. Adopting opencode's loader avoids the urge to grow a separate subagent runtime.

**Subagent lifecycle observability (model-side and TUI-side).** Cline's `SubagentProgressUpdate` shape `{ status, latestToolCall, stats: { toolCalls, inputTokens, outputTokens, cacheRead, cacheWrite, totalCost, contextUsagePct } }` is the parent-visible side; gemini-cli's background-shell tools are the model-visible side; codex's `SubagentStart` hook is the user-script side. Squad's planned `howl` lifecycle/anguish events should fold all three: the parent gets the final structured payload, the TUI gets `SubagentProgressUpdate`-shaped events, the model can call `task_status` mid-stream, hooks fire on subagent start/stop.

**Subagent verification through eval-shaped tests.** Gemini-cli's eval suite now has named evals for `subagents`, `subtask_delegation`, `generalist_delegation`, `model_steering`, `concurrency-safety`, `tool_output_masking`. Cline has its own `cline-bench` (12 real bug-fix tasks as a git submodule) plus pass@k metrics. Squad's offline harness should add: subagent scope-refusal, parent payload handling, kill cascade, anguish terminal state, "same task across multiple providers." The 2026-05-08 batch already named this; both projects' maturation makes the shape concrete.

**Source-agent metadata in every permission prompt.** Already named in the 2026-05-08 batch; cline's standalone-runtime work plus gemini-cli's expanded `MessageBus` types confirm the right answer is `SerializableConfirmationDetails`, a typed data payload (`type: 'edit' | 'exec' | 'mcp' | 'ask_user' | ...` + fields) decoupled from the UI surface. Squad's permission prompt currently couples request and UI; serializing the details lets subagent confirmations carry their source-agent metadata without copying the permission engine.

**External CLI subagent worktree isolation.** Codex's permission-profile-JSON-across-helper-process pattern is the right model. When Squad runs an external Codex/Claude CLI agent in `.squad/worktrees/<agent_id>/`, the scope-lock is serialized as JSON and the helper enforces it on the other side. Parent merges or rejects diffs explicitly. No shared in-process state with the subagent.

**Tail tool call requests.** Gemini-cli's scheduler grew `TailToolCallRequest`, a completed tool can request the scheduler run another tool immediately, before returning control to the model. Useful for "write file → run formatter on it" sequences without a model round-trip. Stays inside the existing scheduler state machine.

## Things to avoid

**Do not inherit the dual-language complexity from codex.** Rust core + TS shim + Python SDK + TS SDK + Bazel + Cargo + Nix + Just. The maintenance tax of keeping all those toolchains in sync is real (codex's own AGENTS.md says "if you change `Cargo.toml`, run `just bazel-lock-update`"). Squad's single Node + TS toolchain is a feature.

**Do not inherit the OpenAI account coupling or vendor-default telemetry from codex.** `DEFAULT_ANALYTICS_ENABLED: true`, Statsig built into the default OTel exporter, `is_openai()` methods that gate features. Squad's local-first charter forbids all of this.

**Do not adopt protobuf-over-IPC as a webview bridge from cline.** It's the right answer when you need cross-language plugin clients (JetBrains, Kanban, third-party SDKs); Squad has zero of those. The cost is real, every new chat-message variant requires updating proto + generated bindings + handler + state migrations + tribal-knowledge docs.

**Do not let core modules become god-classes.** Cline's `src/core/task/index.ts` is 3,764 lines mixing streaming state, abort handling, mode switching, focus chain, hooks dispatch, checkpoint management. Codex's own AGENTS.md explicitly tells contributors to stop adding to `codex-core`. Aider's `coders/base_coder.py` is 2,485 lines with 14 subclasses driving variance. Squad's current narrow boundaries (engine, providers, tools, permissions, sessions, audit, hooks, yolo) must stay narrow on purpose so they never reach this state.

**Do not adopt the README-in-25-languages localization burden from opencode.** Twenty-five files to keep in sync with English on every update. Squad has one README; keep it that way.

**Do not adopt the cron-scheduled-agent and chat-connector matrix from cline.** Slack/Telegram/Discord/WhatsApp/Linear connectors imply an always-on daemon and persistent OAuth tokens for messaging platforms. Charter-incompatible.

**Do not adopt the Bun runtime dependency from opencode.** `Bun.file()`, `Bun.write()`, `bun:sqlite`, `$` shell, none run on Node without polyfills. Forced runtime dependency, divergent ecosystem, build-target multiplication. Squad is Node 22+; keep it that way.

**Do not adopt the SST/Cloudflare cloud-native deployment from opencode.** Stripe + PlanetScale + Honeycomb + Cloudflare R2 + durable objects = significant operational footprint for what is sold as a coding agent. Charter forbids hosted, telemetry, remote sessions.

**Do not adopt the auto-injection-by-relevance pattern from nanocoder.** Custom commands silently appended to context based on a heuristic score against the user's prompt. Context-pollution risk and debugging trap, user can't tell what was injected. Squad's skills/output-styles are explicitly invoked; keep that property.

**Do not adopt nanocoder's `yolo`-on-a-rotation-key UX.** Shift+Tab cycles `normal → auto-accept → yolo → plan`; three Shift+Tabs from normal arms yolo with no checklist. A user habituated to the cycle is one keystroke from `rm -rf` running unprompted. Squad's `/yolo` toggle + checklist gate + delete-archive rewrite is the safer shape.

**Do not adopt the implicit-auto-commit-everything default from aider.** Auto-commit-on-every-edit plus dirty-commit-before-edit rewrites the user's git history without asking. Many aider users hate this. Squad should ship `--no-auto-commit` as the only behavior in v1.x; if auto-commit lands later (after `revert_turn`), make it explicit opt-in.

**Do not adopt aider's "weak model" terminology.** The semantic intent is "cheap model for cheap tasks like commit message generation"; the name leaks an opinion about model quality. Squad's vendor-neutral naming feedback already flagged this kind of branding leak. Use `secondary_model` / `commit_model` / `summary_model`.

**Do not import gemini-cli's A2A/enterprise-controls/availability-service stack.** Remote subagents over HTTP push toward a hosted-agent posture. Admin/strict-mode/quota-management assume a fleet of users with central policy override. Squad is single-user local-first.

**Do not adopt Conseca-as-shipped from gemini-cli.** Generating the per-prompt security policy via a Gemini Flash call bakes in a hosted vendor. The structural idea, "before this prompt's tool use begins, generate a least-privilege policy specific to it", is right; the runtime must be local (deterministic generator or a small local model).

**Do not adopt MCP just because peers ship it.** Both cline and nanocoder ship MCP heavily. The dependency footprint is real (three transports, OAuth flows, malformed-schema handling, per-server auto-approve lists). Squad already punted MCP for charter reasons. The mere fact that peers ship it is not evidence Squad should reverse the call.

## Concrete backlog inserts

Continuing from the 2026-05-08 batch (items 1-9) and the gemini-cli refresh per-project list (items 10-20). The complete refreshed roadmap below renumbers cleanly and prioritizes for v1.2 / v1.3 / post-v1.3.

**For v1.2 (subagent layer + adjacent):**

1. Built-in `plan` agent (opencode shape) with `edit: deny` everywhere except `.squad/plans/*.md`. Switch via `/agent plan` slash command and `--agent plan` flag. Reuses YOLO's prompt-addendum mechanism.
2. Markdown agent loader from `~/.squad/agents/*.md` and `./.squad/agents/*.md`, frontmatter parser shared with skills + output-styles. Built-in defaults can be overridden by name. Deprecated-tools translation (`tools: { write: true }` → `permission.edit = "allow"`) for compat with simpler user form.
3. Markdown custom-tools loader from `~/.squad/tools/*.md` and `./.squad/tools/*.md`. Frontmatter declares params + approval + read_only + timeout + cwd + env + shell; body is a Mustache-templated shell script with shell-quoted substitutions. Reuses Squad's existing `Shell` runner.
4. Granular auto-approve dials in `.squad/settings.json`, `autoApprove: { readLocal, readExternal, editLocal, editExternal, shellSafe, shellAll, browser, mcp, web }`. Squad's pattern-based permission rules can implement this without UI complexity.
5. `external_directory` as a distinct permission kind, separate from per-tool jail bypass. Lets users grant access to `~/.squad/skills/*`, `~/.squad/output-styles/*`, truncate-output dirs without flipping the whole filesystem jail.
6. `SerializableConfirmationDetails` data-payload union for every permission prompt. Includes source-agent metadata. Decouples request from UI surface so subagents can carry their permission flow without copying the engine.
7. Source-agent metadata in every audit row.
8. Subagent lifecycle event stream matching cline's `SubagentProgressUpdate` shape, `{ status, latestToolCall, stats: { toolCalls, inputTokens, outputTokens, cacheRead, cacheWrite, totalCost, contextUsagePct } }`.
9. `task_status` model-callable tool for parents to query in-flight subagent state mid-loop.
10. `ask_user` tool for structured model-initiated questions (CHOICE / TEXT / YESNO + multi-select + "Other"). Routes through MessageBus, answers land in audit chain.
11. Background-shell tools, `list_background_processes`, `kill_background_process`, `read_background_output`. Required once subagents run real test suites or watchers.
12. Model-aware tool routing, small `default-models.json` table mapping models to preferred edit tools. GPT-5+ → ApplyPatch; everything else → Edit/Write.
13. Identical-tool-call guard refinement, add `IGNORED_PARAMS` filter (per cline's `loop-detection.ts`) so metadata-only param churn doesn't reset the counter.
14. Tighten shell command validation, line-separator check (newlines, U+2028, U+2029, U+0085 outside quotes), recursive subshell parser for commands containing `(...)` or `$(...)`, reject redirect operators by default in YOLO mode.
15. Stream-JSON output format (`--output-format stream-json`) matching the gemini-cli schema. Newline-delimited typed events.
16. AGENTS.md adoption alongside CLAUDE.md, both filenames recognized with the same precedence (project root → parents up to repo root).
17. `BeforeModel` / `AfterModel` / `PreCompress` hook events. Model-wrap hooks that can synthesize a response or modify the prompt. `PreCompress` lets users veto or archive the about-to-be-summarized transcript.
18. `Runtime` hook type alongside command hooks, in-process JS handlers without fork/exec per fire.

**For v1.3 (extension surface + persistence + revert):**

19. Side-snapshot `revert_turn` per opencode's `snapshot/index.ts` reference, per-project git-as-storage under `~/.squad/snapshots/<project-hash>/`, `core.longpaths=true`, `core.symlinks=true`, `core.autocrlf=false`. Track-before-edit + track-after-edit in agent loop. `/revert <turn-id>` slash command + `squad revert <session-id> <turn-id>` CLI. Session schema gains `revert: { snapshot, original_turn }` field for unrevert.
20. `/undo` slash command with aider-grade paranoia for the auto-commit case (when auto-commit lands).
21. Tracked replacement provenance in `/compact`, `summary_node_id → [original_message_ids...]` sidecar. Doesn't change runtime; makes `/restore` after compaction feasible.
22. Repo-map subsystem under `src/repomap/`, tree-sitter + pagerank + token-budget binary search + tree-context rendering per aider's `repomap.py`. Use `web-tree-sitter` with aider's `.scm` queries (MIT-licensed). Cache by mtime under `~/.squad/cache/repomap/<project-hash>/`. Expose `--map-tokens N` and `--map-refresh {auto,always,files,manual}` flags. Add to system prompt when no `.crabmeat/index.json` manifest is present.
23. `SearchReplace` tool alongside `Edit` and `ApplyPatch`. Schema: `{path, search, replace}`. Implementation copies aider's `replace_most_similar_chunk` + `try_dotdotdots` + `find_similar_lines`. On failure, return `did_you_mean` block.
24. Improve `Edit` and `ApplyPatch` error messages with the same `find_similar_lines` diff hints and "looks like the change is already applied" detection.
25. Hunk-level error messages in `ApplyPatch`, when N hunks succeed and M fail, report which and only ask the model to re-emit the failed hunks (per aider's `not_unique_error` / `no_match_error` / `other_hunks_applied`).
26. `tailToolCallRequest` field in the tool-result protocol, completed tool can request the scheduler run another tool immediately. Stays inside scheduler state machine.
27. Per-adapter-kind tool schema snapshot tests, mirroring gemini-cli's `coreToolsModelSnapshots.test.ts`. Locks in tool schema per adapter.
28. Embedded built-in skills with install-on-first-run fingerprint marker (per codex's `skills/src/lib.rs`). Ship Cid's already-written skills (project-kickoff, why-doc, ship-it, etc.) baked into the binary.
29. Ship a `skill-creator` built-in skill (per gemini-cli's `builtin/skill-creator/SKILL.md`). Teaches the model how to write skills against Squad's loader.
30. Detect and offer to import Claude Code sessions on first run, walk `~/.claude/projects/*/*.jsonl`, summarize, offer import with a ledger to avoid re-prompting (per codex's `external-agent-sessions/`).
31. Discover `.squad.conf.yml` in cwd → git-root → `$HOME` with YAML keys mirroring CLI flags. Use `cosmiconfig`. Keep `settings.json` for permissions and runtime state; `.squad.conf.yml` is user-facing config-as-flags.
32. Named threads, `squad sessions name <id> <name>` plus name-based `squad --resume <name>`. Small SQLite migration.
33. `squad sessions export <id>` to dump a session as markdown. Optional `--chat-history-file <path>` mirror into the project dir.
34. `--ephemeral` flag to skip session persistence. Useful for CI and one-shot probes.
35. `--ignore-user-config` flag to skip `~/.squad/settings.json` for reproducible CI runs.
36. `--output-schema <FILE>` flag for `squad --print` to enforce a JSON Schema on the model's final response.
37. Notification subsystem, desktop notifications for tool confirmations, question prompts, generation completions. macOS `terminal-notifier` with osascript fallback, Linux `notify-send`, Windows PowerShell. Configurable per-event.
38. Reasoning trace UI, collapsible `Thought` block above response, Ctrl+R to toggle expansion, persist in transcript. Squad already supports reasoning deltas at the event level; render them.

**For post-v1.3 (sandboxing + LSP + observability):**

39. Linux/macOS shell sandbox shell-out, detect `bwrap`/`firejail` on Linux PATH, wrap shell commands with `bwrap --ro-bind / / --bind <cwd> <cwd> --proc /proc --dev /dev --unshare-all <cmd>`. macOS analog with `sandbox-exec` + generated `.sbpl`. Refuse YOLO on Linux if no sandbox primitive is available. Windows: recommend WSL2.
40. Post-edit LSP diagnostics injection. After every successful Edit/Write/ApplyPatch, query workspace LSPs for diagnostics on touched files, attach to next tool result as `<diagnostics>` blocks. Nanocoder's `source/lsp/` is the reference TS impl. Trigger should be explicit (opt-in flag or `PostToolUse` hook), not always-on.
41. Headless daemon mode `squad serve --socket ~/.squad/squad.sock` with framed JSON-RPC over Unix domain socket. Editors attach via the socket. Wire format is small (`session.new`, `session.prompt`, `session.events`, `permission.ack`, `tool.list`). Do not start with OpenAPI/HTTP. Treat ACP as a v1.4 thin wrapper around the same socket.
42. Tool profiles for the local provider, `full` / `minimal` / `nano` per nanocoder's `tool-profiles.ts`. Tie to `--profile nano` flag. Single-tool enforcement for nano. Default to `full`; switch to `minimal` when the active model has tight context window.
43. Modular system prompt, split Squad's prompt-building into per-section markdown (`prompts/sections/identity.md`, `prompts/sections/tool-rules.md`, etc.). Mode-specific assembly. Offline token-count audit script.
44. `--watch` mode with `// SQUAD!` / `// SQUAD?` / `// SQUAD@<skill>!` markers per aider's watch mode. Use `chokidar`. Honor `.gitignore` + hardcoded build/cache ignores.
45. Prompt-cache keepalive thread for Anthropic models, per aider's `--cache-keepalive-pings`. Only after explicit `cache_control` work lands in the Anthropic adapter (per provider caching audit).
46. Recursive halfway-split summarizer for `/compact` per aider's `history.py:33-96`. Keep tail, summarize head with secondary model, recurse up to depth 3.
47. Keyring-backed credential storage option (codex's `keyring-store/` crate uses macOS Keychain / Linux Secret Service / Windows Credential Manager). Plaintext only with explicit opt-in.
48. OAuth device-flow adapter kind for GitHub Copilot / ChatGPT subscriptions (per nanocoder's `source/auth/`). Wraps existing `llm-chat` with credential refresh.
49. `npm run benchmark` with module-count loader + `help_hash` stability + tool/command-count regression check per nanocoder's `benchmarks/measure.ts`. Pair with `npm run deflake` from 2026-05-08 batch.
50. `docs/release-confidence.md` per gemini-cli, local-first version with build, typecheck, unit tests, session/audit validation, real-provider smoke, YOLO smoke, subagent smoke. Already in 2026-05-08 backlog; refreshed gemini-cli docs confirm the shape.
51. Offline integration harness with `.responses` golden provider event streams per gemini-cli. Already in 2026-05-08 backlog.
52. Homebrew formula per nanocoder's `Formula/nanocoder.rb` (~20 lines, pin `node@22`, post-install `squad --help` smoke). Worth doing alongside v1.2 release prep.

## Bottom line

The agent-CLI space is converging on a small set of shapes. Markdown-frontmatter extension contracts (skills, output-styles, agents, custom tools, pick a structure and apply it everywhere) are showing up in three of the six rips and Squad already has half the infrastructure. Plan/act mode as a first-class agent is in three rips. Side-snapshot revert outside the user's `.git` is in three rips. Stream-JSON output, AGENTS.md adoption, granular auto-approve, `ask_user` as a structured tool, background shell tools, and model-aware tool routing all show up in at least two. None of these need new architectural concepts in Squad, they fit inside the existing engine/providers/tools/permissions/sessions/audit/hooks/yolo boundary.

The features Squad genuinely wins on against every peer in the batch are tamper-evident audit chain with `prev_hash`, YOLO with checklist gate + delete-archive rewrite, atomic Edit with BOM/line-ending preservation, SSRF guard on local-provider URLs, provider-neutral catalog with four adapter kinds vs. forty hand-written provider files, and the single-user single-process local-first posture. None of those are table stakes in the agent-CLI space; they are deliberate choices Cid made that the rest of the field is choosing differently. The 2026-05-20 plan should hold those lines (don't add MCP because peers ship it, don't add cloud share because opencode does, don't add Bun because opencode does, don't add OpenAI account auth because codex does, don't add VS Code companion because three peers do) and selectively borrow the convergent ideas listed above.

The single highest-leverage steal across the whole batch is the convergence on **markdown-frontmatter extension contracts**, because it's three things at once: the v1.2 subagent layer (agents are just markdown), the v1.3 custom-tools surface (tools are just markdown with shell bodies), and the existing skills/output-styles unification (one parser, one cascade, one mental model). Aider's repo map is the single best individual feature. Codex's sandbox stack is the single best individual contribution to safety. Opencode's side-snapshot revert is the single best reference implementation for `revert_turn`. Everything else in the backlog above is incremental, none of it changes Squad's shape, all of it makes Squad more useful for what it already is.
