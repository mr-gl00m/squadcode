// Invariant: the ** glob token matches "zero or more path segments". The
// canonical pattern src/**/*.ts is documented in tools/glob.ts:18 as the
// example pattern: "List files matching a glob pattern (e.g. \"src/**/*.ts\")".
// Standard glob semantics (minimatch globstar, bash globstar, Node fast-glob)
// match this pattern against both src/foo/bar.ts AND src/file.ts.
// Violation: scan.ts compiles ** by replacing it with regex `.*` (no slash
// elision). The compiled regex requires a literal `/` between the `**`
// substitution and the trailing `*.ts`, so `src/file.ts` (zero
// intermediate segments) does not match.
// Predicted failure: assertion that matchesGlob("src/file.ts",
// "src/**/*.ts") === true fails because the compiled regex returns false.

import { expect, it } from "vitest";
import { matchesGlob } from "../../src/tools/scan.js";

it("matchesGlob with src/**/*.ts matches files at the top of src/", () => {
  expect(matchesGlob("src/file.ts", "src/**/*.ts")).toBe(true);
});
