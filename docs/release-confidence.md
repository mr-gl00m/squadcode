# Release confidence: Squad Code ship gate

The repeatable gate to run before tagging a Squad Code release. Each gate has a
command and a pass criterion. A release ships only when every applicable gate is
green; a red gate is a blocker, not a judgement call.

This is a local-first project with no telemetry, none of these gates phone home,
upload, or report anywhere. Everything runs on the dev machine against local
state and the user's own provider keys. The real-provider smokes are the only
gates that touch the network, and only to the API the user configured.

## Gate order

Run cheap-and-deterministic first, expensive-and-networked last, so a fast
failure stops the line before any API spend.

### 1. Build

```
npm run build
```

Pass: `tsc` emits with no errors and `copy-assets.mjs` runs clean. A build that
needs a flag or a manual step is a red gate, fix the build, don't document the
workaround.

### 2. Typecheck

```
npm run typecheck
```

Pass: `tsc --noEmit` reports zero errors. Note this checks `src/` and `bin/`;
test files (`test/`, `integration-tests/`) are outside the `tsconfig` include and
are only validated by being run under vitest, so a type error there surfaces as a
test failure in gate 3, not here.

### 3. Unit + integration tests

```
npm test
```

Pass: every test passes; skips are only the platform-guarded ones (the POSIX-only
shell kill-grace tests skip on Windows, that's expected, a *new* unexplained
skip is a red gate). This suite includes:

- the golden replay harness (`integration-tests/golden/`), which exercises the
  agent loop end-to-end offline, tool dispatch, the repeat-guard, the
  failure-guard;
- audit-chain validation: `SessionStore.validateAuditChain()` wraps
  `audit/chain.ts:validate()`, and the resume/audit smoke asserts the
  prev_hash chain is intact after a mid-turn kill.

### 3a. Static and supply-chain gates

```
npm run knip
npm run lint
npm run audit:ci
```

Pass: knip reports no unused files/dependencies/exports; the Biome ratchet
reports zero errors and no warning/info regression above its committed
baseline; npm audit reports no critical or high vulnerabilities.

### 4. Audit-chain integrity

```
squad audit verify
```

Pass: exits zero after checking `prev_hash` continuity in the accumulated
`~/.squad/audit.db`; a mismatch reports its first row id and exits non-zero.
This detects accidental gaps and corruption. It does not prove authenticity:
the table stores payload hashes rather than payloads, uses no keyed signature,
and has no external anchor, so deliberate recomputation is outside this gate's
threat model.

For a database that contains a documented fork from an older, already-fixed
writer, do not rewrite history merely to turn the gate green. Record every
legacy mismatch and its timestamps, verify that the tail is continuous after
the final legacy mismatch, then run the same CLI against a clean isolated state
directory. A release may proceed only when the current-build clean check passes,
the post-fix tail is continuous, and the exception is disclosed in the release
notes. Any mismatch created by the current build remains a hard blocker.

### 5. Version consistency

The version string lives in more than one place and has drifted before. Confirm
all of these agree with the tag you're about to cut:

- `package.json` `version`
- `package-lock.json` (the root `version` and the `""` package entry)
- `src/cli/program.ts` `VERSION`
- `src/cli/simple-repl.ts` `VERSION`
- any `VERSION` reference surfaced in `src/cli/repl.tsx`

Pass: every location matches. (As of this writing the in-code `VERSION` constants
read `1.1.0` while `package.json` is `1.2.0`, that drift is exactly the failure
this gate exists to catch. The `chore(release)` commit bumped `package.json` but
not the constants.)

### 6. Real-provider smoke

One real streaming call per provider kind in the catalog, against a live key.
This is the gate that proves the dispatch + adapter path actually works on the
wire, not just in fixtures. The four adapter kinds:

```
# llm-chat (DeepSeek / OpenAI-compat)
squad -p "say hi" --provider deepseek --model deepseek-chat

# llm-message (Anthropic Messages)
squad -p "say hi" --provider anthropic --model claude-sonnet-4-6

# llm-response (OpenAI Responses)
squad -p "say hi" --provider openai --model gpt-5.1

# llm-local (Ollama) — requires a local Ollama serving the model
squad -p "say hi" --provider ollama --model ollama-default
```

Pass: each streams a response end-to-end and exits 0. Skip a kind only if you
have no key/endpoint for it, and record which kinds were skipped in the release
notes, because an unskipped kind that wasn't actually exercised is a silent gap.

Cross-provider checks worth running when adapters or dispatch changed:

- `--output-format stream-json` emits well-formed NDJSON ending in a `result`
  record with the token + cache breakdown;
- `/cost` (or the `usage` command) shows accurate per-provider math, including
  Anthropic `cache_read` savings;
- cross-provider resume: start a session on one provider, `--resume` under
  another, confirm the transcript replays cleanly.

### 7. YOLO smoke

```
squad --yolo -p "..."   # in a dir WITHOUT a checklist -> must refuse
squad --yolo -p "..."   # in a dir WITH checklist.txt/CHECKLIST.md -> arms cleanly
```

Pass: refuses without a checklist, arms with one, and completes one autonomous run
end-to-end with the three rails (sandbox, archive-on-delete, checklist) intact.
Weak local models may spiral and hit `max_turns`, that's a model result to
record, not a harness red gate, as long as the rails held.

### 8. Subagent smoke

A parent spawns a subagent, the subagent runs in its isolated tool/permission scope,
returns one structured payload, and the parent continues with that payload only, 
with depth=1 and the 4-slot ceiling enforced, and Ctrl+K kill verified on a live
panel. The offline suite covers the structural invariants; a real multi-model run
and live TTY panel remain explicit credential/TTY-gated release checks.

### 9. Flake check (when timing-sensitive code changed)

For changes touching the shell tool, the kill-grace path, hooks, or any
process-spawning test, shake out intermittents before tagging:

```
npm run deflake -- --runs=30 --command="npx vitest run test/shell-hardening.test.ts"
```

Pass: 100% over the run count. Anything less is a flake to fix or quarantine
before release, not after.

## Tagging

Only after gates 1-7 (and 8 once applicable) are green:

1. Bump every version location from gate 5 in one commit.
2. Update `CHANGELOG.md` and write the release notes (the
   `changelog-release-description` skill owns this).
3. Tag locally: `git tag vX.Y.Z`. Squad Code's release tags are local, there's
   no publish step that phones home.

## Out of scope: deliberately not gated

- **Coverage thresholds.** Tests gate on pass/fail and on the named smokes, not
  on a coverage percentage. A coverage number is not a confidence number.
- **Performance regressions** beyond the committed baselines
  (`perf-tests/`, `memory-tests/`), those baselines are advisory signals, not
  hard ship gates, because they're machine-dependent.
- **Formatting perfection.** Biome errors and diagnostic-count regressions are
  gated, but the existing warning/info baseline is a ratchet rather than an
  all-at-once cleanup requirement.
- **Telemetry / crash reporting.** There is none, by design, and adding any would
  itself be a charter-level decision, not a release detail.
