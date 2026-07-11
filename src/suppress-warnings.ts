// Side-effect-only module. bin/squad.ts imports this FIRST, ahead of any app
// or dependency import, because ESM fully evaluates each imported module before
// the next. A transitive dependency pulls in Node's deprecated builtin
// `punycode`, which fires process.emitWarning(..., "DEP0040") the instant it's
// required — during the import phase. Installing the filter here, before those
// imports run, is the only point early enough to catch it; doing it in the bin
// body (after `import "../src/index.js"`) is already too late.
//
// Only DEP0040 is dropped. Every other warning is reformatted and passed
// through, so genuine deprecations still surface.
process.removeAllListeners("warning");
process.on("warning", (warning: Error & { code?: string }) => {
  if (warning.name === "DeprecationWarning" && warning.code === "DEP0040") {
    return;
  }
  process.stderr.write(`(node) ${warning.name}: ${warning.message}\n`);
});
