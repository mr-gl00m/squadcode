# Rip-apart: nanocoder

_Target: `N:\proj_ai_squad_code\.rnd\nanocoder-main\`, `@nanocollective/nanocoder` v1.26.1, MIT, Nano Collective._

## What it is

TS/Node 22+, pnpm workspace, ESM, React 19 + Ink for the REPL, Vercel AI SDK v6 as the provider substrate. Distributed via npm (`npm install -g @nanocollective/nanocoder`), Homebrew (`Formula/nanocoder.rb` pinning `node@22`), and a Nix flake (`flake.nix` overriding nixpkgs's bundled pnpm 10 to pnpm 11 to match the `packageManager` field). One top-level workspace plus a `plugins/vscode/` package that builds a `.vsix`. README pitches it as bringing "the power of agentic coding tools like Claude Code and Gemini CLI to local models or controlled APIs like OpenRouter", the open-source local-first peer. Sells provider breadth (Ollama, OpenRouter, GitHub Copilot via OAuth, ChatGPT/Codex via OAuth, Anthropic, Google, MLX, MiniMax, Kimi, Mistral, Poe, GitHub Models) and ergonomics (Ink UI, VS Code companion extension, four development modes, custom commands, custom tools, subagents, scheduler, MCP, LSP). 99% TypeScript, 5,637 test cases across 284 spec files (`benchmarks/baseline.json:78-80`). Active project, released v1.26.1 with the rip targeting v1.20 → v1.26 changelog spanning the last quarter.

## Architecture at a glance

### Entry and topology

- `source/cli.tsx:1-321` is the entrypoint. Fast paths for `--version`, `--help`, `codex login`, and `copilot login` print and exit before any heavy import (`cli.tsx:28-68, 236-285`). The agent app is dynamically imported only in `main()`, `cli.tsx:70-82` does `Promise.all([import('ink'), import('@/app'), …])` to keep the help/version paths sub-3-module (`baseline.json:14-19`).
- V8 compile cache toggled on at `cli.tsx:16-20` via `nodeModule.enableCompileCache()` when running on Node 22.8+. Cheap, big win on warm starts.
- `--plain` flag (`cli.tsx:200-233`) routes to an Ink-free shell (`source/plain/shell.ts`) for CI / non-TTY / piped use. Auto-detects via `process.env.CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`, `CIRCLECI`, `JENKINS_URL`, or `!process.stdout.isTTY`. `--no-plain` forces Ink.
- The top of `cli.tsx` deliberately has zero static imports of app code, there's a load-bearing comment about it (`cli.tsx:5-12`).

### Source directory map

`source/` is large (over 60 top-level directories). The shape is React-hook-driven, not classical layered:

- `source/cli.tsx`, entry.
- `source/app/`, `App.tsx` plus `app/utils/`, `app/prompts/sections/`, `app/hooks/` orchestrators. The single React tree.
- `source/hooks/`, `useAppState.tsx` is the central state container (50+ state variables per their own CLAUDE.md). Other hooks (`useChatHandler`, `useToolHandler`, `useModeHandlers`, `useAppHandlers`) receive setters from it.
- `source/hooks/chat-handler/`, the agent loop. `conversation/conversation-loop.tsx:106` is `processAssistantResponse`, the recursive stream-collect-execute-recurse function. `conversation/tool-executor.tsx` runs tools. `state/streaming-state.ts` and `utils/tool-filters.ts`, `utils/message-helpers.tsx` are the supporting pieces.
- `source/ai-sdk-client/`, wrapper over `ai` (Vercel AI SDK v6). `providers/provider-factory.ts:74` is the discriminated-union `createProvider` that dispatches to `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`, or `@ai-sdk/openai-compatible` via dynamic `await import(...)`. `chat/chat-handler.ts` + `chat/streaming-handler.ts` are the streaming layer. `converters/message-converter.ts` + `converters/tool-converter.ts` normalize message shapes.
- `source/tools/`, built-in tools as `.tsx` files. `tool-manager.ts:63` is the `ToolManager` class. `tool-registry.ts:23` is the `ToolRegistry` that holds entries. `tool-profiles.ts` defines `full`, `minimal`, `nano` budgets. `file-ops/`, `git/`, `tasks/` group subsets.
- `source/tool-calling/`, the XML / JSON / `<function=...>` fallback parsers for models without native tool calling.
- `source/commands/`, built-in slash commands, lazily registered. `commands/lazy-registry.ts` is the dispatch table.
- `source/custom-commands/`, user markdown commands from `.nanocoder/commands/` (project) and `~/.config/nanocoder/commands/` (personal). `parser.ts` reads YAML frontmatter + body; `loader.ts:24` does name + alias + namespace + auto-injection via tags/triggers/relevance score.
- `source/custom-tools/`, user markdown _tools_ (different from commands). `.nanocoder/tools/*.md` files with YAML frontmatter declaring JSON-Schema-like parameter types plus a shell-script body. `loader.ts`, `parser.ts`, `schema-builder.ts`, `template.ts`, `handler.ts`, `build-tool.ts` together build a `ToolEntry` registered into the same registry as built-ins.
- `source/subagents/`, markdown-defined subagents from `.nanocoder/agents/` and `~/.config/nanocoder/agents/` with two built-ins (`built-in/explore.md`, `built-in/reviewer.md`). `subagent-executor.ts:45` runs them with `MAX_SUBAGENT_DEPTH = 2` and `MAX_CONCURRENT_AGENTS = 5`.
- `source/schedule/`, cron-driven autonomous runs. `croner` library. `.nanocoder/schedules/*.md` files. `scheduler` mode disables `ask_user` and `agent`.
- `source/mcp/`, `MCPClient` over `@modelcontextprotocol/sdk` with stdio / WebSocket / streamable-HTTP transports. `transport-factory.ts` validates server configs.
- `source/lsp/`, full LSP client (`lsp-client.ts`, `lsp-manager.ts`, `protocol.ts`, `server-discovery.ts`). Auto-discovers servers for TS, Python, Rust, Go, Deno, GraphQL, Docker, Markdown.
- `source/session/`, `session-manager.ts:87` with atomic temp-and-rename writes, UUID v4 session ID validation as path-traversal guard, and a `Promise<void>` chain `indexWriteLock` to serialize index updates.
- `source/services/`, `checkpoint-manager.ts:22` (full conversation + file-snapshot checkpoints under `.nanocoder/checkpoints/<name>/`), `file-snapshot.ts`, `bash-executor.ts`, `subagent-events.ts` (the event channel for live `AgentProgress` rendering).
- `source/usage/`, token + cost ledger in `~/.{config,...}/nanocoder/usage.json` with a one-shot migration from config dir to app-data dir (`storage.ts:34-78`).
- `source/auth/`, OAuth device flow for GitHub Copilot and ChatGPT/Codex.
- `source/wizards/`, interactive setup flows (`provider-wizard.tsx`, `mcp-wizard.tsx`, plus shared `base-config-wizard.tsx`, `validation.ts`).
- `source/init/`, `/init` command machinery: framework detector, language detector, file scanner, project analyzer, AGENTS.md template generator.
- `source/plain/`, non-Ink CLI shell (`shell.ts`, `conversation.ts`, `writer.ts`).
- `source/vscode/`, server side of the VS Code companion. Paired with the standalone `plugins/vscode/` extension package that ships as `assets/nanocoder-vscode.vsix`.
- `source/config/`, `index.ts:1-120` for `getAppConfig()`, `mcp-config-loader.ts`, `preferences.ts`, `themes.ts`, `paths.ts`, `env-substitution.ts`, `tune.ts`, `nanocoder-tools-config.ts`, `codex-credentials.ts`, `copilot-credentials.ts`, `validation.ts`. Configs live in `agents.config.json` (project) and platform config dirs (macOS Library Preferences, Linux XDG, Windows APPDATA). Env vars expand `$VAR`, `${VAR}`, `${VAR:-default}` (`env-substitution.ts`).
- `source/markdown-parser/`, `source/components/`, `source/tokenization/`, `source/model-database/`, `source/test-utils/`, `source/types/`, `source/utils/`, supporting subsystems.

### Agent loop

`source/hooks/chat-handler/conversation/conversation-loop.tsx:106` is the loop. Shape:

1. `client.chat(messages, tools, callbacks, signal, modeOverrides)` runs the stream with `onToken` and `onReasoningToken` (`conversation-loop.tsx:223-238`). Reasoning is rendered as a collapsible `Thought` block above the response.
2. `<think>` tags are stripped unconditionally via `stripThinkTags()` for providers that stream reasoning as raw text (Kimi, GLM, Qwen on generic OpenAI-compat).
3. Tool-call extraction has three branches (`conversation-loop.tsx:254-276`):
   - `result.toolsDisabled`: model doesn't support native tools, parse `parseToolCalls()` against text.
   - native tool calls present: trust the SDK, but run `stripEmbeddedToolCallText()` to strip "Ghost Echo", the case where a model emits both a native tool call AND a text echo of it.
   - native enabled but no `tool_calls`: still parse text for XML/JSON. Open-weights models marketed as native-capable regress and emit text tool calls; without this fallback the agent stalls.
4. Malformed-tool retry cap at `MAX_MALFORMED_RETRIES` (`conversation-loop.tsx:296`). Without this, a stuck model loops forever and OOMs Node.
5. Empty-response retry cap at `MAX_EMPTY_TURNS`. Live counter is coalesced so consecutive empties don't stack up retry boxes.
6. Auto-compact runs between turns (`conversation-loop.tsx:455-495`). The compressed message array is reassigned to a `let` because recursive calls must use the compressed copy, there's a load-bearing comment explaining why.
7. Tools partition into `toolsToExecuteDirectly` and `toolsNeedingConfirmation`. Direct tools run in parallel via `Promise.all` (`conversation-loop.tsx:598`). Confirmation tools are pushed to `onStartToolConfirmationFlow`.
8. AI SDK execute functions are stripped from tools via `getNativeToolsWithoutExecute()` (`tool-registry.ts:197`). The SDK gets schemas and descriptions for the model but cannot auto-execute, nanocoder evaluates `needsApproval` itself and splits.

### Provider dispatch

`source/client-factory.ts` creates clients via `createLLMClient(provider?)` and routes through `source/ai-sdk-client/`. The actual SDK selection is in `source/ai-sdk-client/providers/provider-factory.ts:74`:

```
TaggedProvider =
  | { kind: 'chatgpt-codex', provider: OpenAIProvider }
  | { kind: 'github-copilot', provider: OpenAIProvider }
  | { kind: 'openai-compatible', provider: OpenAICompatibleProvider }
  | { kind: 'anthropic', provider: AnthropicProvider }
  | { kind: 'google', provider: GoogleGenerativeAIProvider }
```

Provider SDK packages load lazily, `provider-factory.ts:6-9` uses `import type` only, and each branch does `const {createAnthropic} = await import('@ai-sdk/anthropic')`. A session using only Anthropic never loads the Google or OpenAI packages. Undici `fetch` is wrapped via `createUndiciFetch(undiciAgent)` (`provider-factory.ts:54-64`) so TLS config (`caCertPath`) flows through to every SDK, including Anthropic and Google that would otherwise use global fetch.

GitHub Copilot is the most involved branch (`provider-factory.ts:116-187`): OAuth device flow saves credentials, then a custom `copilotFetch` injects `Authorization: Bearer <token>` plus `Openai-Intent: conversation-edits` and `X-Initiator: agent` headers per request, with the underlying access token refreshed via `getCopilotAccessToken(credential.oauthToken, domain)`. ChatGPT/Codex (`provider-factory.ts:189-270`) is similar with the additional quirk that the Codex backend rejects any request without `store: false`, so the fetch wrapper parses the JSON body, sets that field, and re-stringifies.

OpenRouter gets two extra headers injected (`HTTP-Referer`, `X-Title`) for app-attribution (`provider-factory.ts:272-277`).

### Tool dispatch

`source/tools/tool-manager.ts:63` is the central `ToolManager`. It owns the `ToolRegistry`, the MCP client, and the custom-tool map. `getAvailableToolNames(tune, developmentMode, disabledTools)` is the single source of truth for tool filtering, applies tune profile, then `MODE_EXCLUDED_TOOLS` (`tool-manager.ts:29-57`), then user-configured `disabledTools` (`tool-manager.ts:201-208`). Plan mode strips every mutation tool plus task tools plus git mutation tools. Scheduler mode strips `ask_user` and `agent`.

`getEffectiveTools()` (`tool-manager.ts:217`) post-processes by stripping `needsApproval: false` from tools in the non-interactive allow list. Validators are wrapped into each tool's `execute` function at registration time (`tool-registry.ts:163-188`) so validation runs in all code paths, closes the v1.22.4 vulnerability where `needsApproval: false` tools bypassed validation.

Built-in tools (counted from `baseline.json:57`): 31.

### REPL

Ink-based React tree. `App.tsx` uses `useAppState` for state and `useAppHandlers` to orchestrate `useChatHandler`, `useToolHandler`, `useModeHandlers`. Deep components push chat messages without prop-drilling via the global `source/utils/message-queue.tsx`. Custom `TextInput` (not `ink-text-input`) supports Ctrl+W/U/K/A/E/B/F readline shortcuts (changelog v1.23.0). Title bar (`source/components/`), Bash progress, AgentProgress, AssistantReasoning, StreamingMessage, BootSummary are component types.

Modes are toggled with Shift+Tab and cycle `normal → auto-accept → yolo → plan` (`mode-context.ts`). Scheduler is internal, cron jobs use it but it doesn't appear in the user toggle.

### Plugin loading

There is no general "plugin loader." nanocoder has **four distinct extension surfaces**, each with its own loader:

- **Custom commands** (`source/custom-commands/loader.ts:24`): `.md` files under `.nanocoder/commands/` and `~/.config/nanocoder/commands/`. YAML frontmatter (description, aliases, parameters, tags, triggers, estimated-tokens, category, version, author, examples, references, dependencies). Directory-as-command supported (`commandname/commandname.md` + `resources/` subdir). Auto-injection via relevance scoring against user prompts (`loader.ts:289-344`).
- **Custom tools** (`source/custom-tools/`): `.md` files under `.nanocoder/tools/` and `~/.config/nanocoder/tools/`. YAML frontmatter declares `name`, `description`, `parameters` (typed: string / number / integer / boolean / array with enum / pattern / minLength / maxLength / min / max / items), `approval` (never / always / destructive), `read_only`, `timeout_ms` (default 30s, max 5min), `cwd`, `env`, `shell` (bash / sh). Body is a Mustache-flavored template (`template.ts:69`), `{{ name }}` substitutions are shell-quoted, `{{# name }}…{{/ name }}` sections gate on truthy args. The handler spawns the shell with the rendered script (`handler.ts:14-31`). Approval policy interlocks with plan/scheduler mode at `tool-manager.ts:188-198`.
- **Subagents** (`source/subagents/subagent-loader.ts:38`): `.md` files under `.nanocoder/agents/` and platform-specific personal dirs, plus two built-ins shipped in `source/subagents/built-in/`. YAML frontmatter declares name, description, model (literal or `inherit`), and tools (whitelist). Priority cascade: built-in < user < project.
- **MCP servers** (`.mcp.json`): stdio / WebSocket / HTTP, with `alwaysAllow` per-server. Decoded by `source/mcp/mcp-client.ts` + `transport-factory.ts`.

Note `pnpm-workspace.yaml` only lists `.` and `plugins/*`, the only workspace package is the VS Code extension. The "plugin architecture" everyone talks about is markdown files in dot-dirs, not a Node module loader.

## Features worth stealing

### Markdown custom tools: high-value steal

The big one. `source/custom-tools/` is a complete contract for letting users add LLM-callable tools without writing TS. A `.md` file with YAML frontmatter + a shell script body becomes a real tool with schema, validation, approval policy, timeout, cwd/env resolution, and registry membership, visible to the model alongside built-ins. Concrete pieces:

- **Schema synthesis** (`source/custom-tools/schema-builder.ts`): YAML param block → AI SDK `inputSchema` + a `ToolValidator` for parameter-level checks (enum, pattern, min/max, length).
- **Template rendering** (`source/custom-tools/template.ts:27`): `shellQuote()` wraps every interpolated value in POSIX-safe single quotes, escaping embedded single quotes. Arrays are joined with each element individually quoted. Sections like `{{# verbose }}--verbose{{/ verbose }}` collapse cleanly. This is the load-bearing safety property, `parameters: { path: { type: string } }` plus `cat {{ path }}` produces `cat '/etc/passwd; rm -rf /'` which the shell parses as a single argument.
- **Approval policy** with three settings (`never`, `always`, `destructive`) and a derived `read_only` flag. Plan mode requires `approval=never && read_only=true`. Scheduler mode requires `approval=never`. Tool-manager owns the policy gate (`tool-manager.ts:188-198`).
- **Project shadows personal** by name with one error per duplicate (`source/custom-tools/loader.ts:73-104`). Collisions with built-ins are skipped with an error so a misnamed tool can't ghost-replace `read_file`.
- **Built-in policy** in handler: always returns the captured output (never throws on non-zero exit) so the LLM can reason about exit codes itself, matches `execute_bash`'s shape. Throws are reserved for spawn errors and timeouts (`handler.ts:40-97`).

Squad's existing `Shell` tool plus a hand-written markdown-tool loader could ship this in a week. The schema + shell-quoting are the load-bearing parts; the rest is plumbing.

### Markdown subagents: concrete contract

`source/subagents/built-in/explore.md` shows the shape. YAML frontmatter declares `name`, `description`, `model` (literal model name or `inherit`), and `tools` (whitelist). Body is the system prompt. Loader cascade: built-in < user < project (`subagent-loader.ts:60-99`). Executor uses `MAX_SUBAGENT_DEPTH = 2` and `MAX_CONCURRENT_AGENTS = 5` (`subagent-executor.ts:36-39`).

Concurrent execution writes to per-agent slots in a progress map (`services/subagent-events.ts`) so the Ink UI can render N live `AgentProgress` panels at once. When `agentId` is supplied, `subagent-executor.ts:124-127` creates a fresh client per agent to avoid mutating the shared parent.

Compared to Squad's plan: depth=2 is one deeper than Squad's planned depth=1, but the same direction. Concurrency of 5 vs Squad's 4 is within noise. The model-override per subagent is exactly Squad's vetting-purpose hook. The contract, frontmatter + tools whitelist + body-as-prompt + cascade, is closer to ready-to-port than the rest of nanocoder.

### Benchmark harness: concrete, mostly portable

`benchmarks/measure.ts` is genuinely useful and surprisingly local-first-clean. The headline pattern is a custom ESM loader (`benchmarks/count-loader.mjs`) hooked via `--experimental-loader` that increments a counter for every module Node resolves. Output goes to a temp file the parent process reads.

What it measures (`measure.ts:690-865`):

- `correctness`: `--help` and `--version` exit codes (must equal 0).
- `performance`: `help_module_count`, `version_module_count`, `interactive_module_count` (deterministic, doesn't drift between CI machines), `interactive_boot_ms_approx` (median of 3 runs, labeled approximate), `first_render_ms_approx`, `dist_size_bytes`, `dist_file_count`.
- `stability`: `cli_flag_count`, `tool_count`, `command_count`, `help_hash` (sha256 of `--help` output, hash drift fails the gate).
- `health`: `test_file_count`, `test_case_count`, `audit_high_vulns` (from `pnpm audit --json`).

Baseline in `benchmarks/baseline.json` is committed. `pnpm test:benchmark:update` overwrites it. `pnpm test:benchmark:explain` runs with a URL-capturing loader variant and produces bucket-by-package + first-party-source-hotspot breakdowns so a regression points at which dependency or directory caused it (`measure.ts:419-429`).

Default failure thresholds are `warnRatio=1.25` and `failRatio=2.0` per `numeric` metric, with per-metric overrides. `warnOnDecrease: true` flags when stability metrics shrink, a dropped tool or test file is a regression, not a win.

The interactive-startup measurement (`measure.ts:144-217`) polls the count file until it's stable for `stableMs=1500`, then kills the process. This makes the result independent of machine speed, wait for steady state, not a fixed wall-clock window.

Two design choices worth copying directly:

1. Module count is the primary perf signal because it's deterministic. Wall-clock is included but labeled approximate. CI doesn't trip on flaky timing.
2. `help_hash` as a stability metric. If `--help` output drifts unintentionally, the report flags it. This is cheap regression protection for the user-facing contract.

Squad's `npm run deflake` proposal from the 2026-05-08 batch is adjacent. The benchmark harness is the complementary system, `deflake` confirms a test isn't timing-sensitive; the benchmark confirms the CLI itself isn't getting more expensive.

### Provider abstraction: lazy SDK loading

The single line worth stealing from `provider-factory.ts` is the `import type` + dynamic `await import()` pattern. Squad's catalog currently maps `adapter kind` → adapter module, which already lazy-loads, but the discriminated-union return type `TaggedProvider` (`provider-factory.ts:38-46`) is cleaner than how Squad currently shapes provider-instance handoff. Each kind pairs with its concrete SDK provider type with no `as unknown as` casts.

Custom `undici` fetch wrapper (`provider-factory.ts:54-64`) so TLS config flows through every SDK, Squad's SSRF guard handles the local-provider case but doesn't address custom CA bundles for cloud providers. If Cid ever needs corporate-proxy support, this is the shape.

### OAuth device flow for Copilot/Codex

`source/auth/github-copilot.ts` and `source/auth/chatgpt-codex.ts` implement device-flow OAuth, save credentials in platform config dirs, and refresh tokens lazily inside the per-request fetch wrapper. The CLI entry handles `nanocoder copilot login [provider-name]` and `nanocoder codex login [provider-name]` (`cli.tsx:236-285`) as fast paths that print the verification URL + user code, poll the device endpoint, and exit. This is real value for users with Copilot/ChatGPT Plus subscriptions who don't want to pay per-token.

Squad's catalog model already supports arbitrary providers. OAuth-driven providers would slot in as a new adapter kind, `llm-oauth-chat` or similar, that wraps the existing `llm-chat` with credential refresh. Probably worth it only after subagents ship.

### LSP integration (post-edit diagnostics)

`source/lsp/lsp-manager.ts:45` with auto-discovery (`server-discovery.ts`) for TS / Python / Rust / Go / Deno / GraphQL / Docker / Markdown. The `lsp_get_diagnostics` tool (`source/tools/lsp-get-diagnostics.tsx`) lets the agent request diagnostics for a file post-edit. This is the same "post-edit diagnostics injection" called out as a strong steal in the 2026-05-08 batch, nanocoder has it built, and it's a complete reference implementation: protocol, manager, discovery, client, EventEmitter for `diagnosticsUpdated`.

If Squad ever wants this, copying nanocoder's LSP code is a faster path than re-implementing. The wire protocol is generic; the discovery heuristics (look for `package.json` keys, `pyproject.toml`, etc.) are the portable bits.

### Modular system prompt

`source/app/prompts/sections/`, `identity.md`, `core-principles.md`, `coding-practices.md`, `file-editing.md`, `tool-rules.md`, `diagnostics.md`, `task-management.md`, etc. A `prompt-builder` assembles per-mode prompts (normal / auto-accept / plan / scheduler / nano) by including or excluding sections. `scripts/generate-system-prompts.ts` produces offline token-count audits.

The nano profile (changelog v1.26.0) drops `core-principles` and `coding-practices` entirely, uses ≤4-line versions of the kept sections, omits `AGENTS.md` from the prompt, and skips the verbose `SYSTEM INFORMATION` block. Result is 150-250 tokens vs minimal's 500-700 vs full's much higher. This is the right factoring for "I want to run a 4B model on local hardware that still understands the agent contract." Squad's `OutputStyles` system is closer to per-style prepend; nanocoder's is per-mode prompt assembly with offline token counting.

### Reasoning trace rendering

Changelog v1.26.0 added real-time reasoning stream rendering with collapsible `Thought` blocks (`AssistantReasoning` component). Reasoning persists across history, is included in logs, and toggles via `Ctrl+R`. Pin per-session via the tune `expandedReasoning` option. Default expansion configurable in Display Settings. Works for Codex GPT-5, DeepSeek-R1-style, Anthropic extended thinking, Ollama thinking.

Squad supports reasoning deltas at the canonical-event level. The rendering shape, collapsible by default, toggle key, persist in history, render above the response, is the missing UX piece.

### Scheduler (cron-driven autonomous runs)

`source/schedule/runner.ts:23` uses `croner` to register cron jobs from `.nanocoder/schedules/*.md` files. Sequential job queue with deduplication (`runner.ts:89-93`). Scheduler mode disables `ask_user` and `agent` since the run is non-interactive. Each run gets a fresh system prompt rebuild so current-date and other dynamic fields stay current (changelog v1.26.0 fix). Run history persists for later inspection via `/schedule logs`.

This is an interesting feature for "agent that wakes up nightly, summarizes the day's commits, and writes a digest." For Squad's vetting purpose it's not a fit, but the run history + queue deduplication patterns transfer cleanly to any background-job system.

### Tool profiles for local models

`source/tools/tool-profiles.ts:7-26`, three named tool subsets (`full`, `minimal`, `nano`). `minimal` keeps 8 tools (read/write/edit/bash/find/search/list/agent). `nano` drops to 5 (read/edit/write/bash/search). `isSingleToolProfile()` returns true for both, which the conversation loop respects by truncating multi-tool responses to the first call (`conversation-loop.tsx:368-372`). Tied directly to model capability, running a 3B model needs a slim prompt and one-call-at-a-time discipline.

Squad's current model is "every tool is always available." A profile concept on top of the catalog would help when paired with the local provider, `--profile nano` for a Gemma 3 4B run.

### `--plain` mode for CI

`source/plain/shell.ts` is an Ink-free path with deterministic exit codes, proper stdin/stdout handling, and zero interactive prompts. Auto-detected from `process.env.CI`, `GITHUB_ACTIONS`, etc., or `!process.stdout.isTTY`. Squad has `--simple` for readline-REPL but no equivalent for "run a single prompt in CI and print the answer." The shape `nanocoder --plain run "<prompt>"` is a single-prompt, scriptable invocation, Squad's `-p, --print` plus a hardening pass on what happens when stdout is piped would land in the same place.

### Notification subsystem

Desktop notifications (changelog v1.25.0) for tool confirmations, question prompts, and generation completions. macOS uses `terminal-notifier` with osascript fallback. Linux uses `notify-send`. Windows uses PowerShell. Configurable per-event in `nanocoder-preferences.json`. Useful for "I started a long agent task and switched windows." A small feature that's high-value for the actual workflow.

### Distribution story

Three install paths, all in the repo:

- `package.json` → npm.
- `Formula/nanocoder.rb` → Homebrew. Pins `node@22`, plus a build-time test that runs `nanocoder --help` post-install.
- `flake.nix` → Nix flakes. Production-grade with `fetchPnpmDeps` reproducibility, `nodejs_24`, `pnpm_11` override over nixpkgs's bundled pnpm 10, and detailed comments on every workaround (an upstream nixpkgs bug in `fetchPnpmDeps` is patched via env-var overrides).

`scripts/update-homebrew-formula.sh` automates the sha256 + version bump. The CI/release workflow handles all three on a release tag.

Squad ships npm only. Brew and Nix are well-trod paths for a Node CLI; the Formula recipe in particular is ~20 lines and pays off the first time a Mac user installs via `brew install`.

### Live `AgentProgress` rendering

`source/components/` (referenced from `subagent-executor.ts:14-15`) renders concurrent subagent progress in-place via the `subagent-events.ts` per-ID slot map. Each running subagent gets its own panel that updates as the subagent emits events. Token count, current tool, status. Squad's planned `howl` lifecycle events fit the same pattern.

## What Squad Code already does better

### Tamper-evident audit chain

Squad has a SQLite audit DB at `~/.squad/audit.db` with `prev_hash` linking every row to the previous one (`SQUAD_CODE_FEATURES.md:160-166`). Audit chain validation is in the session store. Records prompts, tool calls, tool results, permission decisions, hook fires, session lifecycle.

nanocoder has nothing comparable. Audit-trail behavior is implicit in JSONL transcripts plus pino logs. No hash chain. No way to detect a tampered transcript. For a tool that runs in YOLO mode and rewrites a repo, the chain is load-bearing for incident-review trust. Squad's posture is genuinely stronger here.

### Append-only JSONL session transcripts with fsync-per-turn

`SQUAD_CODE_FEATURES.md:144-156`. Squad fsyncs each turn before continuing. nanocoder's session-manager (`source/session/session-manager.ts:62-81`) uses atomic temp-and-rename for the index but the session conversation is written whole-file on autosave. A crash between autosaves loses the current turn. Squad's append-only-with-fsync survives mid-turn power loss.

### YOLO with checklist gate + delete-archive rewrite

Squad's YOLO mode (`SQUAD_CODE_FEATURES.md:126-141`) requires a checklist file (`checklist.txt`, `CHECKLIST.md`, etc.) in cwd before activating, appends the checklist to the system prompt as the source of truth, enforces a cwd sandbox for all shell commands, rejects absolute paths outside cwd, rejects `cd`/`Set-Location` outside cwd, and rewrites every delete command (`rm`, `Remove-Item`, `del`, `unlink`) into an archive move under `.archive/<timestamp>/`.

nanocoder's yolo mode is "auto-accept every tool without exception" (`source/tools/execute-bash.tsx:88-91`). No checklist gate. No cwd sandbox enforcement on bash. No delete-to-archive rewrite. Their `yolo` is the dangerous version Squad's `--dangerously-skip-permissions` mode is. The Squad shape, armed YOLO with rails, is the safer evolution and the more honest mode for an agent that will delete files.

### Atomic writes with BOM and line-ending preservation

`SQUAD_CODE_FEATURES.md:88-95`. Squad's `Edit` tool preserves BOM, preserves original line endings (CRLF / LF), uses file locking, and rechecks file mtime after permission preview to refuse stale edits. `Write` uses tmp-and-rename atomic.

nanocoder's `write_file` (`source/tools/file-ops/write-file.tsx`) and `string_replace` (`source/tools/file-ops/string-replace.tsx`) write whole files but don't appear to preserve BOM explicitly or use mtime-check after preview. Custom-tools template substitution is shell-quoted but the resulting writes go through `child_process` to whatever the script does, no atomicity guarantee at the agent level.

### Project-level permission persistence with specificity-sorted matching

`SQUAD_CODE_FEATURES.md:113-124`. Squad has `permanently allow for this project` as a permission outcome, persisted in `.squad/settings.json`. Pattern-based rules support allow / deny / ask actions. Matching is specificity-sorted so `Shell:npm test` beats `Shell:npm *`. Shell grants use arity-prefixed command patterns; path-tool grants use parent-directory globs; repo-root files remain literal scopes. `SQUAD_PROJECT_PERMS=0` opts out.

nanocoder has `alwaysAllow` in `agents.config.json` (a flat list) and `nanocoderTools.alwaysAllow` (also flat, deprecated as of v1.26.0, the 1.26.0 changelog calls out the breaking removal). Per-MCP-server `alwaysAllow` whitelists a tool but doesn't pattern-match arguments. No specificity sort. No `permanently allow for this project` from inside a permission prompt.

### SSRF guard on local-provider URLs

`SQUAD_CODE_FEATURES.md:253-254`. Squad's local-provider adapter requires `OLLAMA_ALLOW_REMOTE=1` to talk to a non-loopback URL. The accidental-RCE-via-Ollama scenario (model configured to point at an arbitrary internal service) is closed at the adapter layer.

nanocoder's provider config is `baseURL` + `apiKey` + `headers` straight into the SDK. No SSRF check. If a user pastes `https://internal-prod-database:5432/api/v1/query` into `agents.config.json` as a baseURL, nothing stops the agent from POSTing JSON to it. Most users will never hit this; a curious user dropping a checked-in `agents.config.json` from a stranger's repo into their machine will.

### Permission posture defaults

Squad auto-allows read-only tools and asks for mutating tools by default (`SQUAD_CODE_FEATURES.md:104-105`). Sensitive defaults include explicit handling for `.env`, `.env.example`, SSH keys, SSH config (`SQUAD_CODE_FEATURES.md:119-120`). nanocoder has tool-level `needsApproval` flags but no central "sensitive file" list, `.env` reads aren't specially gated.

### Usage ledger with cost tracking and cached-input savings

`SQUAD_CODE_FEATURES.md:168-179`. Squad's SQLite usage ledger records provider, model, cwd, session id, token counts, cached input tokens, tool-call counts, and estimated cost. `squad usage` and `/usage` filter by cwd / all-cwd / session / provider / model / day range, grouped by day / session / model. Pricing lookup includes cached-input savings when supported.

nanocoder's usage (`source/usage/storage.ts:1-78`) is a JSON file at `~/.../nanocoder/usage.json` with `MAX_USAGE_SESSIONS` and `MAX_DAILY_AGGREGATES` caps to prevent unbounded growth. Tracks tokens but not pricing-with-cached-input. The `/usage` command shows context-window utilization for the current session (changelog v1.16.0).

Squad's ledger is queryable across all sessions for arbitrary date ranges. nanocoder's is roll-up.

### Adapter kinds vs. one-size

Squad has four adapter kinds (`llm-chat`, `llm-message`, `llm-response`, `llm-local`) covering OpenAI chat-completions, Anthropic Messages, OpenAI Responses, and OpenAI-compatible-local. nanocoder uses the Vercel AI SDK as a single substrate, all providers map through `ai` v6's unified shape. This is a tradeoff, not a strict win for either side: AI SDK abstracts away provider-specific features (e.g., OpenAI Responses' reasoning configuration), while Squad's catalog lets each adapter expose what it natively supports. For provider quirks like Codex's `store: false` requirement, both end up writing custom fetch wrappers anyway.

### MCP is implemented but not the default

nanocoder ships MCP support and a VS Code extension. Both are large surfaces with real lifecycle complexity. Squad's `SQUAD_CODE_FEATURES.md:13` explicitly lists "no MCP server support" and "no IDE bridge" as deliberate omissions. The local-first thesis says don't add network surface that doesn't pay for itself; both projects can claim local-first, but Squad's interpretation is stricter.

### Audit-chain prev-hash vs. atomic-write only

`source/session/session-manager.ts` does atomic writes correctly but there's no tamper-evidence layer. A tool that runs in YOLO can rewrite the JSONL transcript with no way to detect it. Squad's prev_hash chain solves exactly this.

### Hook system

Squad has `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SessionStart`, `SessionEnd`, `UserPromptSubmit` hooks loaded from settings (`SQUAD_CODE_FEATURES.md:180-191`), recorded in the audit chain, and failure-isolated from the main flow. nanocoder has no equivalent. The closest is the `subagent-events.ts` event channel, which is internal-only and doesn't accept user scripts. A user wanting to run `prettier --write` after every `Edit` would do it via a custom tool or a manual shell run; in Squad it's a `PostToolUse` hook.

## Anti-patterns / things to avoid

### MCP and VS Code extension

Both are present in nanocoder. Both expand the attack surface and the maintenance load. Squad already punted both for charter reasons. The mere fact that nanocoder ships them is not evidence Squad should reverse the call.

nanocoder's MCP code is roughly 400 lines in `source/mcp/` plus dependency on `@modelcontextprotocol/sdk` plus three transport types (`stdio`, `WebSocket`, `streamableHttp`) plus the per-server `alwaysAllow` config plus the case where servers return malformed schemas (closed by the v1.26.0 fix typing `MCPTool.inputSchema` as `JSONSchema7` with `isPlainObject` guard, classed as a security fix). For a local-first single-user agent, the cost-benefit is poor unless the user genuinely lives in MCP-tooled environments. Squad's stance, punt until users ask, is correct.

The VS Code extension is a separate `plugins/vscode/` workspace package, ~5 source files plus a WebSocket protocol and a diff manager. Auto-pulls highlighted code and the focused file into the agent context (v1.26.0 redesign). Useful, but it doubles the surface area of the project and requires VSIX packaging + signing infrastructure (`@vscode/vsce-sign` in `allowBuilds:` per `pnpm-workspace.yaml:5-10`). Squad has a charter-level "no IDE bridge."

### Central state container with 50+ variables

Their own CLAUDE.md describes `useAppState.tsx` as the source of truth for 50+ state variables. Other hooks receive setters from it. This is a pattern that works in React but starts to feel like a god object. It also forces deep components to go through a global `message-queue.tsx` to push chat messages without prop-drilling. The combination is recognizable as "the test surface keeps growing and the state slice is one big object."

If Squad's REPL ever needs more state, prefer multiple smaller context providers per concern (provider state, tool state, permission state) over one mega-container. The existing canonical event stream is already the right shape, keep it.

### Mode toggling that includes a foot-gun on the rotation

Shift+Tab cycles `normal → auto-accept → yolo → plan`. Pressing it three times from `normal` armed yolo. Nanocoder's yolo is the raw "auto-accept every tool without exception" version, bash, git hard reset, force-delete, stash drop/clear. There is no checklist gate. A user habituated to the cycle who presses Shift+Tab three times by accident is one keystroke from `rm -rf` running unprompted.

Squad's `/yolo` toggle plus checklist gate plus delete-archive rewrite is the safer shape. Do not adopt nanocoder's "yolo is just `--dangerously-skip-permissions`" interpretation. Do not put yolo on a rotation key without a confirmation step.

### Auto-injection of relevant custom commands by relevance score

`source/custom-commands/loader.ts:289-344` ranks every registered custom command against the user's prompt and silently appends the top 3 (with `RELEVANCE_THRESHOLD = 5`, `MAX_COMMANDS_IN_CONTEXT = 3`) into the conversation. Scoring: description match +10, category match +5, trigger match +15, tag match +5. The user does not see what was injected.

This is a context-pollution risk and a debugging trap. A user's prompt gets silently augmented with `.nanocoder/commands/<top-3>.md` content based on a heuristic. If the matching is off, the assistant gets confused and the user doesn't know why. Squad's skills/output-styles are explicitly invoked. Keep that property.

### MaxConcurrent that's "just" 5

`MAX_CONCURRENT_AGENTS = 5` (`subagent-executor.ts:39`). Squad's plan is 4 with explicit queue-or-refuse beyond. nanocoder's executor caps the concurrency at the executor level but doesn't appear to have a "queue beyond 5" story, calling `execute()` more than 5 times in parallel will run them all (the `MAX_CONCURRENT_AGENTS` constant is exported but I didn't find the gate enforcement on a quick read). Squad's plan to fail-fast at the depth/slot ceiling is the right shape.

### Plain shell auto-detection that fights the user

`cli.tsx:228-233` auto-enables `--plain` when stdout isn't a TTY or any CI env var is set. Useful, but the auto-detection picks up a developer running `nanocoder | tee log` and switches to plain mode unexpectedly. Squad should keep the user-facing `--simple` and `--print` explicit. Auto-detect via env var if the user opts in (`SQUAD_PLAIN=1`), not by sniffing TTY-ness by default.

### Live token count from a separate event channel

`subagent-events.ts` token counts are computed in the executor and read elsewhere (`subagent-executor.ts:140-143`). There's a precedent comment in their refactor history about a race where `setLastBuiltPrompt` overwrote the cache. For Squad's `howl`/anguish lifecycle plan, keep the events in the single canonical stream, a separate side channel grows out of sync.

### Custom YAML parser per-file-type

nanocoder has at least three frontmatter parsers, `source/utils/frontmatter.ts` (custom commands and tools share `splitFrontmatter`), `source/custom-commands/parser.ts:46` (`parseEnhancedFrontmatter` with custom array handling), and `source/custom-tools/parser.ts:48` (`parseCustomToolFile`). Plus the subagent loader uses `markdown-parser.ts`. Four parsers, three of them hand-rolled, one of them using the shared util.

The reason becomes obvious reading the code: the `yaml` package (which is in `dependencies` per `package.json:100`) is used for general YAML, but the custom command parser pre-dates it and has its own array-parsing rules for `parameters`, `tags`, `triggers`, etc. that the upstream YAML parser handles differently. The result is N parsers that need to stay in sync. If Squad adds frontmatter-driven extension files, use one YAML parser everywhere.

### Tool count drift

nanocoder shipped 31 tools (`baseline.json:57`). The list includes `git_pr`, `lsp_get_diagnostics`, `ask_user`, four task management tools (`create_task` / `update_task` / `delete_task` / `list_tasks`), four file ops tools (`delete_file` / `move_file` / `create_directory` / `copy_file`), the `agent` subagent dispatcher, `web_search`, `fetch_url`, etc. Many of these are conveniences a sufficiently capable model could compose from `Shell` + `Read` + `Edit`. Each is one more tool in the system prompt, one more thing the model has to remember about, one more bit of context pressure.

Squad's 11-ish tools is the better posture. Watch out for the "we should add a `git_status` tool too" creep. The model can run `git status` via Shell.

## Concrete backlog inserts for Squad Code

1. **Add a markdown custom-tools loader.** Highest-value steal. Port `source/custom-tools/` shape, `.md` files in `~/.squad/tools/` and `./.squad/tools/` with YAML frontmatter declaring `name`, `description`, `parameters`, `approval`, `read_only`, `timeout_ms`, `cwd`, `env`, `shell`, and a Mustache-templated shell body. Shell-quote substitutions. Validators wrap `execute`. Project shadows user shadows built-in. Reuse Squad's existing `Shell` runner for execution. This delivers a real extension surface without inventing a Node plugin loader.
2. **Add `npm run benchmark` and a `benchmarks/` directory.** Port the module-count loader pattern. Metrics for v1.1: `help_module_count`, `version_module_count`, `interactive_module_count`, `help_hash`, `tool_count`, `command_count`, `test_file_count`, `test_case_count`. Commit a baseline. Pair with the `npm run deflake` script from the 2026-05-08 batch. The two together make agent-loop regression a measurable thing.
3. **Subagents as markdown files.** Already in plan per `SQUAD_CODE_FEATURES.md:271`. Use nanocoder's frontmatter contract, `name`, `description`, `model` (literal or `inherit`), `tools` (whitelist), body as system prompt, minus the auto-injection-by-relevance behavior. Cascade: built-in < user < project.
4. **Modular system prompt.** Move Squad's prompt-building from a single string to a per-section markdown layout (`prompts/sections/identity.md`, `prompts/sections/tool-rules.md`, etc.). Mode-specific assembly. Offline token-count audit script. Pays off once a `nano` profile lands for tiny-model vetting runs.
5. **Tool profiles for the local provider.** Three profiles: `full`, `minimal`, `nano`. Same direction as nanocoder. Tie to a CLI flag (`--profile nano`) and a `/profile` slash command. Single-tool enforcement for nano. The current "every tool is always available" is the wrong default when the user explicitly picked Ollama.
6. **Reasoning trace UI.** Squad supports reasoning deltas at the event level, render them. Collapsible `Thought` block above the response. Ctrl+R to toggle expansion. Persist in transcript. Default collapsed; configurable in `~/.squad/settings.json`.
7. **`help_hash` regression check.** Cheapest possible CI gate. sha256 the `--help` output, commit the hash, fail the build if it drifts unintentionally. Catches accidental flag removals before release.
8. **Homebrew formula.** ~20 lines (`Formula/nanocoder.rb` is the reference). Pin `node@22`. Mac users will use it. Worth doing alongside v1.2 release prep.
9. **Notification subsystem.** Optional, low-priority. Tool-confirmation notifications when stdout isn't focused. macOS / Linux / Windows native commands. Wire to existing permission flow. Configurable per-event.
10. **Post-edit LSP diagnostics.** Already named in the 2026-05-08 batch. nanocoder's `source/lsp/` is a reference implementation if Squad chooses to build it. Keep the trigger explicit (an opt-in flag or a `PostToolUse` hook) rather than always-on, diagnostics on every edit is expensive for big projects.

## Bottom line

nanocoder is the closest peer to Squad on the local-first axis and the most useful target in the rip pile. The single highest-leverage steal is the markdown custom-tools contract, a real user-facing extension surface that doesn't require inventing a Node plugin system, and that fills a hole Squad currently has between skills (prompt-only) and built-in tools (TS-only). The benchmark harness is the second steal, module-count as the primary perf signal plus `help_hash` for stability drift is a CI-safe pattern Squad should adopt before v1.2.

In the other direction, nanocoder demonstrates that Squad's tamper-evident audit chain, YOLO-with-rails, project-permission persistence with specificity-sorted matching, SSRF guard on the local-provider adapter, and atomic-edit-with-BOM-preservation are genuine differentiators, not table stakes. nanocoder's `yolo` is what Squad's `--dangerously-skip-permissions` would be without the checklist gate; nanocoder's session-manager has no prev_hash chain; nanocoder's permission story is a flat allowlist. A user who cares about doing damage control after a bad agent run will end up with Squad. The bigger takeaway: nanocoder has chosen breadth (MCP, LSP, VS Code, OAuth providers, scheduler, checkpoints, notifications) and Squad has chosen depth on the rails. Borrow nanocoder's extension surface and benchmark discipline; do not borrow its MCP, VS Code, or auto-injection patterns.
