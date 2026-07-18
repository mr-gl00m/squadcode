# Codex Rollover: Plan, Sequencing, Execution Doc

**Drafted:** 2026-07-10
**Verified against:** HEAD `dd8f134` plus the current uncommitted working tree
**Status:** plan only. No code written, no files changed outside `docs/`.

## Sources

Three documents in `.rnd/`, with different jobs:

| Doc | Role | How it is used here |
|---|---|---|
| `The strongest strategy is Squad sho.txt` | Bidirectional strategy (Squad and Codex) | Only the Squad-inbound half is actionable. Its "things not to copy unchanged" section is a list of Squad's own defects. |
| `codex_rollover_analysis_2026_07.md` | Squad-specific work breakdown | The spine of this plan. Its §1 premise is stale (see §0). |
| `What this is.txt` | Security review of Codex itself | A hazard list. The code we were told to port has confirmed fail-open defects. This reframes §2.1 of the analysis doc. |

Everything below was checked against `src/`. Where a source doc is wrong, the correction is called out and marked.

---

## §0 Verified state of the tree (two corrections)

### Correction 1: the red-team remediation is already built, uncommitted

`codex_rollover_analysis_2026_07.md` §1 opens with "These map onto the unremediated `.red_team/report_2026-07-06_231245` items." That is no longer true. The working tree carries the fixes. Executing §1 literally would rebuild finished work.

| Finding | Analysis doc says | Verified in tree | Evidence |
|---|---|---|---|
| RT-001 child-process env policy | open (critical) | **built** | `buildSanitizedChildEnv` exported from `src/tools/shell-env.ts:150`, applied at the spawn call in `src/hooks/runner.ts:125`, `src/providers/external-cli.ts:123`, `src/providers/router.ts:68` |
| RT-002 HTTP hook allowlist | open (high) | **built** | `allowedHosts` in `src/hooks/config.ts:47`, enforced in `src/hooks/runner.ts:209-228` (scheme check, HTTPS requirement, private-network deny, host allowlist) |
| RT-003 Grep ReDoS | open (medium) | **built** | `pattern` capped at `maxLength: 500`, nested-quantifier rejection at `src/tools/grep.ts:84` |
| RT-004 PDF read caps | open (medium) | **built** | `PDF_BYTE_THRESHOLD` / `PDF_PAGE_THRESHOLD` at `src/tools/read.ts:26-27`, `READ_TOO_LARGE_PDF` |
| RT-005 trust markers on prompts | open (medium) | **built** | new untracked `src/prompts/boundary.ts` (`wrapToolOutput`, `wrapUserPrompt`) |
| RT-006 lockfile advisories | open (medium) | **probable** | `package.json` + `package-lock.json` both modified; not audit-verified |

Enforcement was checked at the call site, not merely at the import. Correctness of the implementations was **not** audited. That audit is Phase A.

### Correction 2: v1.4.0 was staged but untagged

At plan intake, `git tag -l` stopped at `v1.3.0` while `package.json` said `1.4.0`. **Resolved 2026-07-10:** after Phase A landed and Cid authorized the release judgement, the annotated `v1.4.0` tag was placed at the remediated Phase A head `054232b`, not the critically scanned `dd8f134` baseline.

### Still genuinely open

Confirmed absent from `src/` by direct search:

- **Secret redaction at sinks** (analysis §1.2). `src/logger.ts:37` redacts pino *paths* via `REDACT_PATHS`. Neither `src/sessions/writer.ts` nor `src/audit/chain.ts` redacts anything. The analysis doc overstates the log gap and understates the transcript gap.
- **Layer 3 encoding normalization** (analysis §1.4). `PROJECT_CHARTER.md:25-26` promises Base64/ROT13/Hex/URL detection, audit-log flagging, and a REPL status-pane surface, with decoded payloads labeled and not inlined. `PROJ_DOC.md:21` repeats it. No code exists; `src/bom.ts` only strips a UTF-8 BOM. The trust-marker half of that same sentence just landed in `boundary.ts`; the normalization half did not.
- **`.github/` CI.** Directory does not exist.
- **`.worktreeinclude`.** Absent.
- **`.git` / `.squad` in-workspace carveouts.** `src/tools/protected.ts` covers OS-sensitive dirs only.
- **`squad doctor`, `squad audit verify`.** No such commands in `src/cli/program.ts`. `chain.validate()` exists with no CLI surface, which `docs/release-confidence.md` already flags.
- **`src/sessions/snapshots.ts`.** Still unbuilt, as `checklist.txt:176` says.

### Squad-native defects, all four confirmed

These come from the strategy doc's "things not to copy unchanged" section. They are Squad bugs, not Codex bugs, and they are the highest-severity items in this plan.

