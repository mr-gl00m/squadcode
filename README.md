```
   ███████╗ ██████╗ ██╗   ██╗ █████╗ ██████╗      ██████╗ ██████╗ ██████╗ ███████╗
   ██╔════╝██╔═══██╗██║   ██║██╔══██╗██╔══██╗    ██╔════╝██╔═══██╗██╔══██╗██╔════╝
   ███████╗██║   ██║██║   ██║███████║██║  ██║    ██║     ██║   ██║██║  ██║█████╗    
   ╚════██║██║▄▄ ██║██║   ██║██╔══██║██║  ██║    ██║     ██║   ██║██║  ██║██╔══╝      
   ███████║╚██████╔╝╚██████╔╝██║  ██║██████╔╝    ╚██████╗╚██████╔╝██████╔╝███████╗  
   ╚══════╝ ╚══▀▀═╝  ╚═════╝ ╚═╝  ╚═╝╚═════╝      ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝  
   --------------------------------------------------------------------------------
```
I needed a better way to use LLM APIs and local models for coding and whatnot in my day to day. Codex is slow and feels like a mess. So I made this. This is a local CLI agent that streams from any provider through one canonical event loop.

```text
$ squadcode -p "summarize src/"
[Glob] src/**/*.ts
[Read] src/engine/loop.ts
[Read] src/providers/types.ts
The agent loop in src/engine/loop.ts drives a stream-then-execute cycle: it pulls
canonical events from the provider, collects any tool_call_done events, runs the
matching tools through the permission policy, appends results, and re-enters the
provider until no more tool calls land or max_turns hits.
[usage] in 1842, out 612, total 2454
```

```text
$ squadcode
squadcode · deepseek · deepseek-v4-flash · 0 turns · 0 tokens
> /model deepseek-v4-pro
model switched to deepseek-v4-pro
> review the audit chain code for replay attacks
…
```

## What it is

Squad Code is the modern streaming-agent CLI shape: streaming chat, tool use, sessions, ask/allow/deny permissions, JSONL transcripts; wired to any frontier model behind one `LLMProvider` interface. Every provider stream gets normalized into a single `CanonicalEvent` union (`text_delta`, `tool_call_done`, `tool_result`, `usage`, `done`, `error`); the agent loop never sees provider-specific wire formats. v1.1 covers four adapter kinds — `llm-chat` (DeepSeek, gpt-4o family, Together, Groq, Fireworks, OpenRouter, any OpenAI-compatible chat-completions backend), `llm-message` (Anthropic Claude family with `cache_control` and thinking blocks), `llm-response` (OpenAI gpt-5.x and o-series via the Responses API with reasoning), and `llm-local` (Ollama and other local OpenAI-compatible servers). Adding a new backend is a JSON catalog row, not a code change. v1.1 also adds **YOLO mode** — a fully autonomous run with three rails (sandbox, archive-on-delete, mandatory checklist) so you can hand the agent a task and walk away. It exists because vetting models against real tool-use loops needs a harness that doesn't smuggle in provider-specific assumptions, and the existing options either tie themselves to one vendor or skip the agent loop entirely.

## Quickstart

Requires Node 22+ and a key for at least one provider (or a running local Ollama).

```bash
git clone <this repo>
cd proj_ai_squad_code
npm install
cp .env.example .env
# edit .env to set at least one of:
#   DEEPSEEK_API_KEY=sk-...
#   ANTHROPIC_API_KEY=sk-ant-...
#   OPENAI_API_KEY=sk-...
npm run build

# one-shot, default provider (DeepSeek)
node dist/bin/squad.js -p "summarize src/"

# interactive REPL
node dist/bin/squad.js

# Anthropic Claude
node dist/bin/squad.js --provider anthropic --model claude-sonnet-4-6

# OpenAI gpt-5.1 via the Responses API
node dist/bin/squad.js --provider openai --model gpt-5.1

# Local Ollama
ollama pull llama3.2
node dist/bin/squad.js --provider ollama --model llama3.2
```

`npm install -g .` (or `npm link`) puts `squad` and `squadcode` on your PATH if you'd rather not type the full path.

State lives under `~/.squad/`: settings, rotating logs, JSONL session transcripts, and the `audit.db` SQLite file. Nothing leaves the machine except calls to the provider you configured.

## How it works

The throughline is a single canonical event stream. Each adapter family — `src/providers/llm-chat.ts`, `src/providers/llm-local.ts`, `src/providers/llm-message.ts`, `src/providers/llm-response.ts` — translates its native streaming format into the `CanonicalEvent` union defined in `src/providers/types.ts`. The agent loop in `src/engine/loop.ts` reads canonical events, collects `tool_call_done` events at turn boundaries, runs each call through the permission policy, executes the matching tool from the registry, appends the result back as a tool message, and re-streams until the model stops calling tools or `max_turns` hits. The loop received zero changes across all four v1.1 adapter additions — that's the architectural test the canonical layer was designed to pass.

