import { parseUnifiedDiff } from "../tools/apply-patch.js";

export type PatternKind = "path" | "command" | "any";

export function compilePattern(pattern: string, kind: PatternKind): RegExp {
  if (kind === "command" || kind === "any") {
    const escaped = pattern
      .replace(/[.+^$()|{}[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`, "i");
  }
  const SENT_DSS = "__GLOB_DSS__";
  const SENT_DS = "__GLOB_DS__";
  const escaped = pattern
    .replace(/\\/g, "/")
    .replace(/\*\*\//g, SENT_DSS)
    .replace(/\*\*/g, SENT_DS)
    .replace(/[.+^$()|{}[\]]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(new RegExp(SENT_DSS, "g"), "(?:.*/)?")
    .replace(new RegExp(SENT_DS, "g"), ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function specificity(pattern: string): number {
  let n = 0;
  for (const c of pattern) {
    if (c !== "*" && c !== "?") n += 1;
  }
  return n;
}

const ARITY: Record<string, number> = {
  git: 2,
  "git stash": 3,
  "git remote": 3,
  "git submodule": 3,
  npm: 2,
  "npm run": 3,
  pnpm: 2,
  "pnpm run": 3,
  yarn: 2,
  cargo: 2,
  "cargo install": 3,
  docker: 2,
  "docker compose": 3,
  kubectl: 2,
  python: 2,
  python3: 2,
  node: 2,
  go: 2,
  "go mod": 3,
  pip: 2,
  pip3: 2,
};

export function bashArityPrefix(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length === 0) return "*";
  const tokens = trimmed.split(/\s+/);
  const head = tokens[0]!;
  for (let n = Math.min(3, tokens.length); n >= 1; n -= 1) {
    const probe = tokens.slice(0, n).join(" ");
    const arity = ARITY[probe];
    if (arity !== undefined && tokens.length >= arity) {
      return `${tokens.slice(0, arity).join(" ")} *`;
    }
  }
  return `${head} *`;
}

export interface MatchKey {
  kind: PatternKind;
  key: string;
}

export function extractMatchKeys(toolName: string, args: unknown): MatchKey[] {
  if (toolName === "ApplyPatch") {
    const patch = (args as { patch?: unknown } | null)?.patch;
    if (typeof patch !== "string") {
      return [{ kind: "path", key: "<invalid-apply-patch>" }];
    }
    try {
      const paths = [
        ...new Set(
          parseUnifiedDiff(patch)
            .map((file) => normalizePath(file.path))
            .filter((path) => path.length > 0),
        ),
      ];
      if (paths.length > 0) {
        return paths.map((key) => ({ kind: "path" as const, key }));
      }
    } catch {
      // A malformed patch will fail during preview/execute too. Keep its
      // permission scope narrow instead of falling back to the wildcard used
      // by tools that genuinely have no match key.
    }
    return [{ kind: "path", key: "<invalid-apply-patch>" }];
  }
  return [extractMatchKey(toolName, args)];
}

export function extractMatchKey(toolName: string, args: unknown): MatchKey {
  if (args === null || typeof args !== "object") {
    return { kind: "any", key: "" };
  }
  const a = args as Record<string, unknown>;
  switch (toolName) {
    case "Read":
    case "Edit":
    case "Write":
      if (typeof a.path === "string") {
        return { kind: "path", key: normalizePath(a.path) };
      }
      return { kind: "any", key: "" };
    case "Shell":
      if (typeof a.command === "string") {
        return { kind: "command", key: a.command };
      }
      return { kind: "any", key: "" };
    default:
      return { kind: "any", key: "" };
  }
}

export function deriveScopePatterns(toolName: string, args: unknown): string[] {
  if (toolName === "ApplyPatch") {
    // Multi-file approval grants are exact per-file keys. Broadening each path
    // to its parent directory would let an overlapping later patch inherit
    // permission for a sibling the user never approved.
    return extractMatchKeys(toolName, args).map((match) => match.key);
  }
  return [deriveScopePattern(toolName, args)];
}

export function deriveScopePattern(toolName: string, args: unknown): string {
  const m = extractMatchKey(toolName, args);
  if (m.kind === "command") return bashArityPrefix(m.key);
  if (m.kind === "path") return pathScopePattern(m.key);
  return "*";
}

// Path-tool scope: broaden a literal file path to the parent directory glob
// (src/foo/bar.ts -> src/foo/*) so granting [A]lways or [P]ermanently doesn't
// require re-prompting on every sibling file. Repo-root files keep their
// literal path because '.'/'' parent would otherwise widen to '*' (entire
// project), which is more than the user implied.
function pathScopePattern(normalizedPath: string): string {
  if (normalizedPath.length === 0) return "*";
  const slash = normalizedPath.lastIndexOf("/");
  if (slash <= 0) return normalizedPath;
  return `${normalizedPath.slice(0, slash)}/*`;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}