- **D1 Plan mode is bypassable.** `src/permissions/policy.ts` `decideAction` opens with `if (cfg.dangerouslySkipPermissions) return "allow";` before any plan-mode evaluation. Confirmed by reading the function.
- **D2 Shootout isolation fails open.** `src/cli/shootout.ts:56-58`: `const worktree = opts.isolate ? await createAgentWorktree(...) : null; const slotCwd = worktree?.path ?? opts.cwd;`. When worktree creation fails the slot runs in the user's checkout, and the shootout still auto-allows permissions.
- **D3 Worktree paths collide and are never recorded.** `src/agents/worktree.ts:25`: `join(cwd, ".squad", "worktrees", agentId)`. No run ID, so two concurrent runs with the same slot label collide. `createAgentWorktree` returns `null` on failure by design.
- **D4 The audit chain is not tamper evidence.** `src/audit/chain.ts` inserts `payload_hash` only; the payload itself is never stored (`INSERT INTO audit_log (ts, session_id, action, payload_hash, prev_hash)`). `linkHash = sha256(payloadHash|prevHash)`, no keyed signature, no external anchor. Validation can only check link continuity.
- **D5 The atomic writer is not durable.** `src/fs-io.ts` contains no `fsync`, no `chmod`, no `stat`. Temp-and-rename without fsync of file or directory, and no mode/ACL preservation.

**Consequence for D4 that the analysis doc got backwards:** analysis §1.2 says "audit chain payload hash input stays raw-hash but stored payloads scrub." There is no stored payload to scrub. Redacting the audit chain is a no-op today. It only becomes real work if D4 is fixed by storing payloads. The two are chained, not independent.

### Module sizes (current, not as-documented)

The strategy doc quotes sizes from before the remediation. Actual:

| File | Doc says | Actual | Cap |
|---|---|---|---|
| `src/cli/repl.tsx` | 2,168 | **2,264** | 800 hard |
| `src/cli/program.ts` | 1,328 | **1,402** | 800 hard |
| `src/engine/loop.ts` | 523 | **552** | 800 hard |

Both oversized files grew during remediation. The trend is the argument for Phase F.

---

## §1 The load-bearing correction: Codex's shell-safety code is not safe to copy

`codex_rollover_analysis_2026_07.md` §2.1 calls shell-safety depth "the biggest single upgrade" and points at `is_safe_command.rs` and `is_dangerous_command.rs`. `What this is.txt` then documents that **those two exact files contain confirmed fail-open defects**. Neither strategy doc connects these. This plan does.

Port the *architecture* (AST gate, per-command flag exclusions, decision aggregation). Do not port the *matchers*. Each defect below becomes a required differential test in CR-B4.

| Codex defect | Where | Why it fails open | Required in our port |
|---|---|---|---|
| Safe-list keys on basename after stripping `.exe/.cmd/.bat/.com` | `is_dangerous_command.rs:71` via `executable_name_lookup_key` | `./ls.bat`, `C:\repo\ls.bat`, `../evil/ls` all reduce to `ls` and inherit coreutils trust. Nothing checks the resolved path is in a trusted system dir. | Resolve and canonicalize the executable before classifying. A relative or in-workspace path is never a safe-list hit. |
| Danger-list does **not** normalize | `is_dangerous_command.rs:145-157` matches raw `cmd0` | `/bin/rm -rf /` never matches `Some("rm")` and is never flagged. The safe-list normalizes and the danger-list does not; both errors resolve toward allow. | One normalization function, used by both lists. Asymmetry here is the bug. |
| `rm` matcher inspects only `argv[1]` against literal `-f` / `-rf` | same | `rm -fr /`, `rm -r -f /`, `rm --recursive --force /`, `rm /important -rf`, `sudo /bin/rm -rf /` all pass as not-dangerous. | Parse flags properly: cluster short flags, accept long forms, scan all argv positions, unwrap `sudo`. |
| Tests encode the implementation | two `rm` assertions, exactly the two spellings the matcher hardcodes | The test suite can never catch this class of miss. | Tests assert **intent** ("no spelling of recursive-force delete is classified safe"), driven by a bypass corpus. |
| Windows "network: restricted" is env vars, not a boundary | `windows-sandbox-rs/src/env.rs:126` | Sets `HTTP_PROXY` and friends, drops `.bat` deny-stubs, and *deletes* curl/wget stubs. `curl --noproxy '*'` and any raw socket defeat it. | Do not adopt the vocabulary. See CR-B8. |
| Env scrubber ships opt-in | `ignore_default_excludes` defaults `true` (`config_types.rs:237`) | A sandboxed child can read `OPENAI_API_KEY` out of its own environment. | Squad's `shell-env.ts` already defaults to scrubbing. **Keep our default. Do not adopt Codex's.** |

Squad already ships `web-tree-sitter` for the repomap (`src/repomap/parser.ts`), so the tree-sitter-bash dependency for the AST gate is already paid for.

**What Codex genuinely got right, and we should copy:** parse failure returns not-safe; decisions across a `&&` chain aggregate with `max()` so one dangerous segment poisons the chain; the git global-option denylist (`-c`, `--upload-pack`, `--exec-path`, pager and textconv) is correct and test-backed; `find -exec`, `rg --pre`, `sed -i` denylisted. The review author went looking for classic bypasses in the parser layer and found them closed. The gaps sit one layer *below* the parser, in the heuristic deciding whether the parser is consulted at all.

---

## §2 Resolving the sandboxing conflict between the two strategy docs

The two docs disagree, and the disagreement is load-bearing.

- **Strategy doc, P0:** "Replace lexical YOLO sandboxing with OS-enforced sandboxing and fail-closed isolation."
- **Analysis doc, §4:** OS sandboxes are not portable. The Windows backend needs `CreateRestrictedToken`, WFP filters, elevated setup, and dedicated logon sandbox users. A Node process cannot reasonably make those calls.

