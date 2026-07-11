#!/usr/bin/env node
// Must precede every other import: this installs the warning filter before the
// dependency that loads Node's deprecated `punycode` builtin gets evaluated.
import "../src/suppress-warnings.js";
import { start } from "../src/index.js";
import { flushLogger } from "../src/logger.js";

try {
  await start(process.argv);
} catch (err: unknown) {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await flushLogger();
}
