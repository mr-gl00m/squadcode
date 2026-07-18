# Repository instructions

## Source-file size discipline

- Target 500 lines for maintained source files.
- 800 lines is a hard stop: do not add or leave a maintained source file above
  it. Split by responsibility before merging.
- Generated files, vendored code, fixtures, and committed schemas are exempt
  when their provenance is clear.
- A file between 500 and 800 lines is a prompt to extract the next coherent
  responsibility, not permission to keep accumulating unrelated behavior.
- Keep `src/engine/loop.ts` structurally stable. It is inside the hard stop and
  is not part of the Phase F decomposition; new subsystems should meet it at an
  injected interface rather than enlarging it.

Run `test/loc-policy.test.ts` when adding or moving maintained TypeScript.
