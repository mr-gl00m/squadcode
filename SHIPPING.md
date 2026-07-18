# Shipping Squad Code v1.1

_Generated 2026-05-09. Definition of shipped at the bottom._

> **Superseded (2026-05-28).** v1.1.0 shipped and is tagged; the project is now at v1.2.0 (tagged 2026-05-20). This document is the historical v1.1 ship plan, kept for reference. The "current state" snapshot below describes the pre-v1.1.0 working tree (everything uncommitted, package.json at 1.1.0, `deadline-timer.ts` untracked) and no longer reflects the repo.

## Current state

- **Works (verified):** all four adapter kinds wired through catalog dispatch (`llm-chat`, `llm-local`, `llm-message`, `llm-response`); YOLO mode with sandbox + archive-on-delete + checklist rails; harness fold-in (hooks, apply-patch, tool-search, auto-compact, artifacts, usage-ledger, tab-title, pattern-permissions); v1.1.x harness-hardening primitives that already landed (arg-repair 5-stage JSON ladder, loop failure guard halt-at-8, omission-placeholder detector, deadline-timer wrapper). Real-API smokes: DeepSeek (no regression after dispatch refactor, verified), Anthropic Claude Sonnet 4.6 (streams end-to-end against `ANTHROPIC_API_KEY`, verified), YOLO autonomous run on DeepSeek v4-pro completed one full checklist-driven run end-to-end (verified 2026-05-09).

- **Unfinished:** **everything is uncommitted on master.** `git status` shows 16 modified source/test files (382 insertions across `cli/program.ts`, `cli/repl.tsx`, `cli/simple-repl.ts`, `cli/slash.ts`, `engine/loop.ts`, `permissions/match.ts`, `providers/default-models.json`, `providers/llm-chat.ts`, `providers/llm-message.ts`, `providers/llm-response.ts`, `tools/edit.ts`, `tools/registry.ts`, `tools/shell.ts`, `tools/types.ts`, `tools/write.ts`, `test/permissions.test.ts`) plus untracked new files (`src/deadline-timer.ts`, `src/providers/arg-repair.ts`, `src/tools/omission-placeholder.ts`, `src/tools/index-fetch.ts`, `src/tools/index-list.ts`, `src/tools/manifest.ts`, `src/yolo/`, four new test files). Doc realignment also uncommitted: `README.md`, `PROJ_DOC.md`, `CHANGELOG.md`, `checklist.txt`, `package.json` (1.1.0 bump). The huge rename block staged in the index is purely housekeeping, `_potential_improvements/` and old release notes moved into `.archive/2026-05-06/`. None of it is risky, all of it is unshipped.

- **Not started (for v1.1.0 ship gate):** OpenAI Responses API real-API smoke against `OPENAI_API_KEY` with `gpt-5.1`. Cross-provider session-resume smoke (start on DeepSeek, `--resume` under `--provider anthropic`). Cross-provider `/cost` math smoke (verify Anthropic `cache_read` savings show up). `v1.1.0` git tag.

- **Broken / known issues:** none flagged. The CHANGELOG `[1.1.0]` entry is dated 2026-05-05 and pre-dates the v1.1.x batch additions (arg-repair, loop failure guard, omission-placeholder, deadline-timer) that are now in the working tree. Open question: include them under the `[1.1.0]` tag, or hold them for `[1.1.1]`. See decision in next-actions.

- **Untested at the suite level:** `npm run typecheck` and `npm test` against current working tree haven't been run since the latest WIP additions. Individual test files exist for each new module (`arg-repair.test.ts` 20 tests, `deadline-timer.test.ts` 11 tests, `loop-failure-guard.test.ts` 5 tests, `omission-placeholder.test.ts` 20 tests, `permissions.test.ts` updated for broadened scope, `yolo.test.ts` 18 tests, `llm-message.test.ts` 14 tests, `llm-response.test.ts` 11 tests) but the full suite hasn't been run green end-to-end against the assembled tree.