`What this is.txt` settles it. Codex's own Windows sandbox defaults to `Disabled`, its unelevated mode does not actually block the network, and its fallback when the sandbox is off is advisory policy plus ask/deny at the tool boundary. That fallback **is Squad's current model**. There is no OS-enforced sandbox available to us on the primary platform, and the one we would be copying is weaker than its documentation claims.

So P0 does not reduce to "build an OS sandbox." It reduces to four things Squad can actually do, all of which are pure Squad code:

1. **Fail-closed isolation** where isolation was requested (CR-B2, CR-B3). This is the real P0, and it is entirely ours.
2. **Parsed command safety** replacing whitespace tokenization (CR-B4).
3. **The escalation invariant**: never silently widen access on retry when deny rules exist. This is the one idea the analysis doc says to keep from `sandboxing.rs`, and it is correct (CR-B5).
4. **Honest naming**. `src/yolo/index.ts:34` literally comments "YOLO sandbox" on a function that rejects absolute paths by string inspection. A user reading "sandbox" has a materially wrong model of what is enforced, which is the exact criticism `What this is.txt` levels at Codex's Windows network mode. Applying it to Codex and not to ourselves would be dishonest (CR-B8).

**PowerShell has no in-process AST for Node.** Codex shells out to the real PowerShell parser. Squad is Windows-primary, so this matters more for us than for Codex. Options, with the recommendation:

- Shell out to `powershell -NoProfile -Command '[System.Management.Automation.Language.Parser]::ParseInput(...)'` per classification. Correct, but a subprocess on every command classification, and a bootstrapping problem (we would be spawning a shell to decide whether spawning a shell is safe).
- **Recommended:** conservative deny-by-default word safelist (the `windows_safe_commands.rs` shape), marked with `// shortcut:` naming the ceiling and the upgrade path. Fewer commands auto-allow on Windows. That is the correct direction for a safety check to err.

---

## §3 Phase plan

Phases are ordered by dependency, not by appetite. Version assignments are **proposals**; tagging is Cid's command (`checklist.txt:263` precedent).

Item card fields: **Where** (verified path), **Problem**, **Approach**, **Acceptance**, **Size** (S under a day, M a few days, L a week or more).

---

### Phase A: land what is already built

**Proposed:** v1.4.0. **Blocks:** everything. The tree is dirty and carries security fixes.

#### CR-A1 Review, test, and commit the RT-001 to RT-005 remediation
- **Where:** `src/hooks/{config,runner}.ts`, `src/providers/{external-cli,router,catalog,dispatch}.ts`, `src/tools/{shell-env,grep,read}.ts`, `src/prompts/boundary.ts` (untracked), `src/cli/{program,repl,simple-repl}.*`, `src/engine/loop.ts`, `src/sessions/store.ts`. Tests: `test/{grep,prompt-boundary,read-pdf}.test.ts` (untracked), `test/{hooks,router,external-cli}.test.ts` (modified).
- **Problem:** Unreviewed security code sits uncommitted. Enforcement is present at call sites; correctness is unverified.
- **Approach:** Treat as a code review, not a rubber stamp. Per RT id, confirm the test fails without the fix. Confirm `buildSanitizedChildEnv` does not strip variables the router and external-CLI backends legitimately need (external-CLI was previously documented as passing env through unsanitized on purpose, as "the user's own trusted agent"; that decision has now been reversed and may break configured backends). Confirm the `boundary.ts` wrappers are applied on every untrusted-input path, not only direct prompts.
- **Acceptance:** Full suite green. Each RT id maps to at least one test asserting intent. One conventional commit per finding.
- **Risk:** The external-CLI env change is a behavior reversal with a documented rationale behind it. Check `checklist.txt:236` before assuming it is a straight win.
- **Size:** M

#### CR-A2 Close RT-006 and add a durable audit gate
- **Where:** `package.json`, `package-lock.json`
- **Approach:** `npm audit` clean at critical and high. Record the residual advisory set.
- **Acceptance:** Clean audit; gate wired in CR-C5.
- **Size:** S

#### CR-A3 Update `.red_team/report_2026-07-06_231245.json` with status and SHAs
- **Problem:** The report's remediation checklist is all `[ ]` while the fixes exist. This is the drift pattern already recorded for `checklist.txt`.
- **Acceptance:** Each finding carries `status` and the commit SHA that closed it.
- **Size:** S

#### CR-A4 resolved: `v1.4.0` lands at the remediated Phase A head
Cid authorized the release judgement on 2026-07-10. The annotated tag points to `054232b`; the critically scanned `dd8f134` baseline remains untagged.

---

### Phase B: the real P0, fail-closed isolation and honest command safety

**Proposed:** v1.5.0. **Depends on:** A.

#### CR-B1 Plan mode must beat `dangerouslySkipPermissions`
- **Where:** `src/permissions/policy.ts`, `decideAction`, first statement.
- **Problem:** D1. The unconditional allow precedes plan enforcement, so `--dangerously-skip-permissions` silently disarms plan mode.
- **Approach:** Plan wins. Additionally refuse the combination at CLI parse so the conflict surfaces at the boundary rather than in the policy engine. Two guards; the CLI one is UX, the policy one is the boundary.
- **Acceptance:** A test asserting plan mode plus `dangerouslySkipPermissions` denies `Write`. A test asserting the CLI rejects the flag pair.
- **Size:** S. Highest severity-to-effort ratio in the plan. Do it first.

