import {
  type ContextFragment,
  renderContextFragment,
} from "../context/fragment.js";
import { logger } from "../logger.js";
import { TRUST_BOUNDARY_INSTRUCTION } from "../prompts/boundary.js";
import { buildRepoMap, repoMapFragment } from "../repomap/index.js";
import type { ToolRegistry } from "../tools/registry.js";

export interface PreparedRepoMap {
  fragment: ContextFragment | null;
  fileMentions: string[];
}

export function defaultSystemPrompt(registry?: ToolRegistry): string {
  const parts = [
    "You are squad, a CLI coding agent running on the user's local machine.",
    `Host platform: ${process.platform}. ${shellHint()}`,
    "Reply in English unless the user explicitly asks for another language.",
    TRUST_BOUNDARY_INSTRUCTION,
    'When a Shell call returns ok="false", read the stderr in the result and adapt — do NOT repeat the same failing command. If a Move-Item / mv with multiple sources fails, retry one source at a time.',
    "For multi-step coding tasks, use TodoWrite to create a short working checklist and keep it updated as tasks move from pending to in_progress to completed.",
    "Prefer one tool call at a time and wait for the result before deciding the next step. Stop calling tools once you have what you need to answer.",
    "Be concrete and concise. No marketing tone, no padding.",
  ];
  if (registry) {
    const deferred = registry.deferredCatalog();
    if (deferred.length > 0) {
      const lines = deferred.map((e) => `- ${e.name}: ${e.description}`);
      parts.push(
        "Deferred tools (full schemas loaded on demand to keep the catalog small):\n" +
          lines.join("\n") +
          '\nTo make a deferred tool callable, invoke ToolSearch with query="select:Name1,Name2" or with keywords. Once a schema is loaded it stays available — no need to re-load before each call.',
      );
    }
    const manifest = registry.getManifest();
    if (manifest) {
      parts.push(
        `Project manifest: this project ships a deterministic file index at .crabmeat/index.json (${manifest.entries.length} entries, generated ${manifest.generated_at}). ` +
          "Before searching for project files, call IndexList to see paths and one-line summaries, then IndexFetch to read the one you want. " +
          "Fall back to Glob/Grep/Read only when the manifest doesn't cover what you need.",
      );
    } else {
      const repoMap = registry.getRepoMap();
      if (repoMap) {
        parts.push(
          "Repo map (top symbols by pagerank-weighted reference graph, " +
            "subject to a token budget — not exhaustive). Use this to orient before " +
            "calling Glob/Grep/Read for full file contents.\n\n" +
            renderContextFragment(repoMap).content,
        );
      }
    }
  }
  return parts.join("\n");
}

export async function prepareRepoMap(
  cwd: string,
  manifestPresent: boolean,
  collectMentions = false,
): Promise<PreparedRepoMap> {
  if (manifestPresent && !collectMentions) {
    return { fragment: null, fileMentions: [] };
  }
  if (process.env.SQUAD_REPOMAP === "off") {
    return { fragment: null, fileMentions: [] };
  }
  try {
    const result = await buildRepoMap({ cwd, tokenBudget: 1024 });
    const fragment =
      manifestPresent || !result.text || result.estimatedTokens === 0
        ? null
        : repoMapFragment(result.text, cwd);
    return { fragment, fileMentions: result.fileMentions };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "repomap build failed; continuing without repo context",
    );
    return { fragment: null, fileMentions: [] };
  }
}

function shellHint(): string {
  if (process.platform === "win32") {
    return "The Shell tool runs Windows PowerShell 5.1 (powershell.exe). Unix aliases mv/cp/rm/ls/cat/pwd map to Move-Item/Copy-Item/Remove-Item/Get-ChildItem/Get-Content/Get-Location. Pipeline-chain operators && and || are NOT available — use `;` to chain unconditionally, or `if ($?) { ... }` to chain on success. Move-Item with multiple source files takes a comma-separated list (Move-Item a.txt, b.txt dest\\) — unix-style space-separated multiple sources will fail. Force overwrite is `-Force` on Move-Item / Remove-Item / Copy-Item.";
  }
  return "The Shell tool runs the system default shell (typically /bin/sh).";
}
