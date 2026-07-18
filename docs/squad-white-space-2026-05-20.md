# Squad Code white space: 2026-05-20

_Companion to `docs/rip-these-apart-2026-05-20.md`. The rip docs cover what to borrow from competitors. This doc covers what nobody in the field has built yet that Squad's positioning makes obvious, vetting-purpose, local-first, multi-provider, tamper-evident audit, single-process simplicity._

The throughline: most ideas here exist nowhere in the batch (aider, cline, codex, gemini-cli, nanocoder, opencode) and exist nowhere in the prior batch (DeepSeek-TUI) either. A few are obvious-in-hindsight extensions of things Squad already has. None are speculative architecture changes, each one fits inside Squad's current `engine/providers/tools/permissions/sessions/audit/hooks/yolo` boundary.

Grouped by what makes them uniquely Squad-shaped: vetting-purpose features, audit-chain leverage, multi-provider native features, local-model first-class features, unification opportunities, and safety leverage Squad's posture enables.

## 1. Vetting-purpose features

Squad's stated reason for existing (per memory) is "local-model agent harness for vetting Ollama models against real tool-use loops." The six rips are all built for the inverse purpose, pick one model and ship a product around it. Nobody else has these because nobody else needs them.

### 1.1 Deterministic agent-loop replay against a different model

Squad has JSONL transcripts plus a `prev_hash` audit chain. Take any past session and re-execute its exact tool sequence against a different model:

```
squad replay <session-id> --model claude-opus-4-7
```