#### CR-B2 Fail-closed worktree isolation
- **Where:** `src/agents/worktree.ts:21` (`createAgentWorktree`), `src/cli/shootout.ts:56-58`, `src/agents/spawn.ts`
- **Problem:** D2 and D3. Isolation failure degrades into the user's checkout while permissions stay auto-allowed. Paths key on the slot label alone.
- **Approach:** `createAgentWorktree(cwd, id, { required })`. Shootout passes `required: true` and aborts the slot on failure with a clear reason. A subagent whose def sets `isolation: "worktree"` also fails closed; only an unspecified default degrades in place. Path becomes `.squad/worktrees/<runId>-<label>`. The run records every worktree path in its manifest.
- **Acceptance:** Shootout in a non-git directory aborts and does not execute in `cwd`. Two concurrent runs with identical slot labels do not collide. Manifest lists worktree paths.
- **Size:** M

#### CR-B3 `.worktreeinclude`, and the YOLO gate hole it hides
- **Where:** repo root (new), `src/agents/worktree.ts`
- **Problem:** Analysis §3.5 files this under "practices." It is a security item. Worktrees lose gitignored files, including `checklist.txt`. `src/yolo/checklist.ts` refuses to arm YOLO without a checklist. Inside a worktree the file is gone, so the gate's precondition is quietly different from the main checkout's.
- **Approach:** One-line-per-entry file at repo root listing gitignored paths to carry into worktrees. Copy them on worktree creation.
- **Acceptance:** A test asserting `checklist.txt` and `.env` are present inside a created worktree. A test asserting the YOLO gate behaves identically in a worktree and in the main checkout.
- **Size:** S. Elevated from §3.5 on the strength of the YOLO interaction.

#### CR-B4 Parsed command safety
- **Where:** `src/yolo/index.ts` (`checkYoloSandbox`, whitespace tokenizer), `src/permissions/plan.ts` (`classifyShellCommand`, 367 lines), the read-only auto-allow path.
- **Problem:** The classifier is a string inspector. The code comments call it a sandbox.
- **Approach:** tree-sitter-bash AST gate reusing `src/repomap/parser.ts`. Node-kind allowlist (`command`, `word`, `string`, `pipeline`, `list`) and operator allowlist (`&& || ; |`). Subshells, redirects, `$()`, backticks, `$VAR` expansion, and assignments fail closed to unknown. Parse failure returns not-safe. `&&` chain decisions aggregate with `max()`. Per-command unsafe-flag exclusions (`find -exec/-delete`, `sed` safe only with `-n`, `rg --pre`, `base64 -o`, and the git global-option denylist). Windows: conservative word safelist plus `.exe/.cmd/.bat/.com` normalization, marked `// shortcut:` with the PowerShell-AST upgrade path named.
- **Acceptance:** **Differential test corpus from §1**, each case asserting *not safe*: `./ls.bat`, `C:\repo\ls.bat`, `../evil/ls`, `/bin/rm -rf /`, `rm -fr /`, `rm -r -f /`, `rm --recursive --force /`, `rm /important -rf`, `sudo /bin/rm -rf /`, `git -c core.pager=evil log`, `git --exec-path=/tmp/evil status`. Tests are written against intent, so a future matcher rewrite cannot silently pass them.
- **Risk:** The parser becomes a security boundary. A parser bug is a bypass. Fail closed on every error path.
- **Size:** L. The biggest single item in the plan.

#### CR-B5 The escalation invariant
- **Where:** retry and approval paths across `src/permissions/`, `src/engine/loop.ts`
- **Approach:** Never silently widen access on retry when deny rules exist. Audit; add the guard where missing.
- **Acceptance:** A test asserting a denied tool call that is retried does not succeed on the second attempt.
- **Size:** S

#### CR-B6 `.git` and `.squad` protected carveouts
- **Where:** `src/tools/protected.ts`
- **Problem:** Verified absent. Writable-root grants currently reach `.git/hooks`, which is a local privilege-escalation path: writing `.git/hooks/pre-commit` executes on the user's next commit.
- **Approach:** Both directories stay read-only inside writable roots unless explicitly granted.
- **Acceptance:** A test planting a write to `.git/hooks/pre-commit` and asserting refusal.
- **Size:** S

#### CR-B7 Approval keys as vectors
- **Where:** `src/permissions/`, `src/tools/apply-patch.ts`
- **Approach:** One approval key per touched file for multi-file patches. Skip the prompt only when *all* keys are session-approved, so partial overlaps re-prompt.
- **Acceptance:** A test where an `[A]` grant on files {a,b} does not silently cover a later patch touching {b,c}.
- **Size:** M

#### CR-B8 Stop calling it a sandbox
- **Where:** `src/yolo/index.ts:34` comment and `checkYoloSandbox` name, `yoloSystemPromptAddendum`, `README.md`
- **Approach:** Rename to what it is: a path guard. Document the three rails as advisory rails backed by ask/deny at the tool boundary, and say plainly what is not enforced.
- **Acceptance:** No user-facing or in-code text claims sandbox semantics that `src/` does not implement.
- **Size:** S

