// Environment allowlist for shell children. The Shell tool spawns commands the
// model proposes; inheriting the full parent environment means the user's
// provider API keys (DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, …)
// and any other secret-shaped variable are visible to whatever runs — a real
// exfiltration path under YOLO autonomous mode where commands aren't reviewed.
//
// Two modes:
//   - lenient (default): pass the parent environment through MINUS any
//     credential-shaped variable name. Normal build/config vars still reach the
//     command; secrets don't.
//   - strict: pass only the baseline allowlist (PATH/HOME/TMP/TERM/locale plus
//     the Windows essentials a child needs to run at all). Auto-on under CI,
//     where the environment is controlled and a leak into a logged subprocess
//     is the higher risk. Override either way with SQUAD_SHELL_ENV_STRICT.

// The minimum a shell and common tooling need to function, passed through even
// in strict mode. Matched case-insensitively (Windows env names are
// case-insensitive; the POSIX names here are uppercase regardless). The LC_*
// locale family is handled by prefix below, not listed here.
const BASELINE_ALLOW = new Set(
  [
    // cross-platform
    "PATH",
    "HOME",
    "TMP",
    "TEMP",
    "TMPDIR",
    "TERM",
    "TERM_PROGRAM",
    "COLORTERM",
    "LANG",
    "LANGUAGE",
    "TZ",
    "SHELL",
    "USER",
    "LOGNAME",
    "PWD",
    "SHLVL",
    // Windows essentials — a child can't resolve system paths or run without
    // most of these.
    "SYSTEMROOT",
    "WINDIR",
    "SYSTEMDRIVE",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMFILES(X86)",
    "COMMONPROGRAMW6432",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "OS",
  ].map((n) => n.toLowerCase()),
);

// Credential-shaped name patterns. Conservative on false positives: KEY only
// matches as a whole _-delimited token (so MONKEY / KEYBOARD pass), AUTH only
// as a token (so AUTHOR passes). Provider keys end in _API_KEY / _KEY and are
// caught by the api-key and bare-key patterns.
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /secret/i,
  /token/i,
  /passwo?rd|passwd|passphrase/i,
  /credential/i,
  /bearer/i,
  /api[_-]?key/i,
  /access[_-]?key/i,
  /private[_-]?key/i,
  /signing[_-]?key/i,
  /session[_-]?(?:key|token|secret|id)/i,
  /\bcookie\b/i,
  /(?:^|_)key(?:$|_)/i,
  /(?:^|_)auth(?:$|_)/i,
];

const STRICT_PREFIXES = ["lc_"]; // locale family, always allowed

export interface ChildEnvOptions {
  // Force a mode. When unset, resolved from SQUAD_SHELL_ENV_STRICT then CI.
  strict?: boolean;
  // CI detection override. When unset, derived from the parent's CI variable.
  ci?: boolean;
}

export interface SanitizedChildEnvOptions extends ChildEnvOptions {
  // Explicit parent env names to pass through after sanitization. Used for
  // trusted configured subprocesses that need a specific credential.
  passEnv?: readonly string[];
  extraEnv?: Record<string, string | undefined>;
}

export function isCredentialShaped(name: string): boolean {
  return CREDENTIAL_PATTERNS.some((re) => re.test(name));
}

export function isBaselineAllowed(name: string): boolean {
  const lower = name.toLowerCase();
  if (BASELINE_ALLOW.has(lower)) return true;
  return STRICT_PREFIXES.some((p) => lower.startsWith(p));
}

function isCiEnv(parent: NodeJS.ProcessEnv): boolean {
  const ci = parent["CI"];
  if (ci === undefined) return false;
  return ci !== "" && ci !== "0" && ci.toLowerCase() !== "false";
}

export function resolveStrict(
  parent: NodeJS.ProcessEnv,
  opts: ChildEnvOptions,
): boolean {
  if (opts.strict !== undefined) return opts.strict;
  const override = parent["SQUAD_SHELL_ENV_STRICT"];
  if (override !== undefined) {
    const v = override.toLowerCase();
    if (v === "1" || v === "true" || v === "yes") return true;
    if (v === "0" || v === "false" || v === "no") return false;
  }
  return opts.ci ?? isCiEnv(parent);
}

// Build the environment a shell child should run with. Pure — reads only the
// passed-in parent map, returns a fresh object.
export function sanitizeChildEnv(
  parent: NodeJS.ProcessEnv,
  opts: ChildEnvOptions = {},
): Record<string, string> {
  const strict = resolveStrict(parent, opts);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (strict) {
      if (isBaselineAllowed(name)) out[name] = value;
    } else if (!isCredentialShaped(name)) {
      out[name] = value;
    }
  }
  return out;
}

export function buildSanitizedChildEnv(
  parent: NodeJS.ProcessEnv,
  opts: SanitizedChildEnvOptions = {},
): Record<string, string> {
  const out = sanitizeChildEnv(parent, opts);
  for (const name of opts.passEnv ?? []) {
    const value = parent[name];
    if (value !== undefined) out[name] = value;
  }
  for (const [name, value] of Object.entries(opts.extraEnv ?? {})) {
    if (value !== undefined) out[name] = value;
  }
  return out;
}
