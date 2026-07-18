# Flag ↔ slash duality

**Invariant:** every CLI flag that sets *session state* has a matching slash
command with the same name, and every slash command that changes session state
has a matching flag. Same name on both sides. A flag lets you set the state at
launch; the slash lets you change it mid-session. Neither side should be able to
do something to the session the other can't.

This exists so muscle memory transfers in both directions: if you know
`--model`, you can guess `/model`, and vice versa. It's an onboarding and
least-surprise guarantee, not a hard architectural constraint.

## Audit (current)

| Flag | Slash | Notes |
|------|-------|-------|
| `--model <name>` | `/model <name>` | pair |
| `--provider <name>` | `/provider <name>` | pair |
| `--mode <act\|plan>` | `/mode [act\|plan]` | pair |
| `--yolo` | `/yolo` | pair; `/yolo` toggles off too |
| `--resume [id]` | `/resume [id]` | pair |
| `--continue` | `/resume` (no arg) | `--continue` = "resume most recent for cwd". In-REPL, the current session was just created, so `/resume` with no arg resumes the most recent **other** session in the dir, the same intent. |
| `--replay [id]` | `/replay [n]` | pair. Not session state, a display-only preroll of the last N turns, but a same-name twin: the flag prerolls a session at launch, the slash prerolls the current session mid-run. |

Every session-state flag is covered.

## Deliberate exceptions (flag-only, by design)

These flags have no slash twin on purpose. They are not session state you toggle
mid-conversation:

**Startup / host selection**, meaningless to change after the process is up:

- `-p, --print <prompt>`, one-shot print mode is an entry point, not a state.
- `--simple`, picks the readline REPL vs Ink at launch; the host is already
  chosen by the time a slash could run.
- `--output-format <text|stream-json>`, print-mode stdout shape, fixed for the run.

**Security config**, runtime-toggleable would be a footgun:

- `--allowed-tools <list>` / `--disallowed-tools <list>`, the session's tool
  allow/denylist. A `/allowed-tools` that *widened* the allowlist mid-session
  would let a model talk its way into more tools than you launched with. Set it
  at the door.
- `--dangerously-skip-permissions`, same reasoning. The in-REPL way to drop
  prompts is `/yolo`, which is gated by the sandbox + archive-on-delete +
  checklist rails. There is intentionally no bare "skip all prompts now" slash.
- `--dangerously-skip-read-permissions`, read-scoped sibling of the above:
  auto-allows file reads under the project dir (bypassing the sensitive-file
  layer for in-project paths; reads outside cwd stay gated). Same footgun
  reasoning, a slash that widened read access mid-session would let a model
  talk its way past the `.env`/key prompts it launched under. Set it at the
  door. It's the intended switch behind a read-only `wtf`-style diagnostic.
- `--dangerously-allow-deletes`, disables the always-on delete guard (which
  otherwise rewrites deletes to a move into `.deleted/` and blocks ones it can't
  rewrite). Flag-only by the same logic: a mid-session `/allow-deletes` would let
  a model argue its way out of the failsafe it was launched under. The guard's
  whole point is that the model can never turn it off, only the user can, at the
  door.

## Slash-only (no flag, by design)

Interactive actions with nothing to set at launch: `/clear`, `/compact`,
`/cost`, `/usage`, `/tools`, `/sessions`, `/receipt`, `/output-style`,
`/skills`, `/help`, `/exit`. Skills (`/<skill-name>`) stay slash-only too.

## When you add a session-state flag

1. Add the flag to `src/cli/program.ts`.
2. Add the same-named slash to `src/cli/slash.ts` (`HELP` + a `case`).
3. Wire the handler in **both** REPL hosts (`src/cli/repl.tsx` and
   `src/cli/simple-repl.ts`), a slash that only works in one host breaks the
   duality for `--simple` users.
4. Update the table above.

If the new flag is startup-only or security config, add it to the exceptions
list instead and say why, the invariant is "session state," not "all flags."
