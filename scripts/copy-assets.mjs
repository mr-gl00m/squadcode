import { cpSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Non-TS files tsc doesn't copy on its own. Keep this list short — anything
// here is a runtime asset the compiled binary needs alongside its .js files.
const ASSETS = [
  ["src/providers/default-models.json", "dist/src/providers/default-models.json"],
];

for (const [src, dest] of ASSETS) {
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
}
