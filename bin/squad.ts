#!/usr/bin/env node
import { start } from "../src/index.js";
import { flushLogger } from "../src/logger.js";

process.removeAllListeners("warning");
process.on("warning", (warning: Error & { code?: string }) => {
  if (warning.name === "DeprecationWarning" && warning.code === "DEP0040") return;
  process.stderr.write(`(node) ${warning.name}: ${warning.message}\n`);
});

try {
  await start(process.argv);
} catch (err: unknown) {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await flushLogger();
}