---

### Phase C: gates

**Proposed:** rides with v1.5.0. **Depends on:** A. **Must precede:** F.

You do not decompose a 2,264-line Ink component with no CI and no UI snapshots. The strategy doc's own sequence agrees (gates at step 2, refactor at step 3).

#### CR-C1 `.github/workflows/ci.yml`
- **Problem:** No CI directory, in a codebase with heavy Windows and POSIX path and shell divergence, on a Windows-primary machine.
- **Approach:** Matrix across `windows-latest`, `ubuntu-latest`, `macos-latest` by Node 22 and 24. Steps: build, typecheck, test, knip, lint.
- **Acceptance:** Matrix green. A deliberately Windows-only path bug fails the Linux leg.
- **Size:** M

#### CR-C2 Generated schema plus drift test
- **Where:** `src/cli/stream-json.ts` (`STREAM_JSON_SCHEMA_VERSION = "1"`), new `schema/stream-json.v1.json`
- **Problem:** The CrabMeat contract is pinned in prose (`integration/crabmeat-contract.md`) and enforced nowhere. It has one live consumer already (`crabmeat/tools/squad-roundtrip.mjs`).
- **Approach:** Generate via `zod-to-json-schema`, commit with a `GENERATED CODE, DO NOT MODIFY BY HAND` header, one vitest that regenerates and diffs. Extend to router I/O, session JSONL records, hook payloads, shootout manifests as those grow zod schemas.
- **Acceptance:** Editing a stream-json record shape without regenerating fails CI.
- **Size:** M. Do stream-json first; the rest follow the pattern.

#### CR-C3 Lint ratchet
- **Problem:** Biome exits 0 while reporting roughly 170 warnings and 68 informational findings. Lint is not a quality gate today.
- **Approach:** Commit the baseline count. CI fails on any increase. Drive down opportunistically.
- **Acceptance:** A new warning fails CI.
- **Size:** S

#### CR-C4 Ink snapshot tests
- **Problem:** `checklist.txt:233` admits live TTY rendering and keypresses have never been tested: "no ink-testing-library dep." Phase F is a rewrite of exactly that surface.
- **Approach:** Add `ink-testing-library`. Snapshot the status footer, the agent panel, the permission overlay, the kill picker.
- **Acceptance:** Snapshots exist before F begins.
- **Size:** M. **Hard prerequisite for F.**

#### CR-C5 `npm audit` gate
- **Acceptance:** CI fails on new critical or high advisories. Closes RT-006 durably.
- **Size:** S

---

### Phase D: sinks, provenance, recovery

**Proposed:** v1.6.0. **Depends on:** A.

#### CR-D1 Secret redaction at sink boundaries
- **Where:** `src/sessions/writer.ts`, `src/sessions/artifacts.ts`, `src/logger.ts`, new `src/redact.ts`
- **Problem:** Session JSONL transcripts store raw text, including any key that transits a prompt or a tool result. `logger.ts` redacts known pino paths only.
- **Approach:** `redactSecrets(text)`: OpenAI `sk-`, AWS `AKIA`, `Bearer <token>`, and `key|token|secret|password = <value>` assignments, replaced with `[REDACTED_SECRET]`. Apply at the sink, best effort.
- **Acceptance:** A test writing a transcript containing a synthetic key and asserting the on-disk JSONL does not contain it.
- **Note:** **Not** applied to the audit chain. See CR-D4.
- **Size:** M

#### CR-D2 One configuration stack with provenance
- **Where:** `src/settings.ts`, `src/permissions/{defaults,global,project}.ts`, `src/providers/catalog.ts`, `src/hooks/config.ts`
- **Problem:** The permission precedence stack is good. Provider catalogs, hooks, project settings, environment, and CLI values merge through separate paths.
- **Approach:** One loader exposing effective value, per-key origin, layer version, and disabled reason.
- **Acceptance:** Every settings key can answer "why did this value win?"
- **Size:** L

#### CR-D3 `squad doctor` and `squad audit verify`
- **Where:** `src/cli/program.ts`
- **Problem:** `chain.validate()` exists with no CLI surface. `docs/release-confidence.md` already calls this out as an honest gap in the ship gate.
- **Approach:** `doctor` reports install, config, auth, and runtime health, powered by CR-D2's provenance. `audit verify` exposes `validate()`.
- **Acceptance:** The release-confidence audit gate becomes runnable.
- **Size:** M

#### CR-D4 Audit chain: say what it is
- **Where:** `src/audit/chain.ts`, `PROJECT_CHARTER.md`, `README.md`
- **Problem:** D4. It stores a payload hash and not the payload, validation checks only link continuity, and there is no keyed signature or external anchor. It detects accidental corruption. It does not detect a motivated tamper, who can recompute the chain.
- **Approach:** Relabel. Document it as accidental-corruption detection.
- **No manufactured alternatives:** the real redesign (store payloads, HMAC with a key the agent cannot read, anchor externally) is a different feature with a different threat model. Nothing in the charter demands it today. Build it only when something does. If it is ever built, CR-D1's redaction extends to the newly stored payloads, and only then.
- **Acceptance:** No document claims tamper evidence.
- **Size:** S

