# CrabMeat ↔ Squad integration contract

_Version 1. Last updated 2026-06-13 (Squad v1.3.0+, Phase 18 / v1.4 work)._

Two independent directions. Neither replaces the other. Squad stays a vetting
harness that drives a model through one canonical agent loop; CrabMeat stays the
routing brain that decides which model. This document pins the wire formats so
neither side breaks the other silently, reference it from both repos.

## Direction A: CrabMeat drives Squad (stream-json)

CrabMeat runs Squad as an agent-loop executor and consumes its output as
newline-delimited JSON:

```
squad -p "<task>" --output-format stream-json --model <picked>
```

stdout is one JSON object per line. The first line is always `init`, carrying the
schema version a consumer must check before parsing the rest:

| record        | fields |
|---------------|--------|
| `init`        | `schema_version` (string), `sessionId`, `provider`, `model`, `cwd`, `mode?`, `resumed?` |
| `message`     | `role: "assistant"`, `text`, `reasoning?`, flushed at each tool boundary and at turn end |
| `tool_use`    | `id`, `name`, `args` |
| `tool_result` | `id`, `name`, `ok`, `content`, `error?`, `reason?`, `artifact?` |
| `error`       | `code`, `message`, `retryable` |
| `result`      | `sessionId`, `provider`, `model`, `usage{input/cached/output/total Tokens}`, `costUsd`, `toolCalls`, `exitCode` |

Every record also carries a `ts` (ISO timestamp) and a `type` (the table key).
The current `schema_version` is **`1`** (exported as `STREAM_JSON_SCHEMA_VERSION`
in `src/cli/stream-json.ts`). A consumer that sees a higher major version it
doesn't recognize should refuse rather than guess.

stdout is pure NDJSON, diagnostics go to stderr. Process exit code is non-zero
when the `result` record's `exitCode` is non-zero (a stream error).

## Direction B: Squad delegates routing to CrabMeat (the `router` provider kind)

A catalog row of `kind: router` (in `~/.squad/models.json`) turns model selection
over to an external command. Default use case: CrabMeat.

```json
{
  "models": [
    {
      "id": "crabmeat-router",
      "provider_id": "crabmeat",
      "kind": "router",
      "base_url": "http://localhost",
      "router": { "command": ["node", "<crabmeat>/dist/route-entry.js"], "timeout_ms": 30000 }
    }
  ]
}
```

When Squad runs with `--model crabmeat-router`, on the first turn it writes a
routing payload to the command's **stdin** as one JSON object:

```json
{ "prompt": "<concatenated user messages>", "system": "<system prompt, if any>", "tools": ["Read", "Grep", "Shell", ...] }
```

The command prints a decision to **stdout** as JSON:

```json
{ "provider_id": "deepseek", "model_id": "deepseek-v4-pro", "rationale": "needs strong reasoning" }
```

`provider_id` + `model_id` are required; `rationale` is optional (logged). Squad
resolves that pair through its catalog, caches the decision for the rest of the
loop (it routes once per task, not once per turn), and drives the chosen model
through the normal canonical loop, rewriting the delegated request's `model` to
the decision's `model_id`. `base_url` on the router row is ignored.

CrabMeat implements this as the `crabmeat-route` bin (`dist/route-entry.js`,
with `crabmeat route` as the human-facing subcommand alias). Point the catalog
row at the dedicated bin, not the main CLI: the main CLI's import graph can
write a log line to stdout before the command dispatches, and this protocol
treats stdout as the answer. On Windows, spawn the bin as
`["node", "<path>/dist/route-entry.js"]`; `spawn` without a shell cannot
execute npm's `.cmd` shims. The route command classifies the task shape
deterministically and picks from the models Ollama actually has installed,
filtered to tool-capable models (per `/api/show`) whenever the payload lists
tools.

A router must resolve to a concrete model, **not another router**, a router
pointing at a router loops. A non-zero exit, non-JSON output, or a missing
`provider_id`/`model_id` surfaces as a `ROUTER_FAILED` canonical error.

## Round trip

The two directions compose: CrabMeat invokes Squad (Direction A) with
`--model crabmeat-router`; Squad's router (Direction B) asks CrabMeat which model
to use; CrabMeat answers; Squad drives that model and streams the result back as
stream-json, which CrabMeat consumes. This round trip is the integration's
end-to-end smoke, driven by `crabmeat/tools/squad-roundtrip.mjs` in the CrabMeat
repo. It needs a live local backend, so it cannot run from Squad's offline test
suite; Squad's side of both directions stays tested offline
(`test/router.test.ts`, `test/stream-json.test.ts`).

**Ran green 2026-07-06** on live Ollama: the driver invoked Squad, Squad's
router consulted `crabmeat-route`, CrabMeat answered
`ollama/qwen3.6:latest` (rationale: task shape "code", tool-capable pick from
12 local tags), Squad drove the model through the loop (one `Write` dispatch),
the task's file landed on disk byte-exact, and every stdout line parsed as
contract records with `schema_version: "1"`. The first attempt surfaced two
real bugs the offline suites could not see: Squad's router delegated with
`req.model` still naming the router row (fixed in `providers/router.ts`, test
pinned), and CrabMeat routed a tools task to a model without tool support
(fixed by the `/api/show` capability filter).

## Versioning

Bump `STREAM_JSON_SCHEMA_VERSION` when a record's shape changes in a way a
Direction-A consumer must adapt to. The router payload/decision shapes are
versioned implicitly by this document's version header; a breaking change to
either is a new document version and a coordinated change in both repos.
