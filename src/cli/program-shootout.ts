import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadConfigurationStack } from "../config/stack.js";
import { buildPolicyFromCli } from "../permissions/policy.js";
import { makeEnvFromProcess } from "../providers/dispatch.js";
import { saveShootoutRun } from "../sessions/shootout-store.js";
import { sanitizeForTerminal } from "../terminal.js";
import { loadManifest } from "../tools/manifest.js";
import { createToolRegistry } from "../tools/registry.js";
import { buildProviderForModel } from "./runtime-resolution.js";
import { runShootout, type ShootoutSlotSpec } from "./shootout.js";
import { formatShootoutReport } from "./shootout-report.js";
import { prepareRepoMap } from "./system-prompt.js";

export function splitModels(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function resolvePromptArg(prompt: string): string {
  if (prompt.startsWith("@")) {
    try {
      return readFileSync(prompt.slice(1), "utf-8");
    } catch {
      return prompt;
    }
  }
  return prompt;
}

export async function runShootoutCli(args: {
  prompt: string;
  models: string[];
  maxTurns?: number;
}): Promise<void> {
  const cwd = process.cwd();
  const config = await loadConfigurationStack({ cwd });
  const { env, catalog } = config;
  const dispatchEnv = makeEnvFromProcess(env.OLLAMA_ALLOW_REMOTE);
  const manifest = loadManifest(cwd);
  const { fragment: repoMap } = await prepareRepoMap(cwd, manifest !== null);

  const slots: ShootoutSlotSpec[] = [];
  for (const model of args.models) {
    const entry = catalog.get(model);
    if (!entry) {
      process.stderr.write(`shootout: skipping "${model}" — not in catalog\n`);
      continue;
    }
    const provider = buildProviderForModel(
      catalog,
      entry.provider_id,
      model,
      dispatchEnv,
    );
    if (typeof provider === "string") {
      process.stderr.write(
        `shootout: skipping "${model}" — ${sanitizeForTerminal(provider)}\n`,
      );
      continue;
    }
    slots.push({
      label: model,
      provider,
      providerId: entry.provider_id,
      modelId: model,
    });
  }
  if (slots.length === 0) {
    process.stderr.write("shootout: no resolvable models\n");
    process.exitCode = 2;
    return;
  }

  const policy = buildPolicyFromCli({
    defaultMode: env.CLI_PERMISSION_MODE,
    cwd,
    mode: "act",
  });
  const runId = randomUUID().slice(0, 8);
  process.stderr.write(
    `shootout ${runId}: ${slots.length} slot(s) — ${slots
      .map((slot) => slot.label)
      .join(", ")}\n`,
  );
  const run = await runShootout({
    prompt: args.prompt,
    cwd,
    slots,
    registryFactory: () => createToolRegistry({ manifest, repoMap }),
    policy,
    isolate: true,
    ...(args.maxTurns !== undefined && { maxTurns: args.maxTurns }),
    runId,
    createdAt: new Date().toISOString(),
  });
  const dir = await saveShootoutRun(run.manifest, run.perSlotEvents);
  process.stdout.write(
    `${formatShootoutReport(run.manifest)}\n\nsaved to ${sanitizeForTerminal(dir)}\n`,
  );
}
