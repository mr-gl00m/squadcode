# Why: Rip-apart batch, 2026-05-08

_DeepSeek-TUI-main + gemini-cli-main. Squad Code v1.1/v1.2 planning input._

## What was in the batch

Two terminal-agent codebases:

- `DeepSeek-TUI-main`: Rust, ratatui, DeepSeek-first, with a live monolithic TUI runtime plus an in-progress workspace split into `agent`, `core`, `tools`, `execpolicy`, `hooks`, `mcp`, `protocol`, `state`, `app-server`, and `tui-core`.
- `gemini-cli-main`: TypeScript/Node workspace with `packages/core`, `packages/cli`, `packages/sdk`, `packages/a2a-server`, `packages/devtools`, `packages/test-utils`, and `packages/vscode-ide-companion`, backed by a large integration/eval/perf/release harness.

The useful lesson is not "copy either architecture." Squad already has a cleaner local-first, provider-neutral shape. The useful lesson is which mature agent-CLI pressure points these projects have already named and given structure: release confidence, tool confirmation, background work, rollback, model-routing, diagnostics, and regression measurement.

## Strong Steals

**Release confidence as a first-class doc.** Gemini has a dedicated `docs/release-confidence.md` with automated gates, preview dogfooding, critical user journeys, dashboard/eval review, and go/no-go language. Squad's `checklist.txt` has ship gates, but not a reusable release confidence playbook. Add `docs/release-confidence.md` before the next tag, scoped to local-first reality: build, typecheck, unit tests, session/audit validation, real-provider smoke, YOLO smoke, and subagent smoke once v1.2 lands.

**Integration tests with golden model responses.** Gemini's integration harness runs the bundled CLI against controlled file-system fixtures and uses committed `.responses` files to fake model output. This is a direct fit for Squad. Real-API smoke remains necessary, but most agent-loop regressions should be tested offline with provider events replayed from golden fixtures.

**Deflake workflow for new end-to-end tests.** Gemini explicitly says new integration tests should be run multiple times with a deflake script. Squad is about to add subagents, external CLI providers, and YOLO runs. Those will be timing-sensitive. Add a local `npm run deflake -- --runs=N --command=...` script before v1.2's subagent E2E tests.

**Memory and performance baselines.** Gemini has separate memory and perf test suites with committed baselines and update flags. Squad does not need a big system yet, but two narrow baselines would pay off: long transcript replay memory, and streaming/tool-loop latency for a synthetic 3-turn session.

**Tool confirmation queue.** Gemini has UI and tests around a queue of pending tool confirmations. Squad currently gates mutating tools synchronously. Once subagents run concurrently, a single prompt-shaped permission flow will get awkward. The right v1.2 shape is a central permission/confirmation bus with queued requests from parent and subagents, not one prompt per call site.

**Post-edit diagnostics injection.** DeepSeek's architecture names a post-edit LSP hook: after write/edit/apply-patch, collect diagnostics and inject them before the next model request. This is a high-value addition for Squad after v1.2. It turns "agent edited code" into "agent edited code and immediately saw compiler/linter evidence" without asking the user to run a command manually.

**Rollback snapshots outside the user's git.** DeepSeek uses side-git snapshots under its own state dir so restore/revert does not mutate the project's `.git`. Squad's YOLO archive-on-delete is narrower. A future `revert_turn` should follow this pattern: per-project snapshots in `~/.squad/snapshots/...`, not hidden commits or `git checkout` in the user's repo.

**Runtime thread/turn/item timeline.** DeepSeek's runtime API and durable task queue persist thread, turn, item, event sequence, artifacts, and task state. Squad's JSONL transcripts plus SQLite audit chain are enough for v1.1, but subagents will need a richer in-memory and persisted event timeline. Do not replace JSONL; add a task/subagent event table if the transcript starts carrying too much UI/runtime state.

**Model-routing as a small preflight decision.** DeepSeek's auto mode uses a cheap routing call to choose concrete model and thinking level, then records the route. Squad's provider-neutral catalog could support a similar feature later: `--model auto` as a local policy over catalog capabilities and cost. Keep it after v1.2; it matters more once subagents can mix providers.