#### CR-D5 Recoverable rollout persistence
- **Where:** `src/sessions/writer.ts`, `src/fs-io.ts`
- **Problem:** D5. The queued, fsynced JSONL writer is a solid start. `fs-io.ts` has no fsync of file or directory, does not preserve mode or ACLs, and performs its stale check before acquiring the file mutex.
- **Approach:** Unwritten items stay buffered. Failed handles are discarded. Writes reopen and retry. Terminal writer failure is observable rather than silent. Take the optimistic-concurrency *principle* from `edit.ts:103` (preview, mtime check, BOM and EOL preservation, ambiguity refusal, all good) and fix the writer beneath it: acquire the mutex before the stale check, fsync file and directory, preserve mode.
- **Acceptance:** A test asserting mtime-check-then-mutex ordering. A crash-injection test asserting no torn record.
- **Size:** M

#### CR-D6 Layer 3 encoding normalization, or amend the charter
- **Where:** `PROJECT_CHARTER.md:25-26`, `PROJ_DOC.md:21`, natural home is the new `src/prompts/boundary.ts`
- **Problem:** The charter promises Base64, ROT13, Hex, and URL detection on pasted prompts and text-like tool output, flagged in the audit log and the REPL status pane, decoded payload labeled and never silently inlined. No code exists. The trust-marker half of the same sentence just landed; the normalization half did not. Codex has no equivalent to copy.
- **Approach:** Build it. `boundary.ts` is already the seam every untrusted input passes through. Detect, flag, label; do not inline.
- **Acceptance:** A `.txt` read containing a Base64 payload produces a labeled detection in the audit log and the status pane, and the decoded bytes never enter the model input.
- **Alternative if appetite is low:** amend both documents to remove the claim. Leaving a public charter asserting a control that does not exist is the worse option.
- **Size:** M

---

### Phase E: typed context fragments

**Proposed:** v1.6.0. **Depends on:** A, and D6 if built (both touch `boundary.ts`).

#### CR-E1 `src/context/fragment.ts`
- **Problem:** `injectPreTurn` is a good dependency seam that currently appends free-form canonical messages.
- **Approach:** A fragment type carrying a stable source and type identifier, explicit replace-versus-append semantics, hard byte and token caps, central rendering and escaping, visibility and trust classification, and cross-turn deduplication.
- **Size:** M

#### CR-E2 Migrate every producer onto fragments
- **Where:** `src/engine/post-edit-diagnostics.ts`, `src/engine/pre-turn.ts` (timers, jobs), `src/hooks/runner.ts`, `src/repomap/index.ts`, `src/prompts/boundary.ts`
- **Acceptance:** No producer appends a raw string into the message array. Caps are enforced centrally. A fragment injected on two consecutive turns is deduplicated.
- **Size:** M
- **Sequencing note:** `post-edit-diagnostics.ts` and `boundary.ts` are both new. Let them stabilize through one release before absorbing them.

---

### Phase F: module decomposition

**Proposed:** v1.7.0, refactor only, no features. **Hard prerequisite:** C1 and C4.

#### CR-F1 `src/cli/repl.tsx`, 2,264 lines
- **Approach:** Split into command registration, session bootstrap, provider resolution, turn controller, permission UI, slash-command handling, presentation components.
- **Acceptance:** No file over 800 lines. Ink snapshots unchanged. Behavior unchanged.
- **Size:** L

#### CR-F2 `src/cli/program.ts`, 1,402 lines
- **Approach:** Same seams.
- **Size:** L

#### CR-F3 Adopt LOC discipline as policy
- **Approach:** Target 500, hard stop 800, from Codex's root `AGENTS.md`. Directory-scoped instruction files next to the invariant they guard, as `codex-rs/tui/src/bottom_pane/AGENTS.md` does in ten lines. Name the specific high-churn files that must stop growing.
- **Acceptance:** Written down where the next contributor, or the next agent, will read it.
- **Size:** S
- **Note:** `src/engine/loop.ts` at 552 is inside the hard stop. Leave it.

---

### Phase G: interaction

**Proposed:** v1.8.0. **Depends on:** C4 for anything touching the REPL.

#### CR-G0 Head and tail output buffering
- **Where:** `src/tools/shell.ts`, `MAX_OUTPUT_BYTES`
- **Problem:** 200KB truncation keeps the tail only. The end of output is usually where the error is, and the start is usually where the invocation is.
- **Approach:** Keep both ends.
- **Size:** S. Independent of everything. Land it whenever.

#### CR-G1 Per-turn diff tracker
- **Where:** feed from Edit, Write, and ApplyPatch in `src/engine/loop.ts`; render through `src/sessions/trajectory-diff.ts`
- **Approach:** Baseline and current content per path, held in memory from committed patch mutations. Render a net unified diff for the turn without rereading the filesystem. 100ms compute timeout with fallback. Surface as `/diff`.
- **Why it matters here:** pairs with YOLO review and the archive-on-delete trail. During a long autonomous run this is the only cheap way to see what the turn actually did.
- **Size:** M

#### CR-G2 Turn-completion notifications
- **Approach:** Two tiers. An external notify program spawned with a JSON payload, and in-terminal OSC9 or BEL with an unfocused-or-always condition. The hooks engine already fires on the right lifecycle points; this is a built-in sink plus a settings key.
- **Size:** S

