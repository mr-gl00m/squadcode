import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { logger } from "../../logger.js";
import { parseAgentDef } from "../loader.js";
import type { SubagentDef } from "../types.js";

// The shipped agent defs. Their .md files sit beside this module (copied to dist
// by copy-assets.mjs); loadAgentDefs merges them under any user/project agent of
// the same name, so a project can shadow a built-in with its own prompt + model.
// None pin a model — the per-agent model is the user's vetting lever (set it in
// .squad/agents/<name>.md or pick it per run via `squad shootout`).
const BUILT_IN_NAMES = ["explorer", "judge", "red-team", "reviewer"] as const;

let cached: SubagentDef[] | null = null;

export function builtInAgentDefs(): SubagentDef[] {
  if (cached) return cached;
  const defs: SubagentDef[] = [];
  for (const name of BUILT_IN_NAMES) {
    const path = fileURLToPath(new URL(`./${name}.md`, import.meta.url));
    try {
      const def = parseAgentDef(readFileSync(path, "utf-8"), name);
      if (def) defs.push(def);
      else logger.warn({ name }, "built-in agent def failed to parse");
    } catch (err: unknown) {
      logger.warn(
        { name, err: err instanceof Error ? err.message : String(err) },
        "built-in agent def missing",
      );
    }
  }
  cached = defs;
  return defs;
}