## V1.2-Relevant Ideas

**Subagents need lifecycle events, not just return values.** Both projects point in this direction. Gemini has subagent UI components and tests; DeepSeek has model-visible `agent_spawn` plus task timelines. Squad's checklist already names `howl` lifecycle/anguish events. Keep that. The parent should receive the final structured payload; the TUI should receive lifecycle events.

**Depth and concurrency caps are correct.** DeepSeek removed its older swarm surface and settled on subagents/RLM. Squad's planned depth=1 and 4-slot ceiling are conservative and still look right after reading both trees. Queueing beyond 4 should fail fast, not silently spawn unbounded work.

**External CLI subagents need worktree isolation.** Gemini and DeepSeek both care about sandboxing, task isolation, and replay. Squad's plan to run Codex/Claude external CLI agents in `.squad/worktrees/<agent_id>/` is the right safety boundary. The parent should merge or reject diffs explicitly.

**Subagent verification should be measured.** Gemini's eval suite has named evals for delegation, shell safety, concurrency safety, plan mode, and automated tool use. Squad should add targeted eval-like tests for subagent scope refusal, parent payload handling, kill cascade, anguish terminal state, and "same task across multiple providers."

**Permission prompts need ownership metadata.** With subagents, a permission prompt cannot just say `[Shell] npm test`. It needs source agent, cwd/worktree, provider/model, command/file path, and whether YOLO is armed. Gemini's confirmation UI has enough surface area to represent this; Squad's v1.2 prompt should too.

## Things To Avoid

**Do not inherit DeepSeek's monolith.** DeepSeek's docs admit the workspace split is structural and the end-user runtime still lives in a large `crates/tui` source tree. That is a migration smell, not a destination. Squad should keep the current thin `engine`, `providers`, `tools`, `permissions`, `sessions`, `audit`, `hooks`, `yolo` boundaries and add `agents` without creating a new god module.

**Do not import Gemini's product surface wholesale.** Gemini's repo includes A2A server, SDK, VS Code companion, release channels, GitHub bot automation, dashboards, and enterprise auth concerns. Most of that conflicts with Squad's single-user, local-first charter. Borrow the harness patterns, not the ecosystem.

**Do not add telemetry.** Gemini's release confidence leans on dashboards. Squad's local-first rule forbids analytics and phone-home telemetry. The local equivalent is `squad doctor`, local eval reports, JSONL transcripts, and explicit smoke-test commands.

**Do not make model auto-routing the next feature.** It is attractive, but subagents are the unlock. Auto-routing needs enough provider diversity and usage history to make sane decisions. Ship v1.2's subagent layer first.

**Do not add an HTTP runtime API yet.** DeepSeek's HTTP/SSE runtime API is interesting for headless orchestration, but Squad's current scope is a local CLI. The moment to add it is when an external controller needs to drive Squad. Until then, JSONL plus CLI commands are simpler and easier to audit.

## Concrete Backlog Inserts

1. Add `docs/release-confidence.md` for Squad's local release gate.
2. Add an offline integration harness with golden provider event streams.
3. Add `npm run deflake` for repeated command execution.
4. Add two baseline suites: transcript memory and synthetic agent-loop perf.
5. In v1.2, implement a central confirmation bus before concurrent subagent tool use.
6. In v1.2, include source-agent metadata in every permission prompt and audit row.
7. After v1.2, add post-edit diagnostics as a tool-loop feedback hook.
8. After v1.2, add side-snapshot `revert_turn` support under `~/.squad/snapshots`.
9. Later, consider `--model auto` as catalog-driven local routing.

## Bottom Line

Gemini's best contribution is release and regression discipline. DeepSeek's best contribution is runtime-agent ergonomics: durable timelines, rollback, diagnostics, and explicit model-routing. Squad should stay smaller and more local than both, but v1.2 should borrow their hard-won shape around concurrent work: lifecycle events, confirmation queueing, isolated worktrees, and test harnesses that make agent behavior repeatable without paying real API cost every time.
