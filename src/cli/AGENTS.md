# CLI module boundaries

The CLI follows the repository's 500-line target and 800-line hard stop.

- `repl-app.tsx` is the orchestration shell and must not grow. Put composer,
  input, permission, slash-command, turn, or presentation work in its existing
  focused module.
- `program.ts` only registers commands. Provider resolution, session bootstrap,
  print execution, REPL execution, shootout, hooks, prompts, and persistence
  belong in the corresponding `program-*` or support module.
- Keep `repl-turn-controller.ts` focused on one model turn. New interaction
  features should use a separate controller and a narrow dependency object.
- Snapshot-visible Ink components belong in `repl-presentation.tsx` and require
  an unchanged or deliberately reviewed `test/ink-snapshots.test.tsx` result.
