# Squad Code: current state, 2026-07-04

Snapshot of the real repo state, taken to reconcile the historical shipping docs
against `master` before advancing a hardening lane. Only items verified against
git, the type checker, or a run of the suite are marked done here. Anything not
verified is called out as such; future features stay in backlog, not implied
shipped.

## Git

- Branch for this work: `weekend-2026-07-04`, cut from `master` at `9ba7a2d`.
- `master` HEAD `9ba7a2d`: `feat(providers): CrabMeat integration — router kind + stream-json contract (Phase 18, v1.4)`.
- Tags present: `v1.0.0`, `v1.1.0`, `v1.2.0`, `v1.3.0`. No `v1.4.0`.
- Tag targets:
  - `v1.0.0` -> `65da005`
  - `v1.1.0` -> `b4ab32d`
  - `v1.2.0` -> `5af9058`
  - `v1.3.0` -> `6cdb886`
- `v1.3.0` is one commit behind `master` HEAD. The Phase 18 CrabMeat work
  (`9ba7a2d`) sits on `master` untagged. Follow-up cleanup set the package and
  CLI version surface to `1.4.0-dev`, making the current tree visibly distinct
  from the latest tagged release until the live smoke and `v1.4.0` tag happen.

### Pre-existing uncommitted changes at branch time

The working tree carried an in-progress hardening change (not master, not
tagged): `src/permissions/plan.ts`, `src/permissions/policy.ts`,
`test/plan-mode.test.ts`. It tightens the read-only shell classifier so a
classified-read-only command that carries an out-of-project path operand
(absolute path outside cwd, or a `..` climb) or a path-changing verb
(`cd` / `Set-Location` / `Push-Location`) downgrades from auto-allow to ask.
Runtime tests passed but the change broke the typecheck gate under
`exactOptionalPropertyTypes` (it passed `cfg.cwd: string | undefined` into a
`{ cwd?: string }` param). Finished and committed on this branch (see below).

Two untracked files remain and were left alone: `WEEKEND_PLAN.md` (this work's
plan) and `squad_code_pitch.md` at the repo root. Note the root pitch file is a
different path than the `./docs/squad-code-pitch.md` that `PROJ_DOC.md`
references; reconciling those two is out of scope here.

## Baseline (recorded before any code change)

Run against the working tree as it stood at branch time, i.e. including the
pre-existing plan-mode WIP.

- `npm run typecheck`: **FAIL**. 3 errors, all `TS2379`
  (`exactOptionalPropertyTypes`) in `src/permissions/policy.ts` at 150, 157, 172
  - from the WIP passing `cfg.cwd` into a `{ cwd?: string }` param.
- `npm test`: **PASS**. 674 passed, 2 skipped, 62 files. The 2 skips are the
  POSIX-only shell kill-grace tests that skip on Windows (expected per
  `docs/release-confidence.md` gate 3). Vitest strips types, so the WIP type
  error did not surface as a test failure.

Discrepancy worth naming: the checklist presents the tree as green, but the
typecheck gate was red on entry because of the uncommitted WIP. A clean checkout
of `master` at `9ba7a2d` would not have this error; the red gate was WIP-only.

## Doc vs reality

- `checklist.txt`: **current.** Reconciled 2026-06-13. Correctly shows v1.3.0 as
  the tag that shipped the subagent layer (Phases 12-17) and Phase 18 (v1.4
  CrabMeat) as built + offline-tested but sitting on `master` untagged pending a
  live round-trip smoke. Matches the tags and HEAD.
- `CHANGELOG.md`: **current enough for dev state.** `[Unreleased]` now names the
  Phase 18 CrabMeat router / stream-json contract work and the `1.4.0-dev`
  version surface. Final release prose still belongs with the actual v1.4 tag.
- `PROJ_DOC.md`: **status line reconciled.** Header now reflects v1.3.0 as the
  latest tag and `1.4.0-dev` as the current development tree.
- `SHIPPING.md`: **historical, self-marked.** Its own banner says superseded as
  of 2026-05-28; it is the v1.1 ship plan kept for reference. Not a description
  of current state, and it says so.
