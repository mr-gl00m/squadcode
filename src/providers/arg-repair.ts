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

  s = balanceBraces(s);
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
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    const charStr = s[i] as string;
    if (escaped) {
      out += charStr;
      escaped = false;
      continue;
    }
    if (ch === 0x5c /* \ */) {
      escaped = true;
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

// Strip trailing commas before `}`, `]`, or end of input — but only when
// the comma sits OUTSIDE a quoted string. The previous regex pass was
// content-blind and corrupted string values containing literal `,}` or
// `,]` substrings. Walks the input once with the same inString/escaped
// state machine that stripControlCharsInStrings uses; on each comma in
// non-string context, peeks ahead through whitespace to decide whether
// to drop it.
function stripTrailingCommas(s: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s.charCodeAt(i);
    const charStr = s[i] as string;
    if (escaped) {
      out += charStr;
      escaped = false;
      continue;
    }
    if (ch === 0x5c /* \ */) {
      escaped = true;
      out += charStr;
      continue;
    }
    if (ch === 0x22 /* " */) {
      inString = !inString;
      out += charStr;
      continue;
    }
    if (!inString && ch === 0x2c /* , */) {
      let j = i + 1;
      while (j < s.length) {
        const c = s.charCodeAt(j);
        if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
          j += 1;
          continue;
        }
        break;
      }
      if (j >= s.length) continue;
      const next = s.charCodeAt(j);
      if (next === 0x7d /* } */ || next === 0x5d /* ] */) continue;
    }
    out += charStr;
  }
  return out;
}

// Balance braces and brackets by tracking the stack of unclosed structural
// openers, then appending each opener's matching closer in LIFO (innermost
// first) order. Counting `{`/`}` and `[`/`]` deltas separately loses nesting
// order and mis-closes an object nested inside an array: `[{` would become the
// invalid `[{]}` instead of `[{}]`, collapsing a recoverable partial to `{}`.
// Walks with the inString/escaped state machine so literal braces/brackets
// inside JSON string values are not counted as structural; matches the
// invariant stripTrailingCommas adopted in BH-2026-05-10-003. A mismatched or
// excess closer is left in place for stripExcessClosers to handle.
function balanceBraces(s: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let j = 0; j < s.length; j++) {
    const ch = s.charCodeAt(j);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === 0x5c /* \ */) {
      escaped = true;
      continue;
    }
    if (ch === 0x22 /* " */) {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === 0x7b /* { */) stack.push("}");
    else if (ch === 0x5b /* [ */) stack.push("]");
    else if (ch === 0x7d /* } */) {
      if (stack[stack.length - 1] === "}") stack.pop();
    } else if (ch === 0x5d /* ] */) {
      if (stack[stack.length - 1] === "]") stack.pop();
    }
  }
  let out = s;
  // An unterminated string itself blocks structural recovery; close it before
  // adding structural closers so they don't end up swallowed inside the open
  // string value.
  if (inString) out += '"';
  for (let k = stack.length - 1; k >= 0; k -= 1) {
    const closer = stack[k];
    if (closer !== undefined) out += closer;
  }
  return out;
}

// Drop excess closers when the delta is negative (more closes than opens).
// Walks once tracking depth; a `}` or `]` with no matching open is dropped.
// Same inString/escaped walker as the other repair stages so literal braces
// or brackets inside JSON string values pass through untouched.
function stripExcessClosers(s: string): string {
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let escaped = false;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    const charStr = s[i] as string;
    if (escaped) {
      out += charStr;
      escaped = false;
      continue;
    }
    if (ch === 0x5c /* \ */) {
      escaped = true;
      out += charStr;
      continue;
    }
    if (ch === 0x22 /* " */) {
      inString = !inString;
      out += charStr;
      continue;
    }
    if (inString) {
      out += charStr;
      continue;
    }
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
