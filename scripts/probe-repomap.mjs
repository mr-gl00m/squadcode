// One-off probe: build the repo map for the current working dir and print it.
// Run after `npm run build`:
//
//   node scripts/probe-repomap.mjs [tokenBudget]
//
// Default budget is 1024 tokens.

import { buildRepoMap } from "../dist/src/repomap/index.js";

const budget = parseInt(process.argv[2] ?? "1024", 10);
const start = Date.now();
const result = await buildRepoMap({
  cwd: process.cwd(),
  tokenBudget: budget,
});
const elapsed = Date.now() - start;

console.log("=".repeat(60));
console.log(result.text || "(empty repo map)");
console.log("=".repeat(60));
console.log(
  `files considered: ${result.filesConsidered}, ` +
    `files included: ${result.filesIncluded}, ` +
    `est. tokens: ${result.estimatedTokens}, ` +
    `elapsed: ${elapsed}ms`,
);