- `docs/v1.2-backlog.md`: **backlog, accurate as backlog.** Plan mode, worktree
  mode, in-process subagent, read-only shell classifier, keybindings, MCP
  entrypoint, all framed as "build when X." Note two of these have since been
  partly overtaken by shipped work: an in-process subagent shipped in v1.3.0
  (`src/agents/`), and a read-only shell classifier exists in
  `src/permissions/plan.ts` (this branch extended it). The backlog doc predates
  both and was not rewritten here.
- `docs/release-confidence.md`: **current playbook.** Gate 5 (version
  consistency) previously called out a live drift. The current development tree
  now reports `1.4.0-dev` in `package.json`, `package-lock.json`, and the CLI
  constants, while `v1.3.0` remains the latest tagged release.

## Hardening lanes: actual state

All four lanes named in the weekend plan already have their infrastructure in
the tree. The lane menu reads as if these are greenfield; they are not.

- **Golden replay harness**: exists at `integration-tests/golden/`
  (`harness.ts`, `replay-provider.ts`, `replay.test.ts`, fixtures). Green.
  why-doc: `.why/golden-replay-harness-2026-05-23.md`. **Chosen and extended
  this session** (see below).
- **Deflake runner**: exists at `scripts/deflake.mjs`, wired as `npm run
  deflake`. why-doc: `.why/deflake-runner-2026-05-23.md`. Not needed, the suite
  is not flaky (674/674 non-skipped green on the baseline run).
- **Perf/memory baselines**: exist at `perf-tests/agent-loop.test.ts` and
  `memory-tests/transcript-replay.test.ts`, advisory with committed baselines.
  Baseline run: `agentLoop3TurnMedianMs` 0.022ms vs 0.02 baseline;
  `transcriptReplayHeapMb` 3.44MB vs 2.93 baseline (no `--expose-gc`, noisy).
  Both within advisory tolerance.
- **Subagent layer**: shipped as `v1.3.0` under `src/agents/`. Not a build lane.

## Lane chosen this session

**Golden replay harness.** Rationale: the plan's own heuristic ("best if
replay/session fixtures already exist") is literally true, the harness is
present and green, and extension is pure additive regression coverage of
existing loop behavior with zero change to the canonical loop
(`src/engine/loop.ts`). With the core suite green, the stable-core lanes
(golden, perf) were the honest fit; golden gives the most direct value because
three named loop guards had only unit coverage, not an offline end-to-end
fixture. The deflake lane was ruled out (no flakiness observed) and the subagent
lane is already shipped.

Before touching the lane, the pre-existing plan-mode WIP was finished so the
typecheck gate returned to green, a red gate makes any further work
untrustworthy and `docs/release-confidence.md` treats it as a hard blocker.

## Verified changes made on this branch

- `feat(permissions): gate out-of-project path operands in read-only shell
  classifier`, finished the pre-existing plan-mode WIP and fixed the 3 type
  errors by widening the opts `cwd` type to `string | undefined`
  (matches `CliPolicyArgs`). `test/plan-mode.test.ts`: 42 tests green.
- `test(golden): cover multi-tool dispatch, max_turns cap, and failure-halt
  end-to-end`, three new fixtures + tests through the real loop:
  `multi-tool-call` (two calls in one turn both dispatch, in order),
  `max-turns` (fresh succeeding calls, maxTurns=3, halts on the cap with
  `MAX_TURNS`), `consecutive-failures` (eight fresh failing calls isolate the
  failure guard from the repeat guard and halt on the eighth with
  `REPEATED_TOOL_FAILURES`). Golden suite 6 -> 9 tests. No loop change.

## Post-change verification

- `npm run typecheck`: PASS (0 errors).
- `npm test`: PASS. 677 passed, 2 skipped (same 2 Windows-skipped POSIX tests).
- `npx vitest run integration-tests/golden/replay.test.ts`: 9 passed.

## Human gates not crossed

- No real API calls with paid provider keys.
- No public release, tag, or npm publish. Work stays on the
  `weekend-2026-07-04` branch; nothing pushed.
- No subagent UX or permission-model design decisions taken.