The loop reads each user/assistant turn, deterministically runs the tools the original session ran (against pinned outputs from the audit chain, OR fresh outputs at the user's choice), and asks the new model to produce its own assistant turn at each step. Output is a JSONL diff session at `~/.squad/replays/<original-id>-<model>.jsonl` plus a markdown side-by-side at `--show`.

This is the vetting workflow realized. Today the user has to manually rerun prompts in two terminals. With replay it's one command and the diff is structured. No other agent in the batch has the audit-chain infrastructure to make this safe; Squad does.

**Cost:** ~400 LOC. The hard part is "rerun tools or use frozen outputs", both modes need to exist (frozen for pure-cognition comparison, rerun for true behavioral comparison).

### 1.2 Provider-rotation eval mode

```
squad eval "summarize src/engine/loop.ts and propose three improvements" --rotate-providers
```

Runs the same prompt against every model in the active catalog (or a `--profile vetting` subset), captures JSONL transcripts to `~/.squad/evals/<timestamp>/`, generates a markdown comparison report with per-model token usage, tool-call counts, time-to-first-token, time-to-completion, and (if `--judge <model>` is set) a final judging pass that ranks outputs.

The eval is one-shot, deterministic-ish (seed-pinned where the adapter supports it), and produces an artifact a human can review. Nobody in the batch ships this as a built-in, they all expect you to write your own benchmark harness. Squad's vetting purpose means this is a first-class command, not a sidecar.

**Cost:** ~250 LOC plus a results-renderer. Reuses the existing usage-ledger and audit chain.

### 1.3 Per-model, per-tool success-rate surfacing

Squad's audit chain already records every tool call, tool result, and whether subsequent steps reversed the change (e.g., `Edit` followed by `Edit`-back-to-original within N turns). Surface this:

```
squad usage --by tool,model
```

Output: `gpt-5.1 ran Edit 142 times, 89% landed (16 reverted within 3 turns)`. `deepseek-chat ran Edit 78 times, 76% landed (19 reverted)`. `qwen2.5-coder ran Edit 41 times, 51% landed (20 reverted)`.

The data already exists in `audit.db`; the query and renderer don't. This is the empirical answer to "which model should I use for refactors in this project?", and the answer can be different per-project because the audit chain is per-cwd. Vetting purpose meets persistent state.

**Cost:** ~150 LOC of SQL plus a CLI subcommand. The "revert detection" heuristic is the load-bearing part (same file path, opposite edit, within N turns = candidate revert).

### 1.4 Deterministic local-model seeds

Ollama's API honors `seed: N`. The `llm-local` adapter doesn't expose it. Add `--seed N` to the CLI and `seed` to catalog entries. Pin seeds in eval/replay modes so re-runs are bit-identical.

Cloud providers mostly don't honor seeds well (OpenAI's is best-effort, Anthropic doesn't have one). Squad's local-first thesis means local is the primary case, and local supports it. Surface it at the right layer.

**Cost:** ~30 LOC. The catch is making sure the seed flows through the canonical event stream to the adapter, not just the CLI flag.

### 1.5 "Pin this output" affordance during interactive REPL

In the REPL, after a tool returns a particularly interesting result (good or bad), the user types `/pin` and the next provider switch / replay / eval will use that exact tool output for the same call instead of re-executing. Lets the user say "I want to see how Claude reasons about *this specific* file content the model just read."

Sits on top of the artifact storage already in `src/sessions/artifacts.ts`. The pin is just an audit-chain row that says "future replays of <call-id> should use frozen output."

**Cost:** ~80 LOC.

## 2. Audit-chain leverage

Squad has `prev_hash`-chained SQLite audit. Nobody else in the batch does tamper-evidence. The corollary nobody seems to have noticed: the audit chain is also the best queryable history of "what did the agent actually do" and Squad isn't surfacing that.

### 2.1 Audit query language

```
squad audit query "tool:Shell AND command:'git push' AND decision:allow"
squad audit query "session:<id> AND prev_hash_invalid:true"
squad audit query "tool:Edit AND path:src/engine/* AND model:gpt-5*"
```

A small DSL over the audit rows. Returns matching rows with session/turn anchors so the user can `squad sessions show <id> --turn <n>` to drill in.

The chain validation already exists in the session store. Surface it as a CLI command. Also: a `--integrity` flag that walks the entire chain and reports any breaks. This is forensic infrastructure that nobody else has because nobody else has the chain.

**Cost:** ~300 LOC (parser is the bulk). Don't ship a full SQL surface, keep the DSL tight to what's actually useful.

### 2.2 Cross-session "have I done this before" lookup

Before answering a prompt, check the audit chain for past prompts with high similarity in the same cwd. If found, surface a `/similar` slash command result: "you asked something close to this on 2026-04-12, the agent's answer was X, the conclusion was Y." Optional, gated by `~/.squad/settings.json: similar_lookup: true`.

This is the local-first equivalent of "search past chats" that hosted agents do server-side. Squad has the data on disk in SQLite already. Embedding lookup against a local model (or even TF-IDF for cheap shape) makes it work without network calls.

**Cost:** ~400 LOC for the embedding-or-TF-IDF index, the slash command, the UI surfacing. Skip until a user actually asks for it, but the audit chain already supports it, no new persistence layer needed.

### 2.3 Permission decisions as policy training data

Every time the user grants `[a]lways for this session` or `[p]ermanently for this project`, the audit chain records it. After N decisions, propose a consolidated rule: "you've allowed `Shell: npm run *` 12 times in this project; want to permanently allow `Shell: npm run *`?" Surface as a non-blocking notification at session end.

Nobody else does this because their permission models are either flat allowlists (no consolidation opportunity) or per-call YES-this-once (no persistent shape). Squad's specificity-sorted pattern rules naturally consolidate.

**Cost:** ~150 LOC plus the propose-rule heuristic.

## 3. Multi-provider native features

Squad is genuinely multi-provider, four adapter kinds, real catalog-driven dispatch. The rest of the batch is either single-vendor (codex, gemini-cli) or "many providers, each one's own hand-written file" (cline, opencode, nanocoder). Multi-provider as a real property opens features the others can't ship.

### 3.1 Cross-provider conversation handoff

Mid-session switch from Anthropic (`llm-message`) to OpenAI Responses (`llm-response`) and the conversation history needs translation: Anthropic's `tool_use` blocks → Responses' `function_call` items, `tool_result` user-role blocks → Responses' `function_call_output`. The thinking blocks need stripping (Responses' reasoning state doesn't transfer). The cache-control markers need removing.

Today `/provider` switch mid-session works for cases where the conversation hasn't had tool calls yet. After tool calls, the next request shape is provider-specific. A formalized translation pass per-adapter-kind-pair would make switch-anytime real:

```
src/providers/translate/
  llm-chat-to-llm-message.ts
  llm-chat-to-llm-response.ts
  llm-message-to-llm-chat.ts
  ...
```

Six pairs for four adapter kinds. Translators are pure functions over the canonical event stream, input: history in one shape; output: history in destination shape.

**Cost:** ~600 LOC across six translator pairs. The hardest pair is `llm-response → anything-else` because reasoning blocks have to be either preserved (Anthropic's `thinking`) or dropped (`llm-chat`).

### 3.2 Provider failover chains in the catalog

```json
{
  "id": "primary-with-fallback",
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "adapter": "llm-message",
  "fallback": [
    { "provider": "openai", "model": "gpt-5.1", "adapter": "llm-response" },
    { "provider": "ollama", "model": "qwen2.5-coder", "adapter": "llm-local" }
  ]
}
```

When the primary fails (5xx, rate-limit, network unreachable), the loop tries the fallback chain automatically. With cross-provider handoff (3.1), the conversation translates as it falls back. The user sees a one-line note: "primary failed (rate-limit); switched to gpt-5.1."

Codex has nothing like this (Responses-only wire, no failover). Cline has retry per-provider but not cross-provider chains. Squad's catalog shape is the right place for this, declared per-catalog-row, not per-call.

**Cost:** ~200 LOC plus the integration with retry/timeout policy already in the engine.

### 3.3 Catalog-driven prompt-format hints

Add a `prompts` field to catalog entries:

```json
{
  "id": "gpt-5.1",
  "provider": "openai",
  "model": "gpt-5.1",
  "adapter": "llm-response",
  "prompts": {
    "preferred_edit_tool": "ApplyPatch",
    "tool_call_style_hint": "Use parallel tool calls when independent.",
    "extra_system_addendum": "When asked to refactor, prefer ApplyPatch over many small Edits."
  }
}
```

Nanocoder ships per-model system-prompt variants as `.ts` files. Squad can do it data-driven from the catalog, the system prompt builder reads the active catalog row's `prompts` and injects the right hints. Switching models switches hints automatically.

**Cost:** ~100 LOC for the catalog schema extension + the prompt-builder integration. Per-model hints are user-editable in `~/.squad/models.json` without a code change.

### 3.4 Per-adapter capability negotiation surfacing

```
squad capabilities --model claude-opus-4-7
```

Output: prints what the active adapter declares for that model, tool_use, cache_control, reasoning, structured output, vision, parallel tool calls, max context window, max output tokens, supported tool-call shapes. Cross-reference with the actual loop's behavior: "this model supports cache_control, Squad's adapter has it implemented, last 5 turns used cache." Vs: "this model supports vision, Squad's Read tool returns text only, vision is unused."

Tells the user (and Cid for vetting) where capabilities are wasted. Nobody else surfaces this because nobody else has a structured capability layer.

**Cost:** ~80 LOC.

## 4. Local-model first-class features

Squad's `llm-local` is genuinely first-class. The local-first thesis (from CLAUDE.md global instructions) plus the vetting purpose plus the explicit Ollama-on-Starforge-Voyager setup means local-model UX should get features cloud-first agents can't justify.

### 4.1 Auto-trim system prompt for small models

Catalog entries already declare `context_window`. Add `parameters` (param count) and `recommended_prompt_profile`:

```json
{
  "id": "qwen2.5-coder-3b",
  "provider": "ollama",
  "model": "qwen2.5-coder:3b",
  "adapter": "llm-local",
  "context_window": 32768,
  "parameters": "3B",
  "recommended_prompt_profile": "nano"
}
```

Squad's system prompt has sections (identity, tools, security, output styles, repo map). Each section knows its token cost. When the active model's `recommended_prompt_profile` is `nano`, drop everything except identity + minimum tool docs + one-line security note. When it's `minimal`, keep the core sections but skip verbose explanations. When `full` (default for >=7B cloud), ship everything.

Nanocoder ships tool profiles. Squad would ship full prompt-section profiles, driven from the catalog. The local-first thesis means small-model UX is the primary case, not an afterthought.

**Cost:** ~250 LOC including the per-section token-cost annotations.

### 4.2 Model-warmup primitive for local

When the REPL starts with an Ollama model, the first request pays a multi-second warmup cost while the model loads into VRAM. After idle, the model unloads. Squad could ship `/warm` to send a 1-token noop request, and `--keep-warm <minutes>` to issue periodic 1-token requests during idle.

Aider does cache-keepalive pings against Anthropic prompt cache. The local equivalent is keeping the model in VRAM. Different mechanism, same shape. Nobody in the batch ships this for local because nobody in the batch has local as the primary case.

**Cost:** ~60 LOC.

### 4.3 Local-only mode flag

`--local-only` refuses to call any cloud provider for the entire session. The flag is enforced at the adapter layer, not just the catalog. Useful for: air-gapped use, "I'm on a flight," "I'm explicitly testing local capability," compliance scenarios where the user must prove no data left the machine.

The audit chain already records every request's provider. Adding a session-level flag that refuses anything outside `llm-local` is a 20-line guard. The audit chain proves compliance after the fact.

**Cost:** ~40 LOC including the audit-side proof query.

### 4.4 Local-model context-window guardrail in the REPL

The Ink REPL status line shows turn count and token usage. Add a per-turn percentage-of-context-window utilized indicator with color: green <60%, yellow 60-85%, red >85%. Auto-compact triggers at the model's `context_window * 0.75` (catalog-driven, not hardcoded). This is the gemini-cli graph pipeline's first-cousin idea applied at status-line resolution.

Nanocoder shows context utilization in `/usage` but not in the status line. Real-time pressure visibility changes how the user paces explicit `/compact`.

**Cost:** ~50 LOC for the status-line widget + ~40 LOC for the catalog-driven compact threshold.

## 5. Unification opportunities

Squad's simpler shape lets it unify things that the larger codebases keep separate.

### 5.1 Skill ↔ subagent ↔ output-style as one extension surface

Already named as the convergence in the rip synthesis. The fuller version: one loader, one frontmatter parser, one cascade rule (built-in < user < project), one extension model. Frontmatter `kind: skill | subagent | output-style | tool | command` distinguishes behavior. All live under `~/.squad/<kind>/*.md` and `./.squad/<kind>/*.md`.

An entry's frontmatter declares whether it activates on slash-command, on trigger phrase, on `mode: subagent` selection by `task` tool, or as a prepended system-prompt block (output-style). The loader doesn't care which, it loads the frontmatter, indexes by kind, and the relevant subsystem (REPL slash dispatcher, agent loop, subagent runner, system-prompt builder) reads its kind's index at the right time.

Nobody in the batch can do this cleanly because they grew skills first, then bolted on subagents, then bolted on output-styles separately. Squad has the chance to ship them unified from the start.

**Cost:** ~400 LOC of refactor on existing code. The biggest win is downstream: every future extension type ("commands," "tools," "memories") slots into the same loader without new infrastructure.

### 5.2 Hook → tool registration bridge

Hooks fire at session/tool/prompt boundaries. What if `SessionStart` hooks can *register tools* available for the rest of the session?

```yaml
# ~/.squad/hooks/register-jira-tool.yaml
event: SessionStart
type: command
command: scripts/register-jira-tool.sh
registers_tools:
  - name: jira_search
    schema_path: schemas/jira-search.json
    handler: scripts/jira-search.sh
```

The hook returns a tool-registration record; Squad adds the tool to the registry for the session; subsequent model turns can call `jira_search`. The handler is the hook's script.

This is custom-tools (nanocoder pattern) plus hooks (Squad pattern) collapsed into one programmable surface. Users who want to extend Squad write one thing (a script + a YAML descriptor), not two parallel systems.

**Cost:** ~250 LOC. The hard part is the tool-registration permission boundary, hook-registered tools must default to `permission: ask` and can't escalate themselves.

### 5.3 Memory as a tool, not a side channel

Cid's global CLAUDE.md describes an auto-memory system: persistent notes about user role, feedback, project state, references. Today that's a parallel system to skills.

Unify: memory is one of the loader's kinds (`kind: memory`). The agent has a `Memory.read(topic)` and `Memory.write(topic, content, type)` tool with explicit permissions. Memory writes go through the audit chain (`prev_hash`-linked). Memory reads pull in markdown frontmatter-tagged files from `~/.squad/memory/<project>/` and `~/.squad/memory/global/`.

The advantage over hidden auto-memory: the agent can read/write only when it explicitly calls the tool (auditable), the user can grep/edit memory files directly (transparent), and memory is part of the skill loader so the same cascade rules apply (project shadows global). Squad's audit chain proves the memory writes happened.

**Cost:** ~200 LOC for the tool + ~50 LOC for the loader extension. Significant UX shift from passive-memory to active-memory; should ship behind a `experimental.active_memory: true` flag at first.

### 5.4 YOLO checklist as structured progress, not flat markdown

Today the YOLO checklist is markdown appended to the system prompt verbatim. The agent reads it, the user reads it, but neither side has structure.

Parse the markdown for `- [ ]` items. The status line shows "YOLO: 2 of 7 checklist items complete." The agent has a `MarkChecklistDone` tool to mark items. Completion of all items triggers a session-end summary + audit-chain entry "YOLO checklist completed."

YOLO becomes a rail-guided autonomous run with visible progress, not just an armed mode. Nobody in the batch has anything close, cline's yolo is "approve all," nanocoder's yolo is "approve all," codex's `--dangerously-bypass-approvals-and-sandbox` is "approve all," gemini-cli's yolo is "approve all." Squad already differentiates with the checklist gate; making it structured is the next obvious step.

**Cost:** ~150 LOC including the markdown parser + status-line widget + audit hook.

## 6. Safety leverage from Squad's posture

### 6.1 Typed UntrustedContent (not string-wrapped trust markers)

Squad wraps tool output in trust markers and tells the model not to follow tool-output instructions. The wrapper is currently a string prefix. Make it a structural type:

```ts
type ToolOutput =
  | { kind: "trusted_text", text: string }
  | { kind: "untrusted_text", text: string, source: string }
  | { kind: "untrusted_binary", bytes: Uint8Array, mime: string, source: string }
  | { kind: "untrusted_image", bytes: Uint8Array, mime: string, source: string }
```

Each adapter renders the untrusted types into the destination provider's strongest available marker:
- Anthropic: wrap in a system-style `<tool_result>` block + structural `<untrusted_data>` markers around the content.
- OpenAI Responses: use `input_text` parts with prefix markers.
- OpenAI Chat: same as Responses but flatter.
- Ollama: same as Chat plus an explicit prompt-prefix repeating the untrusted-data rule for weaker models.

Plus: image content from Read of an image file gets ingested natively where the provider supports it. Right now Squad's Read returns text only.

Nobody in the batch separates trust types structurally, they all do string-prefix marker. Squad's audit chain plus per-adapter rendering makes typed UntrustedContent feasible.

**Cost:** ~500 LOC across adapters + ~150 LOC for the Read-image path. Significant refactor but the type safety alone catches a class of prompt-injection paths at compile time.

### 6.2 Pre-flight tool cost estimation

When the model proposes `Shell: find / -name '*.log'`, Squad has all the info to estimate: filesystem walk depth, expected output size, expected runtime. Before executing, the permission prompt could include the estimate:

```
[Shell] find / -name '*.log'
  Estimated: walks ~2.4M files, output likely >50MB, expected runtime >30s
  Allow / Deny / Allow with timeout / Cancel?
```

Cheap estimates for specific known commands: `find <path>` (walk count from `du -d 0` of path), `grep <pattern> -r <path>` (file count × avg size), `ls <path>` (entry count), `rm -rf <path>` (entry count + size warning). Refuse to estimate for arbitrary commands but still flag obvious risk patterns (`/` as a path, `--force`, `*` at fs root).

This is preventive, not reactive. Today every agent has timeout/truncate on the back end. Pre-flight pushes the decision to the user with information. Squad's permission system is the right hook for this.

**Cost:** ~300 LOC for the estimator + integration into the permission prompt.

### 6.3 Mid-turn rollback with steering injection

When the model proposes a tool call and the user denies, currently the model gets "denied" as a tool result and tries to recover. Better:

```
[Shell] rm -rf node_modules/
[d]eny / [a]llow / [r]eject and steer:
> r
Steering message: "don't delete it, just check what's in there"
```

The denied call is rolled back from the conversation (with audit-chain trace), the steering message goes in as a user message, the model retries with explicit guidance. Today the user has to wait for the model to give up, then type a correction. Mid-turn rollback + steer is one keystroke.

**Cost:** ~200 LOC. The hard part is the audit-chain entry (the rolled-back call IS recorded with a `superseded_by` link to the steering message, so the chain remains complete).

### 6.4 Tool result diff on identical-call repeat

Squad already aborts the loop on three consecutive identical tool calls (canonical name + args). Before aborting, do one more thing: diff the three results. If the results differ ("the file changed between calls" / "command output is non-deterministic"), the abort is wrong, the model is correctly verifying. If the results are identical, the abort is right.

When the abort is right and the results are identical, the loop-abort message to the model includes the diff: "you called X three times with identical args and got identical results, which means [scenario]." The model gets actionable feedback instead of "I gave up."

**Cost:** ~100 LOC for the diff + the message rewrite.

### 6.5 Permission rule diff before persist

When the user picks `[p]ermanently for this project`, Squad widens the scope automatically (shell verb prefix, path parent dir). Today this is silent, the user sees the prompt, picks `[p]`, and a new rule lands in `.squad/settings.json` without showing the broadened shape.

Show the diff at prompt time:

```
[Shell] npm run test
[p]ermanently for this project would add the rule:
  + permissions.rules.Shell["npm run *"] = "allow"
Continue?
```

The user sees the actual rule that's going to be written. If they want a tighter rule (`npm run test` literal, not `npm run *`), they can edit it inline before persist.

**Cost:** ~80 LOC.

## 7. Smaller obvious things

Quick hits that don't deserve a section but should land in the backlog:

- **`squad doctor`**, bundled diagnostic command that runs: catalog validation, audit-chain integrity check, hooks-config syntax check, skills/output-styles parse, write permission check on `~/.squad/`, network probe to each configured cloud provider, local-provider HTTP probe to Ollama if configured. Output is a markdown report. Codex has `codex doctor`-like commands; Squad doesn't. Should.

- **`squad audit show <session-id>`**, pretty-print one session's audit rows with chain validation status. Surfaces the existing chain as a debug tool.

- **`--cwd <path>` flag**, Squad's cwd is always `process.cwd()` today. Adding `--cwd <path>` lets headless invocations target a specific directory without `cd && squad`. Affects audit-chain partitioning, project permissions, session resume scoping.

- **`squad sessions tag <id> <tag>`**, tag sessions for later filtering (`squad sessions list --tag bugfix`). Trivial SQLite addition. Codex has named threads; this is the more general shape.

- **`/scratch` slash command**, opens a temp file in `$EDITOR`, captures the result as the next user message. Useful for typing long structured prompts without fighting the REPL's line editing.

- **`/diff` slash command**, shows the diff between the current state of cwd and the cwd state at session-start (captured via `git diff` if it's a repo, or a manifest if not). Useful at session end: "what did the agent actually change?"

- **`/replay-last <model>`**, REPL shortcut for the replay command from section 1.1, scoped to the current session's last turn. Type a prompt, see the answer, then `/replay-last claude-opus-4-7` to see how Claude would have answered the same thing.

- **`SQUAD_PROFILE=ci` env shorthand**, sets a bundle of CI-friendly defaults: `--print` mode, deterministic seeds, no tab-title updates, JSON output format, `--cwd $CI_PROJECT_DIR`. One env var, one shape.

- **Audit chain export to signed bundle**, `squad audit export <session-id> --sign` produces a portable bundle (jsonl + manifest + signature) that proves the session ran exactly as recorded. Local-first answer to "I need to prove what the agent did for an incident review." Sign with a user-owned key, not a Squad-owned one.

- **Provider request inspector**, `SQUAD_INSPECT=1` writes the literal HTTP request and response for every provider call to `~/.squad/inspect/<session>/<turn>.json` (with API keys redacted). Replaces the need to set up `mitmproxy` for "what's actually on the wire." Codex has `--debug`-style verbose logging; this is the file-on-disk version.

- **`/dry-run`**, before sending the next assistant turn, show what the system prompt + history + tools + user message look like assembled. Doesn't send to the provider. Lets the user verify the model is going to see what they expect. Aider has `--verbose` which approximates this; an interactive `/dry-run` is cleaner.

- **REPL undo for the last user message**, `Ctrl+Z` in the prompt input removes the previous turn from history. Sometimes a user fires a prompt and immediately wishes they hadn't. Today they have to `/clear` or `/compact`. One-turn undo is a 50-LOC addition.

## Prioritization

If forced to rank by leverage-per-LOC and how directly each item serves Squad's vetting purpose:

**Build for v1.2 (high leverage, fits existing scope):**
1. Deterministic replay (1.1), vetting purpose realized as a single command
2. Per-model per-tool success-rate surfacing (1.3), empirical answer to "which model"
3. Auto-trim system prompt for small models (4.1), local-first thesis applied
4. Local-model context-window guardrail in status line (4.4), small UX win, pairs with auto-compact
5. Permission rule diff before persist (6.5), small, removes a real footgun
6. YOLO checklist as structured progress (5.4), extends a Squad differentiator

**Build for v1.3 (more LOC, more architectural reach):**
7. Cross-provider conversation handoff (3.1), unlocks `/provider` mid-session honestly
8. Provider failover chains in catalog (3.2), pairs with handoff, makes local-as-fallback real
9. Skill + subagent + output-style unification (5.1), pays off as soon as v1.2's agents land
10. Provider-rotation eval mode (1.2), high vetting value once replay lands
11. Audit query DSL (2.1), turns audit from passive log to active tool
12. Mid-turn rollback with steering (6.3), UX leap, doable inside existing engine

**Build post-v1.3 (bigger refactor, more user pull required):**
13. Typed UntrustedContent (6.1), significant adapter refactor, security payoff
14. Pre-flight tool cost estimation (6.2), preventive, depends on heuristic quality
15. Memory as a tool (5.3), depends on user demand
16. Hook → tool registration bridge (5.2), depends on user demand for custom tools

**Smaller items to slot opportunistically:** `squad doctor`, `/diff`, `/scratch`, `/dry-run`, REPL undo, deterministic local seeds (1.4), local-only mode flag (4.3), model-warmup (4.2), catalog-driven prompt hints (3.3), capability surfacing (3.4), audit export bundle, `--cwd` flag, session tags, `SQUAD_INSPECT` env, `SQUAD_PROFILE=ci`.

## Bottom line

Most of what makes Squad distinct compared to the rest of the agent-CLI space is already shipped (tamper-evident audit, YOLO with rails, provider-neutral catalog, local-first defaults). The unshipped white space is what those distinctives *enable* that nobody else can ship: replay against any past session, per-model empirical success metrics, deterministic local-model seeds, cross-provider conversation handoff, audit-as-query, structured untrusted content with per-adapter rendering. None of these require new architectural concepts. They all live inside the existing module boundaries. They all serve Squad's actual purpose, vetting how local models behave under real tool-use loops, better than anything in the six rip targets does, because the six rip targets aren't built for that purpose.

The single highest-leverage white-space feature is **deterministic replay** (1.1), because it turns Squad from "a coding agent that happens to support local models" into "a tool for measuring local-model agent behavior", and that tool is the actual product Cid is building. Everything else in this doc is incremental improvement; replay is the differentiator.
