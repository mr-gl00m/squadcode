// Post-edit diagnostics. Mutating file tools (Edit/Write/ApplyPatch) record
// the files they touched into a per-session tracker; at the next turn
// boundary the pre-turn injector drains the tracker, syntax-checks each file,
// and injects any findings as a synthetic user message so the model sees the
// breakage before it acts again.
//
// Two tiers, deterministic-first:
//   1. Built-in (always on): tree-sitter ERROR/MISSING scan via the repomap
//      grammars (ts/tsx/js/py/rs/go) plus JSON.parse for .json. In-process,
//      no subprocess, a few ms per file.
//   2. Opt-in project command (.squad/settings.json "diagnostics.command",
//      e.g. "npm run typecheck"): run once per drain when configured, output
//      capped. Never auto-detected — the harness must not spawn project
//      binaries the user didn't name.
//
// Kill switch: SQUAD_POST_EDIT_DIAGNOSTICS=0 disables tier 1 wiring at the
// call sites; tier 2 is off unless configured.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { relative } from "node:path";
import {
  type ContextFragment,
  createContextFragment,
} from "../context/fragment.js";
import { loadEnv } from "../env.js";
import { fileExists, readJsonFile } from "../fs-io.js";
import { logger } from "../logger.js";
import {
  getProjectSettingsPath,
  type ProjectSettings,
} from "../permissions/project.js";
import { createParser } from "../repomap/parser.js";
import { languageFor } from "../repomap/walk.js";

export interface DiagnosticsTracker {
  recordTouched(absPath: string): void;
  drainTouched(): string[];
  hasPending(): boolean;
}

export function createDiagnosticsTracker(): DiagnosticsTracker {
  const touched = new Set<string>();
  return {
    recordTouched(absPath: string): void {
      touched.add(absPath);
    },
    drainTouched(): string[] {
      const files = [...touched];
      touched.clear();
      return files;
    },
    hasPending(): boolean {
      return touched.size > 0;
    },
  };
}

export interface FileDiagnostics {
  file: string; // cwd-relative when possible, for display
  problems: string[]; // "line:col message"
}

const MAX_PROBLEMS_PER_FILE = 5;
const MAX_FILES_REPORTED = 8;
const MAX_SYNTAX_BYTES = 2_000_000;

// Walk the tree-sitter parse tree collecting ERROR and missing nodes,
// depth-first; stops early once the per-file cap is hit. hasError on inner
// nodes prunes clean subtrees so big files stay cheap.
function collectTreeErrors(
  root: import("web-tree-sitter").SyntaxNode,
): { row: number; column: number; label: string }[] {
  const found: { row: number; column: number; label: string }[] = [];
  const visit = (node: import("web-tree-sitter").SyntaxNode): void => {
    if (found.length >= MAX_PROBLEMS_PER_FILE) return;
    if (node.type === "ERROR") {
      const snippet = node.text.slice(0, 40).replace(/\s+/g, " ").trim();
      found.push({
        row: node.startPosition.row,
        column: node.startPosition.column,
        label: `syntax error near "${snippet}"`,
      });
      // An ERROR node's children are usually noise; don't descend.
      return;
    }
    if (node.isMissing) {
      found.push({
        row: node.startPosition.row,
        column: node.startPosition.column,
        label: `missing ${node.type}`,
      });
      return;
    }
    if (!node.hasError) return;
    for (let i = 0; i < node.childCount; i += 1) {
      const child = node.child(i);
      if (child) visit(child);
    }
  };
  visit(root);
  return found;
}

async function syntaxCheckFile(absPath: string): Promise<string[]> {
  let text: string;
  try {
    const stat = await fs.stat(absPath);
    if (stat.size > MAX_SYNTAX_BYTES) return [];
    text = await fs.readFile(absPath, "utf-8");
  } catch {
    // Deleted or unreadable since the edit; nothing to report.
    return [];
  }

  if (absPath.toLowerCase().endsWith(".json")) {
    try {
      JSON.parse(text);
      return [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return [`invalid JSON: ${msg}`];
    }
  }

  const lang = languageFor(absPath);
  if (!lang) return [];
  const parser = await createParser(lang);
  if (!parser) return [];
  try {
    const tree = parser.parse(text);
    if (!tree) return [];
    try {
      if (!tree.rootNode.hasError) return [];
      return collectTreeErrors(tree.rootNode).map(
        (e) => `${e.row + 1}:${e.column + 1} ${e.label}`,
      );
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}

export async function collectSyntaxDiagnostics(
  files: string[],
  opts: { cwd: string },
): Promise<FileDiagnostics[]> {
  const out: FileDiagnostics[] = [];
  for (const file of files) {
    if (out.length >= MAX_FILES_REPORTED) break;
    let problems: string[];
    try {
      problems = await syntaxCheckFile(file);
    } catch (err) {
      logger.warn(
        { file, err: err instanceof Error ? err.message : String(err) },
        "post-edit syntax check failed",
      );
      continue;
    }
    if (problems.length === 0) continue;
    let display = file;
    try {
      const rel = relative(opts.cwd, file);
      if (rel && !rel.startsWith("..")) display = rel;
    } catch {
      // keep absolute path
    }
    out.push({ file: display, problems });
  }
  return out;
}

const COMMAND_TIMEOUT_MS = 60_000;
const COMMAND_OUTPUT_CAP = 4_000;

export interface DiagnosticsCommandConfig {
  command: string;
  timeoutMs?: number;
}

// Run the project-configured diagnostics command through the platform shell.
// Non-zero exit means findings: return the tail of combined output, capped.
// Exit 0 returns null (nothing to inject). Failures to spawn are logged and
// swallowed — diagnostics must never break the loop.
export async function runDiagnosticsCommand(
  config: DiagnosticsCommandConfig,
  opts: { cwd: string; signal?: AbortSignal },
): Promise<string | null> {
  const timeoutMs = config.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const isWindows = process.platform === "win32";
  const shell = isWindows ? "cmd.exe" : "/bin/sh";
  const args = isWindows
    ? ["/d", "/s", "/c", config.command]
    : ["-c", config.command];

  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, args, {
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsVerbatimArguments: isWindows,
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "diagnostics command failed to spawn",
      );
      resolvePromise(null);
      return;
    }
    let output = "";
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      logger.warn(
        { command: config.command, timeoutMs },
        "diagnostics command timed out",
      );
      finish(null);
    }, timeoutMs);
    opts.signal?.addEventListener("abort", () => {
      child.kill();
      finish(null);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      logger.warn({ err: err.message }, "diagnostics command errored");
      finish(null);
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish(null);
        return;
      }
      const trimmed = output.trim();
      if (trimmed.length === 0) {
        finish(`diagnostics command exited ${code} with no output`);
        return;
      }
      finish(
        trimmed.length > COMMAND_OUTPUT_CAP
          ? `... (truncated)\n${trimmed.slice(-COMMAND_OUTPUT_CAP)}`
          : trimmed,
      );
    });
  });
}