#### CR-G3 Mid-turn steering queue
- **Where:** `src/cli/repl.tsx`, `src/cli/slash.ts`, drains into `injectPreTurn`
- **Problem:** The user cannot type ahead while a turn runs.
- **Approach:** Queue user messages during an active turn, drain at the next boundary. Add an `availableDuringTurn` flag per slash-command entry.
- **Size:** M

#### CR-G4 Backtrack and rollback
- **Where:** unbuilt `src/sessions/snapshots.ts` (`checklist.txt:176`), `src/sessions/writer.ts`, SQLite index, REPL state
- **Approach:** Esc-Esc primes backtrack, transcript overlay highlights a prior user message, Enter requests rollback.
- **The part that matters:** **confirm-before-trim ordering.** Core truncates the rollout after the turn id, and the UI trims its local transcript *only after core confirms*. Squad's JSONL writer, SQLite index, and REPL state must agree, and the staged state machine is the reference for making three stores agree without a distributed-commit problem.
- **Depends on:** CR-D5. Rolling back a writer that cannot recover from a failed handle is how a transcript gets torn.
- **Size:** L

---

### Phase H: appetite

Unordered. Pull when wanted.

- **CR-H1 Review presets.** `squad review --uncommitted | --base <branch> | --commit <sha>`, wired to the existing built-in reviewer agent (`src/agents/built-in/reviewer.md`, confirmed present). A separate `review_model` config key pointed at a local Ollama catalog row. Nearly free given the reviewer agent already exists. **Size:** M
- **CR-H2 Profiles and per-project trust.** Named profiles ("local", "cloud", "review") over the existing catalog and permission layers. Per-directory trust recorded in config, gating `defaultMode`, with a first-visit prompt. **Size:** M
- **CR-H3 Project instruction ingestion.** Walk from cwd up to a project-root marker, concatenate `.squad/instructions.md` or `AGENTS.md` root-down, refresh per turn. Verified absent: skills are user-level, `.squad/agents/` holds agent definitions, nothing reads a project instruction file into the system prompt. Cheap, and high leverage in any repo Squad is pointed at. **Size:** M
- **CR-H4 Composer upgrades**, ranked by pain on Windows. (1) Paste-burst coalescing: terminals without reliable bracketed paste, which is the Windows failure mode, deliver rapid char-plus-enter streams; buffer and coalesce, collapse large pastes into a `[Pasted Content N chars]` placeholder with the text stored aside. (2) `@`-file mentions, backed by the repomap symbol table. (3) External `$EDITOR` for long prompts. (4) Persistent cross-session input history with search. **Size:** L total, separable
- **CR-H5 Exec-mode extras.** `--output-schema <file>` constraining the final structured response, wanted by CrabMeat-side consumers of `squad -p`. `--output-last-message <file>`. **Size:** S
- **CR-H6 Guardian, local-first.** A local Ollama model vets YOLO escalations and risky permission asks before the user sees them. Deterministic rails stay primary; the model is the judgment escalation layer. This is the CrabMeat thesis applied to Squad's own permission prompts. **Gate on Phase B**: the rails must be correct before a model is allowed to advise on them, or the model is reviewing a broken boundary. **Size:** L

---

## §4 Out of scope

- **The Codex-inbound half of the strategy doc.** Post-edit diagnostics, `/receipt`, repo map, provider-neutral event normalization, and loop guards flowing *into* Codex are advice for OpenAI's repo. Nothing to do here.
- **MCP client and server, app-server JSON-RPC, plugins and marketplace, cloud tasks, IDE bridge.** Hard wall per `PROJ_DOC.md` and `README.md`. This is most of Codex's crate count.
- **OS sandboxes** (Seatbelt, Landlock, bwrap, Windows restricted-token plus WFP). Not reachable from Node. See §2. Keep exactly one idea: the escalation invariant, CR-B5.
- **Responses-only wire simplification.** The Codex fork removed Chat Completions entirely. Squad's `llm-chat` carries DeepSeek and every OpenAI-compatible local endpoint. Nothing to copy.

## §5 Where Squad is already ahead

Calibration, not action items. No Codex equivalent exists for the `prev_hash` audit chain, the arg-repair ladder for malformed tool-call JSON (`src/providers/arg-repair.ts`), the edit fuzzy-match ladder with its uniqueness rail (`src/tools/edit-match.ts`), the delete guard with archive-on-delete (`src/tools/delete-guard.ts`), anguish and howl observability (`src/agents/{anguish,howl}.ts`), or shootout vetting (`src/cli/shootout.ts`). The canonical event union across six provider kinds is a broader abstraction than Codex's single-wire client. None of this needs touching.

Note the tension: CR-D4 relabels the audit chain as corruption detection, and the chain is simultaneously listed here as something Codex lacks. Both are true. It is a real feature with an overstated label.

## §6 Sequencing

