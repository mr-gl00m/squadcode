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

Squad Code is the modern streaming-agent CLI shape: streaming chat, tool use, sessions, ask/allow/deny permissions, JSONL transcripts; wired to any frontier model behind one `LLMProvider` interface. Every provider stream gets normalized into a single `CanonicalEvent` union (`text_delta`, `tool_call_done`, `tool_result`, `usage`, `done`, `error`); the agent loop never sees provider-specific wire formats. MVP backend is DeepSeek; Ollama works for local inference today; OpenAI and Anthropic adapters are post-MVP. It exists because vetting local models against real tool-use loops needs a harness that doesn't smuggle in provider-specific assumptions, and the existing options either tie themselves to one vendor or skip the agent loop entirely. I intend on adding additional model options and features in the future. 

## Quickstart

Requires Node 22+ and running local Ollama (or a Deepseek API key).

```bash
git clone <this repo>
cd proj_ai_squad_code
npm install
cp .env.example .env
# edit .env to set DEEPSEEK_API_KEY=sk-...
npm run build

# one-shot
node dist/bin/squad.js -p "summarize src/"

# interactive REPL
node dist/bin/squad.js

# Ollama instead of DeepSeek
ollama pull llama3.2
node dist/bin/squad.js --provider ollama --model llama3.2
```

`npm install -g .` (or `npm link`) puts `squad` and `squadcode` on your PATH if you'd rather not type the full path.

State lives under `~/.squad/`: settings, rotating logs, JSONL session transcripts, and the `audit.db` SQLite file. Nothing leaves the machine except calls to the provider you configured.

## How it works

The throughline is a single canonical event stream. Each provider adapter — `src/providers/deepseek.ts`, `src/providers/ollama.ts` — translates its native streaming format (DeepSeek's OpenAI-compatible deltas, Ollama's `/api/chat` chunks) into the same `CanonicalEvent` union defined in `src/providers/types.ts`. The agent loop in `src/engine/loop.ts` reads canonical events, collects `tool_call_done` events at turn boundaries, runs each call through the permission policy, executes the matching tool from the registry, appends the result back as a tool message, and re-streams until the model stops calling tools or `max_turns` hits. Adding a provider means writing one adapter, not touching the loop.

Permissions split read-only from mutating: `Read`, `Grep`, `Glob`, and `TodoWrite` auto-allow within the cwd-anchored allowed root; `Write`, `Edit`, and `Shell` prompt synchronously by default. The prompt offers a per-project persistent grant that lands in `.squad/settings.json` so you don't re-approve the same `Shell npm run test` on every invocation. Path-traversal validation runs on every filesystem-touching call, symlinks resolved with `realpath` and re-checked.

Persistence is two structures with two jobs. JSONL transcripts under `~/.squad/sessions/<id>.jsonl` exist for replay — append-only with `fsync` per turn, indexed for fast `sessions list` lookup by SQLite at `~/.squad/sessions.db`. The audit chain at `~/.squad/audit.db` exists for tamper-evidence — every prompt, tool call, tool result, and permission decision lands as a row with a `prev_hash` link to the prior row. Mid-turn kill, restart with `--resume`, the conversation continues; the audit chain validates end-to-end. SQLite runs in WAL mode with parameterized statements only.

## Examples

```bash
# scope tools per-session
squadcode --allowed-tools Read,Grep,Glob -p "find duplicated regex patterns in src/"

# bypass the prompt for a one-off automation run
squadcode --dangerously-skip-permissions -p "rewrite README.md to fix typos"

# resume by id
squadcode --resume 4f9c1a2e-1b3d-4a8c-9f1e-2b3c4d5e6f7a

# in the REPL
> /provider ollama
> /model qwen2.5-coder:32b
> /cost
> /tools
> /sessions
> /clear
```

## Status

**v1.0.0** — MVP shipped. The five MVP commands (`squadcode`, `squadcode -p ...`, `squadcode --model ... -p ...`, `squadcode --resume`) stream end-to-end against real DeepSeek calls with the tool loop, permission prompts, and JSONL transcripts working. Ollama provider works for local inference. The Ink REPL ships alongside a `--simple` readline fallback. Used daily by the author to vet local models against real tool-use loops.

OpenAI and Anthropic adapters are post-MVP; both are pending in the v1.x cycle. Single-user, single-machine, no remote sessions.

## What this isn't

Not an IDE plugin or a hosted product. This is a different beast. Squad Code's job is vetting models (local and frontier) against the same agent loop, run from a terminal. This is NOT a managed service. There is no cloud, no telemetry, no error reporting, no analytics. It is not yet OpenAI/Anthropic-ready... But soon. Those adapters land in v1.x; today the proven backend is DeepSeek with Ollama as the local option. Not MCP, not hooks, not plugins, not an IDE bridge; those are on the deferred wall, not the roadmap.

## Roadmap

- v1.1: OpenAI Responses API adapter, Anthropic Messages API adapter, subagent layer (`Agent` tool, depth=1, four concurrent slots, per-agent model selection).
- Polish: markdown rendering in the REPL, syntax highlighting, per-provider cost accounting, `--output-format json` and `--output-format stream-json`.
- Indefinitely deferred: MCP servers, custom agents-as-config, hooks, plugins, IDE bridge, remote sessions, auto-compaction beyond `/compact`.
- Compatibility with other tools/projects created by me.

## License

[MIT](./LICENSE). Copyright © 2026 Nathan Seals / Nexus Labs

## Contributing

Personal project. If something's broken, open an issue with a repro and I'll try to get it addressed. PRs welcome but small and focused, anything bigger than a fix or a single-file feature, please open an issue first so we can talk about whether it fits.