// Everything the pre-turn injector needs, bundled per session (or per
// subagent — each gets its own tracker, no cross-visibility).
export interface DiagnosticsSetup {
  tracker: DiagnosticsTracker;
  cwd: string;
  command?: DiagnosticsCommandConfig;
}

// Read the opt-in tier-2 command from project settings. Shape:
//   { "diagnostics": { "command": "npm run typecheck", "timeoutMs": 90000 } }
// Never auto-detected from project markers — the harness must not run
// project binaries the user didn't explicitly configure.
export async function loadDiagnosticsCommand(
  cwd: string,
): Promise<DiagnosticsCommandConfig | undefined> {
  const path = getProjectSettingsPath(cwd);
  if (!(await fileExists(path))) return undefined;
  let data: ProjectSettings;
  try {
    data = await readJsonFile<ProjectSettings>(path);
  } catch {
    return undefined;
  }
  const raw = data.diagnostics;
  if (!raw || typeof raw !== "object") return undefined;
  const command = (raw as { command?: unknown }).command;
  if (typeof command !== "string" || command.trim().length === 0) {
    return undefined;
  }
  const timeoutMs = (raw as { timeoutMs?: unknown }).timeoutMs;
  return {
    command,
    ...(typeof timeoutMs === "number" &&
      Number.isFinite(timeoutMs) &&
      timeoutMs > 0 && { timeoutMs }),
  };
}

// Call-site entry: null when the kill switch is set, otherwise a fresh
// tracker plus any configured tier-2 command. Subagent call sites pass
// withCommand:false — tier 1 is cheap enough to run per agent, but a
// project-wide typecheck per subagent turn is not.
export async function setupPostEditDiagnostics(
  cwd: string,
  opts?: { withCommand?: boolean },
): Promise<DiagnosticsSetup | null> {
  if (!loadEnv().SQUAD_POST_EDIT_DIAGNOSTICS) return null;
  const command =
    opts?.withCommand === false ? undefined : await loadDiagnosticsCommand(cwd);
  return {
    tracker: createDiagnosticsTracker(),
    cwd,
    ...(command && { command }),
  };
}

// Drain the tracker and produce an injectable fragment, or null when
// everything parses clean (the common case — inject nothing, cost nothing).
export async function buildDiagnosticsFragment(opts: {
  tracker: DiagnosticsTracker;
  cwd: string;
  command?: DiagnosticsCommandConfig;
  signal?: AbortSignal;
}): Promise<ContextFragment | null> {
  if (!opts.tracker.hasPending()) return null;
  const files = opts.tracker.drainTouched();
  const sections: string[] = [];

  const syntax = await collectSyntaxDiagnostics(files, { cwd: opts.cwd });
  for (const fd of syntax) {
    sections.push(`file=${JSON.stringify(fd.file)}\n${fd.problems.join("\n")}`);
  }

  if (opts.command) {
    const commandOut = await runDiagnosticsCommand(opts.command, {
      cwd: opts.cwd,
      ...(opts.signal && { signal: opts.signal }),
    });
    if (commandOut !== null) {
      sections.push(`configured diagnostics command:\n${commandOut}`);
    }
  }

  if (sections.length === 0) return null;
  return createContextFragment({
    source: "post-edit-diagnostics",
    type: "findings",
    key: opts.cwd,
    role: "user",
    merge: "replace",
    visibility: "model-and-user",
    trust: "untrusted-environment",
    maxBytes: 8_192,
    maxTokens: 2_048,
    content:
      `${sections.join("\n\n")}\n` +
      "Problems were detected in files you recently modified. Fix them before continuing.",
  });
}