## MVS: minimum viable ship

v1.1.0 is the **multi-provider + YOLO proof tagged on local git**. Catalog dispatch routes to all four adapter kinds end-to-end on real API calls: DeepSeek, Anthropic Claude (with `cache_control` + thinking), OpenAI gpt-5.x via Responses API (with reasoning), Ollama. YOLO mode completes one autonomous run with the three rails. The canonical event loop in `src/engine/loop.ts` received zero behavior changes during the cycle (architectural test passed, only an optional `yolo?: YoloSession` field added for context propagation). `v1.1.0` is tagged on local. README + PROJ_DOC + checklist + CHANGELOG describe the release accurately. Distribution stays personal-use, tag-only, matching v1.0.0.

## Cut from MVS

- **Public GitHub release announcement, Reddit post, HN submission.** v1.1 stays personal-use like v1.0. Public-launch is its own decision and gets its own SHIPPING-style plan when the time comes.
- **Subagent layer (Phases 12-16 in `checklist.txt`).** v1.2. Per-agent model selection only delivers the vetting unlock once multiple providers exist; v1.1 ships providers, v1.2 composes them.
- **v1.1.x harness-hardening remainders**, env-allowlist sanitization in shell, schema-sanitize, JSONL hook sink, stream-json output format, integration-tests golden fixtures, deflake script, release-confidence doc, memory/perf baselines, error taxonomy, dispatch fallback-chain telemetry. Stays as a separate v1.1.x sub-ladder for post-tag work; explicitly not blocking v1.1.0.
- **Hooks UI surfacing** (`/hooks` slash, settings.json schema docs, event-history panel), v1.2.
- **Auto-compact UX polish** (`/compact --auto` toggle, status-line indicator), v1.2.
- **Markdown rendering / syntax highlighting in REPL, `--output-format json` / `stream-json`**, v1.2 polish backlog.

## Blockers

### Technical
- **Suite-level verification.** Run `npm run typecheck` and `npm test` against the assembled working tree. Fix any breakage from the cross-cutting wiring. Right now this is unknown.
- **OpenAI Responses API smoke against `OPENAI_API_KEY`.** `squad -p "hello" --provider openai --model gpt-5.1` streams end-to-end. Tool loop hits a `Read`. Reasoning deltas surface. `cached_tokens` populates `cachedInputTokens` on a second call.
- **Cross-provider session resume.** Start a session on DeepSeek with one tool call, kill, resume under `--provider anthropic --model claude-sonnet-4-6`. Conversation continues. Audit chain validates end-to-end.
- **Cross-provider `/cost` math.** `/cost` returns real numbers under all four provider runs; Anthropic `cache_read` savings reflect in the cached-input math.

### Content
- **Decision: v1.1.x batch items in `[1.1.0]` CHANGELOG, or hold for `[1.1.1]`.** The arg-repair / loop failure guard / omission-placeholder / deadline-timer work is in the working tree and on the checklist as `[x]`, but the drafted `[1.1.0]` entry was written before these landed. Either fold them into `[1.1.0]` (rewrite the entry, redate to 2026-05-09) or commit them on master under a `[1.1.1]` entry after the tag. Default suggestion: fold into `[1.1.0]` since they're already in the tree the tag will point at, and a tag whose CHANGELOG doesn't describe what's in it is dishonest.
- **`SQUAD_CODE_FEATURES.md` decision.** Untracked file at project root. Either commit it as v1.1 reference content, or move under `docs/`, or `.gitignore` it. Brief read needed before tag.
- **`.why/` directory commit decision.** Untracked, may contain architectural memory files for v1.1. Commit-or-archive call before tag.

### Distribution
- **`v1.1.0` git tag** on local repo. Annotated, matching v1.0.0 pattern.
- **Tag-only on local**, same as v1.0. `package.json` private/publish setting stays as-is. Default answer is no npm publish, no GitHub release. If the answer changes, re-scope this plan.

