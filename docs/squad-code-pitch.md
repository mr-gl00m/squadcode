# Squad Code

**A provider-neutral terminal agent for Anthropic, OpenAI, DeepSeek, and local models.**

> Project pitch · Nexus Labs · v0.1
> Working brand: *Squad Code* (codename: `squad`)

---

## One-Line Pitch

A clean-room, local-first CLI agent that gives you the modern streaming-agent interaction model, streaming chat, tool use, sessions, permissions, and speaks fluently to **any** frontier model through a single normalized protocol.

## The Itch

The existing options each tie themselves to one vendor's wire format end-to-end: vendor-shaped messages, vendor-shaped tool calls, vendor-shaped beta headers all the way down. If you want the same workflow against GPT-5.1 or DeepSeek V4, for cost, for redundancy, for second opinions, or just because the model that's right for *this* task isn't always the same one, you're stuck juggling separate tools with separate mental models, or paying frontier rates for everything.

Squad Code is the answer most people would pay for if anyone bothered to ship it. The integration work is not hard. It is just unglamorous, and the vendor-locked incumbents have no incentive to do it. So I will.

## What It Does

One binary. One config. DeepSeek first, other adapters next. Same loop.

```
squad                                             # interactive REPL
squad -p "summarize src/"                         # one-shot, default provider
squad -p "find likely bugs"                       # DeepSeek-backed code review
squad --model deepseek-v4-pro                     # switch DeepSeek model in REPL mode
squad --resume                                    # pick up the last session
squad sessions                                    # list and search past runs
```

The REPL behaves the way a working programmer expects in 2026: streaming output, Ctrl-C interrupts mid-stream, slash commands for control, a permissions prompt when a tool wants to touch the disk, and a JSONL transcript on disk you can grep, replay, or pipe into anything else.

## Why It Hasn't Been Built (And Why I'm Building It Anyway)

This is a recurring pattern in my work: integration problems where the technology is solved but the incentives are misaligned. The vendors won't unify their interfaces because fragmentation is a moat. The wrappers that exist (LiteLLM, OpenRouter, etc.) solve the API-translation half but leave the agent-loop half, tools, permissions, sessions, REPL ergonomics, as an exercise for the reader.

So most people end up running three different tools or writing janky shell scripts. The actual hard parts of an agent loop have been figured out by Anthropic and others; the work that remains is normalization plumbing and a sensible default policy. That is a weekend-and-a-half of focused work, not a research project.

The meta-thesis applies cleanly here: *so many things are already solved; people are just too interested in money to give two shits.*

## Architecture

The core insight is that **the agent loop is provider-independent**. Once you have a canonical event stream, `text_delta`, `tool_call_start`, `tool_call_delta`, `tool_call_done`, `usage`, `done`, `error`, every provider becomes an adapter. Claude's Messages API, OpenAI's Responses API, and DeepSeek's OpenAI-compatible endpoints all map cleanly into that shape. The agent, the tools, the permissions, the session writer, the renderer, none of those need to know which provider is upstream.

```
src/
  cli/          # commander entry, REPL, print mode, slash commands
  config/       # .env loading, model registry, validation (zod)
  providers/    # the only Anthropic/OpenAI/DeepSeek-aware code
    types.ts        # LLMProvider interface, CanonicalEvent union
    anthropic.ts
    openai.ts
    deepseek.ts
  engine/       # conversation state, agent loop, streaming, token budget
  tools/        # Read, Write, Edit, Shell, Grep, Glob, TodoWrite
  permissions/  # ask / allow / deny policy, interactive prompts
  sessions/     # JSONL transcripts, resume, list, search
  ui/           # terminal renderer, markdown, syntax highlighting
```

### Provider Interface

The single contract every adapter must satisfy:

```ts
interface LLMProvider {
  name: "anthropic" | "openai" | "deepseek";
  listModels?(): Promise<ModelInfo[]>;
  stream(req: CanonicalRequest): AsyncIterable<CanonicalEvent>;
  complete(req: CanonicalRequest): Promise<CanonicalResponse>;
}
```

Adapters do all the dirty work, translating tool-use blocks, reasoning deltas, beta headers, prompt caching hints, and the various ways each vendor emits "I want to call a tool", into the canonical events. Everything downstream sees one shape.

### Stack

- **Runtime:** Bun (with Node 22 fallback)
- **CLI:** commander
- **Config:** dotenv + zod validation
- **REPL:** Ink for the rich path, plain readline as a `--simple` fallback
- **Provider SDKs:** `@anthropic-ai/sdk`, `openai` (covers DeepSeek via base-URL override)
- **Persistence:** JSONL transcripts; SQLite index for session search if it earns its weight

### `.env` Contract

```env
AI_DEFAULT_PROVIDER=deepseek
AI_DEFAULT_MODEL=deepseek-v4-flash

ANTHROPIC_API_KEY=...
ANTHROPIC_BASE_URL=

OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-5.1

DEEPSEEK_API_KEY=...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash

CLI_SESSION_DIR=.squad/sessions
CLI_PERMISSION_MODE=ask
CLI_MAX_TOOL_CONCURRENCY=4
```

## Build Plan

Bottom-up, each phase end-to-end runnable before moving to the next.

