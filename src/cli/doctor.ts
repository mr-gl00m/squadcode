import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import {
  type LoadedConfiguration,
  loadConfigurationStack,
} from "../config/stack.js";
import type { SessionStore } from "../sessions/store.js";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  area: "install" | "config" | "auth" | "runtime";
  name: string;
  status: DoctorStatus;
  detail: string;
}

export async function diagnoseConfiguration(
  configuration: LoadedConfiguration,
  cwd: string,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number.parseInt(
    process.versions.node.split(".")[0] ?? "0",
    10,
  );
  checks.push({
    area: "install",
    name: "node",
    status: nodeMajor >= 22 ? "pass" : "fail",
    detail: `Node ${process.versions.node}; requires >=22`,
  });

  const providerEntry = configuration.stack.explain("runtime.provider");
  const modelEntry = configuration.stack.explain("runtime.model");
  checks.push({
    area: "config",
    name: "provider",
    status: configuration.provider ? "pass" : "fail",
    detail: `${configuration.provider || "(unset)"} from ${providerEntry?.source ?? "unknown"}`,
  });
  checks.push({
    area: "config",
    name: "model",
    status: configuration.model ? "pass" : "fail",
    detail: `${configuration.model || "(unset)"} from ${modelEntry?.source ?? "unknown"}`,
  });
  checks.push({
    area: "config",
    name: "provenance",
    status: "pass",
    detail: `${configuration.stack.list().length} effective keys carry source metadata`,
  });
  checks.push({
    area: "config",
    name: "hooks",
    status: configuration.hooks.invalidCount > 0 ? "warn" : "pass",
    detail:
      configuration.hooks.invalidCount > 0
        ? `${configuration.hooks.invalidCount} invalid hook entries ignored`
        : `${configuration.hooks.hooks.length} valid hook entries`,
  });

  const selected = configuration.catalog.get(configuration.model);
  checks.push({
    area: "runtime",
    name: "catalog resolution",
    status: selected?.provider_id === configuration.provider ? "pass" : "fail",
    detail: selected
      ? `${selected.id} -> ${selected.provider_id}/${selected.kind}`
      : `${configuration.model} is not present in the model catalog`,
  });

  if (selected?.env_key_var) {
    const envValue = (configuration.env as unknown as Record<string, unknown>)[
      selected.env_key_var
    ];
    checks.push({
      area: "auth",
      name: selected.env_key_var,
      status:
        typeof envValue === "string" && envValue.length > 0 ? "pass" : "fail",
      detail:
        typeof envValue === "string" && envValue.length > 0
          ? "configured (value hidden)"
          : "required by the selected catalog entry but not configured",
    });
  } else {
    checks.push({
      area: "auth",
      name: "selected backend",
      status: "pass",
      detail:
        "selected catalog entry does not require an API-key environment variable",
    });
  }

  try {
    await access(cwd, fsConstants.R_OK | fsConstants.W_OK);
    checks.push({
      area: "runtime",
      name: "working directory",
      status: "pass",
      detail: `${cwd} is readable and writable`,
    });
  } catch {
    checks.push({
      area: "runtime",
      name: "working directory",
      status: "fail",
      detail: `${cwd} is not both readable and writable`,
    });
  }
  return checks;
}

export async function runDoctor(args: {
  cwd: string;
  json?: boolean;
  explain?: string;
  write?: (text: string) => void;
}): Promise<boolean> {
  const configuration = await loadConfigurationStack({ cwd: args.cwd });
  const write = args.write ?? ((text: string) => process.stdout.write(text));
  if (args.explain) {
    const entry = configuration.stack.explain(args.explain);
    if (!entry) {
      write(`unknown configuration key: ${args.explain}\n`);
      return false;
    }
    if (args.json) {
      write(`${JSON.stringify(entry, null, 2)}\n`);
    } else {
      write(`${entry.key} = ${JSON.stringify(entry.value)}\n`);
      write(
        `winner: ${entry.origin} (${entry.source})${entry.version ? ` version ${entry.version}` : ""}\n`,
      );
      if (entry.disabledReason) write(`disabled: ${entry.disabledReason}\n`);
      for (const [index, layer] of entry.layers.entries()) {
        write(
          `layer ${index + 1}: ${layer.origin} (${layer.source})${layer.version ? ` version ${layer.version}` : ""}${layer.disabledReason ? ` disabled: ${layer.disabledReason}` : ""}\n`,
        );
      }
    }
    return true;
  }
  const checks = await diagnoseConfiguration(configuration, args.cwd);
  if (args.json) {
    write(
      `${JSON.stringify({ ok: checks.every((c) => c.status !== "fail"), checks }, null, 2)}\n`,
    );
  } else {
    for (const check of checks) {
      const badge =
        check.status === "pass"
          ? "PASS"
          : check.status === "warn"
            ? "WARN"
            : "FAIL";
      write(
        `${badge.padEnd(4)} ${check.area}/${check.name}: ${check.detail}\n`,
      );
    }
  }
  return checks.every((check) => check.status !== "fail");
}

export async function verifyAuditChain(args: {
  store: SessionStore;
  write?: (text: string) => void;
}): Promise<boolean> {
  const result = args.store.validateAuditChain();
  const write = args.write ?? ((text: string) => process.stdout.write(text));
  if (result.ok) {
    write("audit continuity check passed\n");
    return true;
  }
  write(
    `audit continuity check failed${result.brokenAtId ? ` at row ${result.brokenAtId}` : ""}: ${result.reason ?? "unknown reason"}\n`,
  );
  return false;
}
