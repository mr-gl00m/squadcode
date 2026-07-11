// Invariant: parseToolArgs must preserve the literal content of JSON string
// values during repair. The repair ladder is meant to fix structural
// problems (trailing commas, unbalanced braces, control chars). Quote
// (arg-repair.ts:1-7): "SSE chunk boundaries cutting inside JSON strings
// and reassembly leaving trailing commas or unclosed braces."
// Violation: stripTrailingCommas applies the regex /,}/g globally, which
// also matches `,}` substrings inside string values. So a tool argument
// like {"path": "a,}b",} (a real string content of "a,}b" with a trailing
// comma at the object level) gets repaired to {"path": "a}b"} — the comma
// inside the string value is silently eaten.
// Predicted failure: assertion result.path === "a,}b" fails because
// stripTrailingCommas mutates the string body into "a}b".

import { expect, it } from "vitest";
import { parseToolArgs } from "../../src/providers/arg-repair.js";

it("parseToolArgs preserves comma+brace inside string values", () => {
  // Strict parse fails because of the trailing `,}` after the value.
  // The repair ladder should fix the structural trailing comma without
  // touching the comma inside the string value.
  const malformed = '{"path": "a,}b",}';
  const result = parseToolArgs(malformed);
  expect(result).toMatchObject({ path: "a,}b" });
});
