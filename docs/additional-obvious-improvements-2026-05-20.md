# Additional Obvious Improvements - 2026-05-20

This is a single extra pass after the R&D feature scan and rip-apart batch. It intentionally avoids repeating the already-captured items: subagents, worktrees, plan mode, stream JSON, side snapshots, repo maps, markdown agents/tools, hook expansion, AGENTS.md, read-only shell classification, SDK/server mode, IDE bridges, MCP, scheduler, LSP diagnostics, benchmark harness, and release-confidence docs.

The theme here is simpler: Squad Code is already collecting high-value local evidence - audit rows, usage rows, provider metadata, tool failures, hooks, artifacts, sidecars, and YOLO checklists. Several product features fall out of that evidence without changing the project's shape.

## Executive Take

The next obvious improvement lane is not "more agent features." It is turning Squad's local records into feedback loops:

- tell the user what happened in a run without making them inspect raw transcripts
- tell the project which model actually works best for its tasks
- tell the agent what environment it is operating in before it wastes tool calls
- tell the owner when permissions, hooks, pricing, models, or session storage have drifted
- turn YOLO from "checklist injected into prompt" into a measured contract

These fit Squad's charter because they are local-first, single-user, inspectable, and mostly database/query/reporting features around code that already exists.

## 1. Run Receipts

Add `squad receipt <session-id>` and a `/receipt` slash command that produce a compact run receipt from the session JSONL, audit chain, usage ledger, and artifact refs.

The receipt should show:

- prompt summary
- files read
- files written or edited
- shell commands run, with exit codes
- permission decisions
- hooks fired
- token/cost total
- artifacts created
- final error, if any

Why it is obvious: the data already exists, but today it is scattered across `sessions show`, `usage`, audit rows, and artifact sidecars. A receipt is the natural "what did the agent just do?" primitive.

Why it is not already in the reviewed roadmap: stream JSON and markdown export are about external consumers and transcript portability. A receipt is an operator-facing accountability report.

First implementation:

- add a pure formatter over `SessionRecord[]`
- include audit/usage lookups when available
- print markdown by default
- later add `--json`

## 2. Model Scorecards From Real Local Runs

Add `squad models scorecard` that summarizes local model performance using existing session and usage data.

Useful rows:

- provider/model
- sessions
- total turns
- tool calls per turn
- tool failure rate
- repeated-call aborts
- max-turn aborts
- average cost per successful turn
- cache hit rate
- median output tokens

This directly serves Squad's real differentiator: model vetting. The current `usage` command answers "what did I spend?" A scorecard answers "which model is actually behaving well in this harness?"

The first version can be crude and still useful. It does not need semantic task scoring. Tool errors, loop aborts, denials, and cost already expose a lot.

## 3. Provider Capability Probe

Add `squad models probe [provider/model]` to run a tiny deterministic capability check before trusting a catalog row.

Probe checks:

- key or local endpoint is reachable
- streaming text works
- tool call round-trip works
- advertised reasoning events appear when `capabilities.reasoning` is true
- advertised cache/thinking flags do not crash the adapter
- context window and pricing metadata are present or explicitly unknown

Why it matters: the model catalog is intentionally user-extensible, but one bad row can fail late inside a real session. A probe gives the user a fast "this model is wired correctly" command and gives future bug reports a standard diagnostic.

This is different from real-provider smoke tests. It is a user-facing health check for custom catalog entries and hosted OpenAI-compatible providers.

## 4. Environment Snapshot Injection

Before the first model turn, collect a small local capability snapshot and add it to the system prompt.

Examples:

- shell type and version
- git present and repo status available
- rg present
- npm/node versions for JS projects
- python/pytest present for Python projects
- package manager detected from lockfiles
- current branch and dirty/clean state

The current prompt already includes platform shell guidance. The missing step is project-specific tool availability. This would prevent wasted calls like trying `rg` when absent, running `npm test` in a pnpm-only repo, or assuming a git repo when there is none.

Keep it bounded:

- one read-only preflight
- hard timeout
- no network
- never include environment variables
- cache for the session

## 5. YOLO Checklist Accounting

YOLO currently requires and injects a checklist. The next obvious step is treating that checklist as structured state.

Add:

- parse checklist items at startup
- seed `TodoWrite` from those items
- track which items the agent marks complete
- at session end, print a YOLO completion report
- record unresolved items in the audit/session receipt

This makes the YOLO gate measurable. It also catches a common autonomous-run failure mode: the agent does a lot of work, but not the work on the checklist.

First version can be text-based:

- parse Markdown task list items and bullet lines
- exact item text becomes the task key
- no NLP matching required

## 6. Policy Lint

Add `squad policy lint` for `.squad/settings.json` and active runtime policy.

Checks:

- broad `Shell:* allow` grants
- path grants that accidentally cover repo root
- stale project rules for paths that no longer exist
- rules shadowed by more specific denies
- sensitive defaults overridden by project allow rules
- hooks that match mutating tools without clear scope
- invalid but silently ignored settings entries

This is a natural companion to permanent project permissions. If the tool lets users persist trust, it should also help them audit accumulated trust.

Do not make it paternalistic. Print findings with concrete scope strings and suggested narrower patterns.

## 7. Hook Doctor