```
A (land remediation)
├─> B (fail-closed + parsed safety)      <- the real P0
│   └─> H6 (guardian, needs correct rails)
├─> C (CI, schema drift, lint, snapshots)
│   └─> F (decomposition, needs C1 + C4)
├─> D (redaction, provenance, doctor, recovery)
│   ├─> D4 gates any future audit-payload redaction
│   ├─> D6 shares boundary.ts with E
│   └─> D5 ──> G4 (backtrack needs a recoverable writer)
├─> E (context fragments; after D6, absorbs boundary.ts + diagnostics)
└─> G (interaction; G0 is free, G3/G4 need C4)
```

Cheap and independent, land whenever: **CR-G0** (head/tail buffering), **CR-B8** (naming honesty), **CR-A3** (report status).

The strategy doc's recommended sequence and this one agree on the shape: harden, then gate, then refactor, then build. The one change is Phase A, which that doc could not have known about because the remediation landed after it was written.

## §7 Risk register

| # | Risk | Mitigation |
|---|---|---|
| R1 | Phase A commits unreviewed security code. | Full suite plus a real review. Each RT id gets a test that fails without the fix. Check the external-CLI env reversal against `checklist.txt:236`, where passing env unsanitized was a documented decision. |
| R2 | CR-B4 makes a parser into a security boundary. A parser bug is a bypass. | Fail closed on every error path. Differential corpus from §1. Tests assert intent, never implementation. |
| R3 | PowerShell has no in-process AST for Node. The word safelist is a real ceiling. | `// shortcut:` comment naming the ceiling and the upgrade path, per house rule. Fewer commands auto-allow on Windows; that is the safe direction to err. |
| R4 | Phase F without Phase C loses a working REPL, silently. | C4 (Ink snapshots) is a hard prerequisite, not a nice-to-have. `checklist.txt:233` already concedes this surface has never been tested. |
| R5 | Tagging v1.4.0 at `dd8f134` ships the tree the red team scanned as critical. | Resolved: annotated tag placed at remediated Phase A head `054232b`. |
| R6 | Someone executes `codex_rollover_analysis_2026_07.md` §1 literally and rebuilds finished work. | §0 of this document. The analysis doc's premise is stale as of 2026-07-10. |
| R7 | Porting Codex's shell matchers verbatim imports confirmed fail-open bugs. | §1. Port the architecture, rewrite the matchers, keep the bypass corpus. |
| R8 | `checklist.txt` drifts from the tagged state, as it has before. | CR-A3 plus the paste-ready block in `docs/codex-rollover-checklist.txt`. Verify against `git tag -l` and `package.json`, never against a `[ ]`. |

## §8 Execution protocol

**Branching.** One branch per phase: `harden/phase-a-land-remediation`, `harden/phase-b-fail-closed`, and so on. Local repo only. Cid pushes to GitHub manually.

**Commits.** One conventional commit per item, matching the `red-team-remediate` and `drift-remediate` convention already used in this repo. No LLM co-authorship trailers.

**Tests.** Every item ships with its test. Security items (all of Phase B) ship with a test that fails before the fix and passes after, and that asserts **intent** rather than implementation. `What this is.txt` documents exactly what happens when tests encode the matcher instead of the rule: two `rm` assertions covering precisely the two spellings the matcher hardcodes, and a whole bypass class invisible forever.

**Per-item gate.** `npm run build && npm run typecheck && npm test && npx knip`. From Phase C onward, CI enforces this and adds the lint ratchet plus `npm audit`.

**Per-phase gate.** The phase's acceptance criteria, plus `docs/release-confidence.md`'s ship-gate order: cheap deterministic checks first, real-provider smokes last.

**ESCALATE markers.** Anything needing real provider keys, a local Ollama instance, or a live TTY cannot run unattended. Mark it `[deferred-vX.Y]` with the reason inline, following the existing precedent at `checklist.txt:122`, `:251`, and `:259`. Do not silently skip; do not silently pass.

**Shortcuts.** Deliberate ceilings get a `// shortcut:` comment naming the ceiling and the upgrade path. CR-B4's Windows word safelist is the first one this plan calls for.

**Why-docs.** After each phase that changes architecture (B, E, F), write a why-doc into the **root** `.why/` directory. Not `docs/.why/`. The enforce hook only finds a root-level `.why/`.

**Report hygiene.** RT items update `.red_team/report_2026-07-06_231245.json` with status and commit SHA as they close.

## §9 Open decisions for Cid

1. **CR-A4 resolved 2026-07-10:** `v1.4.0` lands at remediated Phase A head `054232b`, not `dd8f134`.
2. **CR-D6: build Layer 3 normalization, or amend the charter?** Recommendation: build it. `boundary.ts` is already the seam, and `PROJECT_CHARTER.md:25-26` is specific enough that removing it is a visible retreat. But an unimplemented control in a public charter is worse than an honest omission, so amending is the acceptable fallback and doing neither is not.
3. **CR-B4: PowerShell strategy.** Recommendation: word safelist now, real AST later, ceiling documented. The alternative spawns a PowerShell process to decide whether spawning a process is safe.
4. **CR-D4: relabel the audit chain, or build real tamper evidence?** Recommendation: relabel. Nothing currently demands the stronger property. Building it is a separate feature with its own threat model, and it would drag CR-D1 along with it.
5. **Version assignments** throughout §3 are proposals. The last renumbering (v1.2.0 to v1.3.0 for the subagent layer) was disruptive enough to warrant a `.why/` entry, so these stay unassigned until Cid says otherwise.