A model catalog at `src/providers/default-models.json` (read at startup) maps each known model to its adapter kind, base URL, env-key var, and capability flags. `~/.squad/models.json` is a user override that gets merged on top by id — overrides win, new entries extend. `src/providers/dispatch.ts` consults the catalog row and instantiates the right adapter; the CLI never special-cases a vendor.

Permissions split read-only from mutating: `Read`, `Grep`, `Glob`, and `TodoWrite` auto-allow within the cwd-anchored allowed root; `Write`, `Edit`, and `Shell` prompt synchronously by default. The prompt offers four outcomes — `[y]`es allow once, `[a]`lways for this session, `[p]`ermanently for this project, `[n]`o (default). `[a]` and `[p]` broaden the scope: `Shell` grants apply to the arity-prefixed verb (`git *`, `npm install *`, `docker compose up *`), and `Read`/`Edit`/`Write` grants apply to the file's parent directory glob (`src/foo/*` instead of just `src/foo/bar.ts`) so you don't re-prompt on every sibling file. `[p]` persists into `.squad/settings.json`. Path-traversal validation runs on every filesystem-touching call, symlinks resolved with `realpath` and re-checked.

Persistence is two structures with two jobs. JSONL transcripts under `~/.squad/sessions/<id>.jsonl` exist for replay — append-only with `fsync` per turn, indexed for fast `sessions list` lookup by SQLite at `~/.squad/sessions.db`. The audit chain at `~/.squad/audit.db` exists for tamper-evidence — every prompt, tool call, tool result, and permission decision lands as a row with a `prev_hash` link to the prior row. Mid-turn kill, restart with `--resume`, the conversation continues; the audit chain validates end-to-end. SQLite runs in WAL mode with parameterized statements only.

## Examples

```bash
# scope tools per-session
squadcode --allowed-tools Read,Grep,Glob -p "find duplicated regex patterns in src/"

# bypass the prompt for a one-off automation run
squadcode --dangerously-skip-permissions -p "rewrite README.md to fix typos"

# autonomous run with rails (needs checklist.txt in cwd; see YOLO mode below)
squadcode --yolo

# resume by id
squadcode --resume 4f9c1a2e-1b3d-4a8c-9f1e-2b3c4d5e6f7a

# in the REPL
> /provider anthropic
> /model claude-opus-4-7
> /cost
> /usage cwd 14
> /tools
> /sessions
> /clear
```

## YOLO mode

`--yolo` (or `/yolo` mid-session) lets the agent run without permission prompts, but it isn't `--dangerously-skip-permissions` with a friendlier name. Three rails come along with it:

1. **Sandbox.** Absolute paths outside cwd, and `cd` / `Set-Location` targets that resolve outside cwd, are rejected by the `Shell` tool before the command runs. The model sees the rejection in `stderr` form and self-corrects. The path tools were already cwd-jailed; YOLO closes the same hole on Shell.
2. **Archive-on-delete.** `rm`, `Remove-Item`, `del`, and `unlink` get rewritten to a `mv` into `.archive/<iso-timestamp>/` (per-session). Files aren't gone, they're moved. The rewrite is documented in the system-prompt addendum so the model knows the contract; if it needs a file back, it looks in `.archive/`. POSIX uses `mkdir -p ... && mv ...`, PowerShell uses `New-Item -ItemType Directory ...; Move-Item -Path ..., ... -Destination ... -Force`.
3. **Checklist.** YOLO refuses to start without a `checklist.txt`, `CHECKLIST.md`, `checklist.md`, or `CHECKLIST.txt` in cwd. The contents get appended to the system prompt so the agent works the list top-down. No checklist, no autonomous run — that's deliberate; the failure mode of a runaway agent is much louder than the friction of writing a five-line plan first.

```bash
# write the plan
cat > checklist.txt <<EOF
- migrate src/auth from callbacks to async/await
- update tests in test/auth.test.ts
- run npm test until green
EOF

# hand it off
squadcode --yolo --provider anthropic --model claude-sonnet-4-6
# or, if you're already in the REPL: > /yolo
```

The Ink REPL paints a red `YOLO` badge in the status footer when armed. `/yolo` toggles off as well — when off, you're back to the normal ask/allow/deny prompt flow.

`--yolo` and `--dangerously-skip-permissions` are not the same flag. `--dangerously-skip-permissions` skips prompts and that's it — no rails, no checklist, no archive-on-delete. Use it for one-off scripted runs where you've already vetted the prompt. Use `--yolo` for actual autonomous work.

## Adding a new model

Squad ships a default catalog covering DeepSeek, Anthropic, OpenAI (Responses + chat-completions), and Ollama. Add anything else by dropping a row into `~/.squad/models.json`:

```json
{
  "models": [
    {
      "id": "llama-3.1-70b-versatile",
      "provider_id": "groq",
      "kind": "llm-chat",
      "base_url": "https://api.groq.com/openai/v1",
      "env_key_var": "GROQ_API_KEY",
      "capabilities": { "tool_use": true }
    }
  ]
}
```

`kind` picks the adapter family: `llm-chat` for OpenAI-compatible chat-completions backends (most third-party hosts), `llm-message` for Anthropic-shape Messages APIs, `llm-response` for OpenAI's Responses API (gpt-5.x, o-series), `llm-local` for keyless local servers that need a `/v1` path append. Capability flags toggle per-model behavior — `cache_control` plumbs `cache_control` markers for Anthropic, `reasoning` extracts reasoning content from DeepSeek-Reasoner / o-series / gpt-5.x, `thinking` enables Claude's extended thinking budget. User-override entries win over defaults by id; aliases let `--model deepseek-v4-flash` resolve to `deepseek-chat` without duplicating the row.

## Status

**v1.1.0** — multi-provider + YOLO release. DeepSeek, Anthropic Claude (with `cache_control` and thinking), OpenAI gpt-5.x / o-series via the Responses API, OpenAI gpt-4o family via chat-completions, and Ollama all work end-to-end through the same canonical event loop. Anything OpenAI-compatible (Together, Groq, Fireworks, OpenRouter, etc.) is one `~/.squad/models.json` row away. Per-turn token + cost ledger via `squad usage` and `/usage` works across all backends; Anthropic cached-input savings show in the math. YOLO mode (`--yolo` / `/yolo`) hands off autonomous runs with sandbox + archive-on-delete + mandatory checklist rails.

**v1.0.0** — initial release. Five MVP commands streaming end-to-end against DeepSeek + Ollama, with the tool loop, permission prompts, and JSONL transcripts.

Single-user, single-machine. No remote sessions, no telemetry.

## What this isn't

Not an IDE plugin or a hosted product. Squad Code's job is vetting models (local and frontier) against the same agent loop, run from a terminal. There is no cloud, no telemetry, no error reporting, no analytics. Not MCP, not plugins, not an IDE bridge; those are on the deferred wall, not the roadmap. The subagent layer (`Agent` tool, depth-1 spawning, per-agent model selection) is on the roadmap as v1.2 — once multi-provider exists, dispatching the same task across four backends concurrently is the actual vetting unlock.

## Roadmap

- v1.1 (shipped): catalog-driven multi-provider — `llm-chat`, `llm-message`, `llm-response`, `llm-local`. OpenAI Responses API, Anthropic Messages API with `cache_control`, hooks (`PreToolUse` / `PostToolUse` / `SessionStart` / `SessionEnd` / `UserPromptSubmit`), pattern-based permissions with sensitive defaults and broadened `[A]`/`[P]` scope (arity-prefixed verbs for `Shell`, parent-dir glob for path tools), per-turn usage ledger, artifact storage for oversized tool output, deferred-schema tool catalog (`ToolSearch`), apply-patch tool, YOLO mode with sandbox + archive-on-delete + checklist rails.
- v1.2: subagent layer (`Agent` tool, depth=1, four concurrent slots, per-agent model selection across all four kinds), TUI panels, `Ctrl+K` kill picker, anguish-meter observability, codex / claude as external CLI subagent backends.
- Polish: markdown rendering in the REPL, syntax highlighting, `--output-format json` and `--output-format stream-json`, hooks UI surfacing, auto-compact mid-session toggle.
- Indefinitely deferred: MCP servers, custom agents-as-config beyond `.squad/agents/`, IDE bridge, remote sessions.
- Compatibility with other tools / projects created by me.

## License
[MIT](./LICENSE). Copyright © 2026 Nathan Seals / Nexus Labs

## Support Me
If you find this useful, consider supporting me and my research:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-F16061?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/mr_gl00m)
[![GitHub Sponsors](https://img.shields.io/badge/GitHub_Sponsors-EA4AAA?style=for-the-badge&logo=github&logoColor=white)](https://ko-fi.com/mr_gl00m)

**Crypto:**
- BTC: `bc1qnedeq3dr2dmlwgmw2mr5mtpxh45uhl395prr0d`
- ETH: `0x1bCbBa9854dA4Fc1Cb95997D5f42006055282e3c`
- SOL: `3Wm8wS93UpG2CrZsMWHSspJh7M5gQ6NXBbgLHDFXmAdQ`

## Contributing

Personal project. If something's broken, open an issue with a repro and I'll try to get it addressed. PRs welcome but small and focused, anything bigger than a fix or a single-file feature, please open an issue first so we can talk about whether it fits.
