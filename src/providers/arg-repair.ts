// Deterministic JSON-argument repair for malformed tool-call inputs.
//
// Streaming providers emit `tool_calls.function.arguments` as deltas. Two
// failure shapes are common: SSE chunk boundaries cutting inside JSON strings
// and reassembly leaving trailing commas or unclosed braces; some local
// backends emit literal control characters inside JSON string values.
//
// The repair ladder runs five stages before falling back to an empty object:
//   1. Strict parse — done if it parses.
//   2. Strip literal control chars inside string values.
//   3. Strip trailing commas before `}` or `]`.
//   4. Balance braces/brackets (append closers).
//   5. Strip excess closers if delta is negative.
//   6. Fallback: empty object `{}`.

const MAX_ARG_LEN = 1024 * 1024;

const BALANCE_MAX_ITER = 50;

export class ArgRepairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgRepairError";
  }
}

// Run the deterministic repair ladder. Returns the parsed value on success;
// the final fallback is an empty object so dispatch always proceeds. Throws
// `ArgRepairError` on oversize input — caller decides whether to fall back to
// the raw buffer or surface the error.
export function repairToolArgs(raw: string): unknown {
  if (raw.length > MAX_ARG_LEN) {
    throw new ArgRepairError(
      `argument exceeded ${MAX_ARG_LEN} chars; refusing to repair`,
    );
  }

  const stage1 = tryParse(raw);
  if (stage1.ok) return stage1.value;

  let s = stripControlCharsInStrings(raw);
  const stage2 = tryParse(s);
  if (stage2.ok) return stage2.value;

  s = stripTrailingCommas(s);
  const stage3 = tryParse(s);
  if (stage3.ok) return stage3.value;

  s = balanceBraces(s, BALANCE_MAX_ITER);
  const stage4 = tryParse(s);
  if (stage4.ok) return stage4.value;

  s = stripExcessClosers(s);
  const stage5 = tryParse(s);
  if (stage5.ok) return stage5.value;

  return {};
}

// Convenience wrapper for the three provider call sites that today try
// JSON.parse and fall back to the raw string. Empty input becomes `{}`,
// oversize input falls back to the raw buffer string (preserving the
// pre-repair behavior so a downstream tool can still inspect it).
export function parseToolArgs(raw: string): unknown {
  if (raw.length === 0) return {};
  try {
    return repairToolArgs(raw);
  } catch {
    return raw;
  }
}

type ParseResult = { ok: true; value: unknown } | { ok: false };

function tryParse(s: string): ParseResult {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

// Strip ASCII control characters (0x00-0x1F except \t, \n, \r) that appear
// inside JSON string values. Walks character-by-character tracking whether
// we're inside a string (between unescaped double-quotes).
function stripControlCharsInStrings(s: string): string {
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    const charStr = s[i] as string;
    if (escape) {
      out += charStr;
      escape = false;
      continue;
    }
    if (ch === 0x5c /* \ */) {
      escape = true;
      out += charStr;
      continue;
    }
    if (ch === 0x22 /* " */) {
      inString = !inString;
      out += charStr;
      continue;
    }
    if (
      inString &&
      ch < 0x20 &&
      ch !== 0x09 /* \t */ &&
      ch !== 0x0a /* \n */ &&
      ch !== 0x0d /* \r */
    ) {
      continue;
    }
    out += charStr;
  }
  return out;
}

// Strip trailing commas before `}`, `]`, or end of input. Iterates to a
// fixed point so nested cases collapse correctly.
function stripTrailingCommas(s: string): string {
  let out = s;
  // Up to a small bound so a pathological input can't spin forever.
  for (let i = 0; i < 16; i++) {
    const prev = out;
    out = out.replace(/,}/g, "}").replace(/,]/g, "]").replace(/,+$/, "");
    if (out === prev) break;
  }
  return out;
}

// Balance braces and brackets: count `{`/`}` and `[`/`]`, append closers if
// positive delta. Bounded iterations so a catastrophically broken input
// doesn't loop forever.
function balanceBraces(s: string, maxIter: number): string {
  let out = s;
  for (let i = 0; i < maxIter; i++) {
    let braceDelta = 0;
    let bracketDelta = 0;
    for (let j = 0; j < out.length; j++) {
      const ch = out.charCodeAt(j);
      if (ch === 0x7b) braceDelta++;
      else if (ch === 0x7d) braceDelta--;
      else if (ch === 0x5b) bracketDelta++;
      else if (ch === 0x5d) bracketDelta--;
    }
    if (braceDelta <= 0 && bracketDelta <= 0) break;
    // Append needed closers — brackets before braces for nesting correctness.
    if (bracketDelta > 0) out += "]".repeat(bracketDelta);
    if (braceDelta > 0) out += "}".repeat(braceDelta);
  }
  return out;
}

// Drop excess closers when the delta is negative (more closes than opens).
// Walks once tracking depth; a `}` or `]` with no matching open is dropped.
function stripExcessClosers(s: string): string {
  let braceDepth = 0;
  let bracketDepth = 0;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    const charStr = s[i] as string;
    if (ch === 0x7b) {
      braceDepth++;
      out += charStr;
    } else if (ch === 0x7d) {
      if (braceDepth > 0) {
        braceDepth--;
        out += charStr;
      }
      // else drop
    } else if (ch === 0x5b) {
      bracketDepth++;
      out += charStr;
    } else if (ch === 0x5d) {
      if (bracketDepth > 0) {
        bracketDepth--;
        out += charStr;
      }
    } else {
      out += charStr;
    }
  }
  return out;
}
