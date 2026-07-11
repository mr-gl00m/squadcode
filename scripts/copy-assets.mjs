import { cpSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Non-TS files tsc doesn't copy on its own. Keep this list short — anything
// here is a runtime asset the compiled binary needs alongside its .js files.
const ASSETS = [
  [
    "src/providers/default-models.json",
    "dist/src/providers/default-models.json",
  ],
  [
    "src/prompts/subagent-output-format.md",
    "dist/src/prompts/subagent-output-format.md",
  ],
  // Built-in subagent defs (a directory of .md files).
  ["src/agents/built-in", "dist/src/agents/built-in"],
];

for (const [src, dest] of ASSETS) {
  mkdirSync(dirname(dest), { recursive: true });
  // recursive copies a directory; on a single file it's a harmless no-op flag.
  cpSync(src, dest, { recursive: true });
}
