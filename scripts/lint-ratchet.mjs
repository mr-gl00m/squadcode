import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const baseline = JSON.parse(
  readFileSync(join(process.cwd(), "config", "biome-baseline.json"), "utf8"),
);
const biomeEntry = join(
  process.cwd(),
  "node_modules",
  "@biomejs",
  "biome",
  "bin",
  "biome",
);
const run = spawnSync(
  process.execPath,
  [biomeEntry, "check", "--reporter=json"],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  },
);
const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
const jsonStart = output.indexOf("{");
if (jsonStart < 0) {
  process.stderr.write(output);
  throw new Error("Biome did not emit its JSON report");
}

const summary = output
  .slice(jsonStart, jsonStart + 1000)
  .match(/"errors":(\d+),"warnings":(\d+),"infos":(\d+)/);
if (!summary) {
  process.stderr.write(output);
  throw new Error("Could not parse Biome JSON summary");
}

const errors = Number(summary[1]);
const warnings = Number(summary[2]);
const infos = Number(summary[3]);
process.stdout.write(
  `Biome diagnostics: ${errors} errors, ${warnings}/${baseline.warnings} warnings, ${infos}/${baseline.infos} infos\n`,
);
const regressions = [];
if (errors > 0) regressions.push(`${errors} error(s)`);
if (warnings > baseline.warnings) {
  regressions.push(
    `warnings increased from ${baseline.warnings} to ${warnings}`,
  );
}
if (infos > baseline.infos) {
  regressions.push(`infos increased from ${baseline.infos} to ${infos}`);
}
if (regressions.length > 0) {
  process.stderr.write(`${regressions.join("; ")}\n`);
  process.exitCode = 1;
}
