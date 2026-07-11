// Detect shorthand omission placeholders that LLMs emit instead of literal
// replacement text — common forms include:
//   // rest of methods ...
//   (rest of code ...)
//   // unchanged code ...
//
// When `old_string` or `new_string` (Edit) or `content` (Write) contains one
// of these, the model is trying to abbreviate code it doesn't want to retype.
// The match will never succeed for `old_string`, and accepting it as
// `new_string`/`content` would leave the placeholder text in the file.

const OMITTED_PREFIXES = new Set([
  "rest of",
  "rest of method",
  "rest of methods",
  "rest of code",
  "unchanged code",
  "unchanged method",
  "unchanged methods",
]);

function isAllDots(str: string): boolean {
  if (str.length === 0) return false;
  for (let i = 0; i < str.length; i++) {
    if (str[i] !== ".") return false;
  }
  return true;
}

// Collapse runs of whitespace to single spaces and trim, so prefix comparisons
// are robust to indentation choices the model made inside the placeholder.
function normalizeWhitespace(input: string): string {
  const segments: string[] = [];
  let current = "";
  for (const char of input) {
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      if (current.length > 0) {
        segments.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) segments.push(current);
  return segments.join(" ");
}

function normalizePlaceholder(line: string): string | null {
  let text = line.trim();
  if (!text) return null;

  if (text.startsWith("//")) text = text.slice(2).trim();
  if (text.startsWith("(") && text.endsWith(")")) {
    text = text.slice(1, -1).trim();
  }

  const ellipsisStart = text.indexOf("...");
  if (ellipsisStart < 0) return null;

  const prefixRaw = text.slice(0, ellipsisStart).trim().toLowerCase();
  const suffixRaw = text.slice(ellipsisStart + 3).trim();
  const prefix = normalizeWhitespace(prefixRaw);

  if (!OMITTED_PREFIXES.has(prefix)) return null;
  if (suffixRaw.length > 0 && !isAllDots(suffixRaw)) return null;

  return `${prefix} ...`;
}

export function detectOmissionPlaceholders(text: string): string[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const matches: string[] = [];
  for (const rawLine of lines) {
    const normalized = normalizePlaceholder(rawLine);
    if (normalized) matches.push(normalized);
  }
  return matches;
}
