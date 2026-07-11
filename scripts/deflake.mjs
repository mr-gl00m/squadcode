import { spawnSync } from "node:child_process";

// Repeated-run flake detector. Runs a command N times and reports the pass rate
// plus duration spread, so a timing-sensitive E2E test that passes once but
// fails one-in-twenty gets caught before it lands in CI as an intermittent.
//
//   npm run deflake -- --runs=20 --command="npx vitest run test/shell-hardening.test.ts"
//   npm run deflake -- --runs=50 --command="node dist/bin/squad.js -p hi" --bail --quiet
//
// Flags:
//   --runs=N      iterations (default 10)
//   --command=... the shell command to run each iteration (required)
//   --bail        stop at the first failure
//   --quiet       suppress child stdout/stderr; show only the summary
//
// Exit code is 0 only when every run passed.

function parseArgs(argv) {
  const opts = { runs: 10, command: undefined, bail: false, quiet: false };
  for (const arg of argv) {
    if (arg === "--bail") opts.bail = true;
    else if (arg === "--quiet") opts.quiet = true;
    else if (arg.startsWith("--runs=")) opts.runs = Number(arg.slice(7));
    else if (arg.startsWith("--command=")) opts.command = arg.slice(10);
    else {
      console.error(`deflake: unrecognized argument "${arg}"`);
      process.exit(2);
    }
  }
  return opts;
}

function fail(message) {
  console.error(`deflake: ${message}`);
  process.exit(2);
}

const opts = parseArgs(process.argv.slice(2));

if (!opts.command || opts.command.trim().length === 0) {
  fail('--command="..." is required (the command to run each iteration)');
}
if (!Number.isInteger(opts.runs) || opts.runs < 1) {
  fail(`--runs must be a positive integer (got "${opts.runs}")`);
}

console.log(`deflake: ${opts.runs} runs of: ${opts.command}\n`);

const durations = [];
const failedRuns = [];

for (let i = 1; i <= opts.runs; i += 1) {
  const start = Date.now();
  const result = spawnSync(opts.command, {
    shell: true,
    stdio: opts.quiet ? "ignore" : "inherit",
  });
  const elapsed = Date.now() - start;
  durations.push(elapsed);

  // spawnSync sets .error on a spawn failure (command not found, etc.);
  // otherwise .status is the exit code (null if killed by signal).
  const ok = !result.error && result.status === 0;
  if (!ok) failedRuns.push(i);

  const tag = ok ? "PASS" : "FAIL";
  const detail = result.error
    ? ` (${result.error.message})`
    : result.signal
      ? ` (signal ${result.signal})`
      : result.status !== 0
        ? ` (exit ${result.status})`
        : "";
  console.log(`  run ${i}/${opts.runs}: ${tag} in ${elapsed}ms${detail}`);

  if (!ok && opts.bail) {
    console.log("\ndeflake: bailing on first failure (--bail)");
    break;
  }
}

const ran = durations.length;
const passes = ran - failedRuns.length;
const min = Math.min(...durations);
const max = Math.max(...durations);
const avg = Math.round(durations.reduce((a, b) => a + b, 0) / ran);
const passRate = ((passes / ran) * 100).toFixed(1);

console.log("\ndeflake summary");
console.log(`  ran:       ${ran}/${opts.runs}`);
console.log(`  passed:    ${passes}  (${passRate}%)`);
console.log(
  `  failed:    ${failedRuns.length}${failedRuns.length > 0 ? `  [runs ${failedRuns.join(", ")}]` : ""}`,
);
console.log(`  duration:  min ${min}ms / avg ${avg}ms / max ${max}ms`);

if (failedRuns.length === 0) {
  console.log("\ndeflake: clean — all runs passed");
  process.exit(0);
}
console.log(`\ndeflake: FLAKY — ${failedRuns.length}/${ran} runs failed`);
process.exit(1);