### Branding
- N/A. README banner, tagline, project name all locked from v1.0.

### Legal
- **License is in place.** `LICENSE` is MIT, copyright `2026 Nathan Seals / Nexus Labs`.
- **`@anthropic-ai/sdk` license.** MIT-compatible; no NOTICE additions needed for v1.1.

## Next actions

| # | Action | Produces | Target date |
|---|---|---|---|
| 1 | Decide: fold v1.1.x in-tree work (arg-repair, loop failure guard, omission-placeholder, deadline-timer) into `[1.1.0]` CHANGELOG, or hold for `[1.1.1]`. Update `CHANGELOG.md` accordingly | CHANGELOG.md aligned with what the v1.1.0 tag actually contains | 2026-05-09 |
| 2 | Decide on `SQUAD_CODE_FEATURES.md` and `.why/`, commit, move, or gitignore. Same call on `_yolo_smoke.rar` (looks like a captured run artifact; probably gitignore) | clean working tree intent | 2026-05-09 |
| 3 | Run `npm run typecheck && npm test` on current working tree. Fix any breakage from the cross-cutting wiring before any commits land | green test suite, clean typecheck | 2026-05-10 |
| 4 | Commit the WIP in coherent slices on master. Suggested grouping: (a) `.archive/` + housekeeping renames, (b) v1.1.x harness primitives (arg-repair + omission-placeholder + deadline-timer + loop failure guard wiring), (c) any remaining provider/CLI wiring, (d) doc realignment + version bump. Conventional-commit each slice | ~4 commits on master | 2026-05-10 |
| 5 | Real-API smoke: `squad -p "hello" --provider openai --model gpt-5.1` streams end-to-end against live `OPENAI_API_KEY`. Tool loop runs a `Read`. Reasoning delta surfaces. Mark Phase 11 line `[x]` | smoke green + checklist line ticked | 2026-05-11 |
| 6 | Real-API smoke: cross-provider session resume. Start on DeepSeek with a `Read`, kill, `--resume` under `--provider anthropic --model claude-sonnet-4-6`. Verify audit chain validates end-to-end. Mark Phase 11 line `[x]` | smoke green + checklist line ticked | 2026-05-11 |
| 7 | Real-API smoke: `/cost` cross-provider math. Run a few turns each on DeepSeek, Anthropic, OpenAI; verify `/cost` returns numbers and Anthropic shows non-zero `cachedInputTokens` on the second turn. Mark Phase 11 line `[x]` | smoke green + checklist line ticked | 2026-05-12 |
| 8 | Tag `v1.1.0` annotated on local repo, message points at the CHANGELOG `[1.1.0]` entry. Mark Phase 11 final two lines `[x]` (tag + ship gate verified) | annotated `v1.1.0` tag | 2026-05-12 |

## Shipped means

`v1.1.0` is annotated-tagged on the local git repo, pointing at a commit whose tree contains the four adapter kinds, YOLO mode, and the v1.1.x harness primitives. A user can run `squad --provider deepseek -p "review src/"`, `squad --provider anthropic --model claude-sonnet-4-6 -p "review src/"`, `squad --provider openai --model gpt-5.1 -p "review src/"`, and `squad --provider ollama --model llama3.2 -p "review src/"` and get the same canonical streaming + tool-loop + JSONL-transcript behavior across all four. `/cost` returns accurate per-provider math, including Anthropic cached-input savings. `--yolo` with a `checklist.txt` completes one autonomous run end-to-end. The canonical event loop in `src/engine/loop.ts` received zero behavior changes during the cycle. `README.md`, `PROJ_DOC.md`, `checklist.txt`, and `CHANGELOG.md` all describe v1.1 as multi-provider + YOLO and v1.2 as subagent-layer. `SHIPPING.md` itself updates to point at v1.2 as the next target. No public release announcement, no Reddit post, v1.1 stays personal-use like v1.0; the public-launch decision is its own future SHIPPING-style plan when v1.2 (or later) gives it real teeth.