Add `squad hooks doctor` to validate and dry-run hooks without needing to start an agent session.

Checks:

- settings parse
- duplicate ids
- command exists
- command timeout is sane
- HTTP hook URL is allowed by user config
- pattern/tool filters match at least one known tool
- sample payload renders correctly

Hooks are already useful, but invisible failure is likely. The runner logs failures and writes audit rows, but the user needs a preflight.

This is smaller than expanding the hook system. It makes the existing hook system operable.

## 8. Session Doctor

Add `squad doctor sessions` for local state integrity.

Checks:

- audit chain validates
- session index rows point to existing JSONL files
- JSONL files parse
- assistant sidecars referenced by sessions exist
- artifact refs exist and match sha256
- usage rows point to known sessions when possible
- archived sessions are consistently marked

Squad already has stronger local persistence than most peer tools. A doctor command makes that strength visible and helps catch disk/user-edit corruption before resume fails.

This should be read-only by default, with a later explicit `--repair-index` for rebuilding derived SQLite indexes from JSONL.

## 9. Budget Guardrails

Add per-run budget caps:

- `--max-cost-usd`
- `--max-input-tokens`
- `--max-output-tokens`
- `--max-tool-calls`
- `--max-shell-seconds`

When a cap is near, warn. When hit, stop the loop with a structured tool result or canonical error.

This is not just spend control. It is also a harness feature. Local model eval runs need bounded failure modes. A model that thrashes should produce "budget exceeded" rather than a surprise bill or a 25-turn drift.

This builds on the usage ledger and existing max-turn/failure guards.

## 10. Tool Failure Ledger

Promote tool failures from log noise into queryable local learning data.

Track by:

- provider/model
- tool name
- error code
- normalized command head for Shell
- session id
- turn index

Then expose:

- `/failures`
- `squad failures --model ... --tool ...`
- top recurring failure signatures

Why it matters: Squad already has loop guards, but the long-term payoff is identifying which prompts, models, tools, or platforms fail repeatedly. On Windows, for example, bad PowerShell assumptions should become visible fast.

This is distinct from bug hunting. It is operational telemetry, but local and user-owned.

## 11. Permission Forecast

When a user is about to approve a broad permission, show a short forecast of what that grant covers.

Example:

```text
Persist project allow for Shell pattern "npm *"?
This will also allow:
  npm test
  npm run build
  npm install <anything>
It will not allow:
  npx ...
  node ...
```

The system already derives broader scope patterns for `[A]` and `[P]`. Forecasting makes that derivation legible at the moment of trust.

This is not a new permission model. It is better UX around the current one.

## 12. Context Budget Inspector

Add `/context` to show where the current prompt budget is going.

Breakdown:

- system prompt
- style/skill additions
- loaded checklist
- messages
- tool results
- artifacts/previews
- loaded tool schemas
- manifest hint

This is especially useful with deferred tools, skills, output styles, YOLO checklist injection, and auto-compact. Users need a way to see why a run is getting expensive before they compact or clear.

Even approximate token estimates are enough for the first version.

## 13. Default Prompt Regression Snapshots

Add tests that snapshot the generated system prompt under a few configurations:

- base registry
- registry with manifest
- YOLO addendum
- loaded deferred tools
- active skill/style
- Windows shell hint

This is a quality suggestion rather than a product feature. The system prompt is now a real API surface, but it can drift silently when tools or modes are added.

This differs from tool schema snapshot tests already captured in the backlog. It protects the prompt contract itself.

## 14. Local Repro Bundle

Add `squad sessions bundle <id>` to create a redacted local support bundle.

Contents:

- session JSONL
- run receipt
- model catalog rows used
- settings minus secrets
- package/version info
- audit validation status
- referenced artifacts, optionally included

The user owns the bundle and decides where it goes. No upload, no telemetry, no cloud support path.

This is the natural public-release support primitive. It also helps future-you debug issues without asking the user to manually collect five files from `~/.squad`.

## 15. Model Routing Hints From Scorecards

Once scorecards exist, add local hints:

- "this model has a high Shell failure rate in this project"
- "this model is cheap but often hits max turns"
- "this model has the best cache hit savings"
- "this model is better for read-only review than edit-heavy tasks"

Do not auto-switch models. Just surface grounded local evidence at `/model` time or in `squad models scorecard`.

This keeps the provider-neutral stance while making the harness smarter over time.

## Suggested Build Order

1. Run receipts
2. YOLO checklist accounting
3. Policy lint
4. Provider capability probe
5. Model scorecards
6. Budget guardrails
7. Session doctor
8. Hook doctor
9. Context budget inspector
10. Tool failure ledger
11. Permission forecast
12. Environment snapshot injection
13. Prompt regression snapshots
14. Local repro bundle
15. Model routing hints

## Highest-Leverage Short List

If only three land, pick these:

1. **Run receipts** - makes every session accountable and gives later features a common summary format.
2. **Model scorecards** - turns Squad's provider-neutral loop into a real local model-vetting product, not just a CLI that can switch providers.
3. **YOLO checklist accounting** - makes autonomous runs auditable against the user's stated task list.

These three are low-architecture, high-signal improvements. They do not require a new runtime, new provider, new UI surface, or a larger product posture. They make the current system more legible and more useful.
