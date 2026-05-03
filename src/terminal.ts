const ANSI_ESCAPE_PATTERN =
  // Covers CSI, OSC (including OSC-8 hyperlinks ending with ST), charset
  // selection, and single-character ESC sequences. OSC-8 link bodies are
  // preserved as plain text — only the wrapping escapes are stripped.
  /\x1B(?:\][^\x07]*?(?:\x07|\x1B\\)|\[[0-?]*[ -/]*[@-~]|[()][0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;

const UNSAFE_CONTROL_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

// Zero-width formatting characters and bidi-override codepoints. These are
// invisible at render time but let pasted/streamed text display differently
// from its underlying bytes — homoglyph splits, RTL inversions, soft-hyphen
// token-breakage, etc. Strip them from anything we render or feed to the LLM
// context window.
const INVISIBLE_FORMATTING_PATTERN =
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u2028-\u202F\u2060-\u2064\u2066-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB]/g;

export function sanitizeForTerminal(input: string): string {
  return input
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(UNSAFE_CONTROL_PATTERN, "")
    .replace(INVISIBLE_FORMATTING_PATTERN, "");
}