**Phase 0, Scaffolding.** Bun project, commander wired, `.env` loaded and validated, `squad --version` and `squad --help` work. The skeleton walks before anything else gets built on it.

**Phase 1, Canonical model + DeepSeek adapter.** Define the internal message and event types. Implement the first adapter against DeepSeek using the OpenAI-compatible endpoint and `.env` credentials. Get `squad -p "hello"` streaming text to the terminal. No tools yet, no REPL, just prove the pipe with the API I already pay for.

**Phase 2, Tool loop.** Implement `Tool` interface and the starter set: Read, Write, Edit, Shell, Grep, Glob, TodoWrite. Wire the agent loop: stream → collect tool calls → execute → append results → continue until no more tool calls or `max_turns` hits. Permissions land here too, read-only tools auto-allow, mutating tools prompt by default, with `--allowed-tools`, `--disallowed-tools`, and `--dangerously-skip-permissions` flags.

**Phase 3, Interactive REPL.** Ink UI: prompt box, streaming output, Ctrl-C interrupt, slash commands (`/provider`, `/model`, `/clear`, `/resume`, `/help`), live status line showing provider, model, turn count, token usage. This still runs on DeepSeek only for the first MVP.

**Phase 4, Sessions.** JSONL transcripts containing provider, model, cwd, full message history, tool results, usage. `squad --resume`, `squad --continue`, `squad sessions list`, `squad sessions show <id>`.

**Phase 5, OpenAI adapter.** Target the Responses API (current OpenAI guidance for new agentic projects). Map tool calls and reasoning deltas into the canonical shape. The agent loop should not need a single change, that's the test of whether the abstraction is actually working.

**Phase 6, Anthropic adapter.** Implement Claude's Messages API after the DeepSeek MVP is useful. Claude support is still part of the provider-neutral vision, but it is not the first paid-for path.

**Phase 7, Polish.** Markdown rendering, syntax highlighting, cost/token accounting per provider, `--output-format json` and `--output-format stream-json` for piping into other tools.

**Deferred (post-1.0).** MCP, custom agents, hooks, plugins, IDE bridge, remote sessions, auto-compaction. Every one of these is a known shape; none of them belong in the MVP.

## MVP Definition (Done = Shipped)

```
squad
squad -p "summarize src"
squad -p "find likely bugs"
squad --model deepseek-v4-pro -p "review this patch"
squad --resume
```

All of the above streaming through DeepSeek, authenticated from `.env`, with a working tool loop (Read, Write, Edit, Shell, Grep) gated by permissions, and JSONL sessions on disk. That's the first MVP bar. OpenAI and Anthropic adapters are v1.1 work unless DeepSeek blocks a core workflow.

## Design Principles

- **Local-first.** No cloud dependency beyond the model APIs themselves. Sessions on disk, config in `.env`, transcripts in JSONL. No phone-home telemetry, ever.
- **MIT licensed.** This belongs to anyone who needs it.
- **Provider-neutral by construction.** If a feature can only exist for one provider, it goes behind a capability flag, never into the core loop.
- **Readable over clever.** The agent loop should fit on one screen and read like prose. If it doesn't, the abstraction is wrong.
- **AI as force multiplier on architecture, not replacement for it.** Frontier models are excellent at writing the OpenAI adapter once the canonical interface is locked. The interface itself is mine to design.

## Risks

- **Provider drift.** OpenAI's Responses API is still moving; Anthropic ships beta headers; DeepSeek's tool support varies by model. Mitigation: adapters are isolated, capability flags surface what each provider actually supports, and the canonical event set is permissive (a missing event type degrades gracefully).
- **Tool semantics divergence.** Anthropic's structured tool blocks and OpenAI's function calling don't map 1:1 in edge cases (parallel tool calls, streaming partial arguments, tool-call-in-reasoning). Mitigation: pick the semantics of the most expressive provider as canonical, downgrade for the others, accept that some advanced features will be Anthropic-only at first.
- **Scope creep.** This category of project devours weekends. Mitigation: the deferred list above is treated as a hard wall, not a roadmap. v1.0 ships before v1.1 starts.
- **Yet-another-wrapper fatigue.** LiteLLM and OpenRouter exist. Differentiator: those are translation layers; Squad Code is the agent on top. The competition isn't them, it's "running three CLIs in three terminals."

## Why This Project, Why Now

Three live concerns line up:

1. **Cost asymmetry.** Routine code review against DeepSeek at a fraction of the cost, with one keystroke to escalate to Claude when the answer matters, is a real workflow improvement, not a benchmark gimmick.
2. **Second-opinion habit.** Pattern from MAGI Conclave and the multi-AI peer review on the Geometry of Nothing paper: different models genuinely catch different things. A CLI that makes that one-flag-easy is worth building.
3. **Reference architecture for the canonical-event idea.** A clean implementation of "all frontier providers behind one event stream" is a reusable foundation. CrabMeat could consume it. So could anything else that wants provider neutrality without rolling its own normalization.

## Status

- Reference codebase inspected; architecture extracted.
- Provider-neutral redesign settled, with DeepSeek-first MVP sequencing. This pitch is the spec.
- Next: Phase 0 scaffold, `bun init`, commander entry, `.env` plumbing, `squad --help`.
