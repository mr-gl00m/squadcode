// Edit-match fallback ladder. When old_string doesn't hit verbatim, walk a
// sequence of increasingly forgiving matchers, each yielding candidate
// substrings that exist verbatim in the file. A candidate is accepted only
// when it appears exactly once (unless replaceAll), so a fuzzy stage can never
// silently target the wrong location — ambiguity is refused, not guessed.
// Ladder shape follows the OpenCode/forge convergent design: the stages relax
// whitespace first, then indentation, then escaping, then fall back to
// first/last-line block anchors with Levenshtein similarity over the middle.
//
// Everything here operates on LF-normalized text; edit.ts normalizes before
// calling and restores BOM/EOL after.

export type MatchStage =
  | "exact"
  | "line-trimmed"
  | "whitespace-normalized"
  | "indentation-flexible"
  | "escape-normalized"
  | "trimmed-boundary"
  | "block-anchor";

export interface MatchOutcome {
  ok: true;
  // The exact substring of content to replace (verbatim, offsets valid).
  matched: string;
  stage: MatchStage;
}

export interface MatchFailure {
  ok: false;
  reason: "no_match" | "not_unique";
}

type CandidateGen = (content: string, find: string) => Iterable<string>;

// --- stage 1: exact -------------------------------------------------------

function* exactCandidates(_content: string, find: string): Iterable<string> {
  yield find;
}

// --- shared line helpers ---------------------------------------------------

interface LineSpan {
  text: string;
  start: number; // char offset of line start in content
}

function splitWithOffsets(content: string): LineSpan[] {
  const spans: LineSpan[] = [];
  let start = 0;
  for (const line of content.split("\n")) {
    spans.push({ text: line, start });
    start += line.length + 1;
  }
  return spans;
}

function findLines(find: string): string[] {
  const lines = find.split("\n");
  // A trailing newline on old_string produces an empty final line; matching
  // ignores it so "block\n" and "block" behave identically.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function sliceWindow(
  content: string,
  spans: LineSpan[],
  startLine: number,
  lineCount: number,
): string {
  const first = spans[startLine]!;
  const last = spans[startLine + lineCount - 1]!;
  return content.slice(first.start, last.start + last.text.length);
}

// --- stage 2: line-trimmed -------------------------------------------------

// Match line-by-line ignoring per-line leading/trailing whitespace; yield the
// original (untrimmed) block so existing indentation survives the replace.
function* lineTrimmedCandidates(
  content: string,
  find: string,
): Iterable<string> {
  const wanted = findLines(find).map((l) => l.trim());
  if (wanted.length === 0) return;
  const spans = splitWithOffsets(content);
  for (let i = 0; i + wanted.length <= spans.length; i += 1) {
    let hit = true;
    for (let j = 0; j < wanted.length; j += 1) {
      if (spans[i + j]!.text.trim() !== wanted[j]) {
        hit = false;
        break;
      }
    }
    if (hit) yield sliceWindow(content, spans, i, wanted.length);
  }
}

// --- stage 3: whitespace-normalized ----------------------------------------

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Collapse whitespace runs before comparing. For a single-line find that sits
// inside a longer line, rebuild the actual slice via a word-boundary regex so
// the yielded candidate is verbatim file text.
function* whitespaceNormalizedCandidates(
  content: string,
  find: string,
): Iterable<string> {
  const normFind = normalizeWs(find);
  if (normFind.length === 0) return;
  const spans = splitWithOffsets(content);
  const wanted = findLines(find);

  if (wanted.length === 1) {
    for (const span of spans) {
      if (normalizeWs(span.text) === normFind) {
        yield span.text;
      } else if (normalizeWs(span.text).includes(normFind)) {
        const words = normFind.split(" ").map(escapeRegExp);
        try {
          const m = span.text.match(new RegExp(words.join("\\s+")));
          if (m?.[0]) yield m[0];
        } catch {
          // regex construction failed on pathological input; skip
        }
      }
    }
    return;
  }

  for (let i = 0; i + wanted.length <= spans.length; i += 1) {
    const block = sliceWindow(content, spans, i, wanted.length);
    if (normalizeWs(block) === normFind) yield block;
  }
}

// --- stage 4: indentation-flexible ------------------------------------------

// Strip the common leading indent from both sides before comparing; matches
// code the model quoted at the wrong nesting depth.
function dedent(lines: string[]): string {
  let common: string | null = null;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = line.match(/^[ \t]*/)?.[0] ?? "";
    if (common === null || indent.length < common.length) common = indent;
    if (common === "") break;
  }
  const cut = common?.length ?? 0;
  return lines
    .map((l) => (l.trim() === "" ? l.trim() : l.slice(cut)))
    .join("\n");
}

function* indentationFlexibleCandidates(
  content: string,
  find: string,
): Iterable<string> {
  const wanted = findLines(find);
  if (wanted.length === 0) return;
  const target = dedent(wanted);
  const spans = splitWithOffsets(content);
  for (let i = 0; i + wanted.length <= spans.length; i += 1) {
    const blockLines = spans
      .slice(i, i + wanted.length)
      .map((s: LineSpan) => s.text);
    if (dedent(blockLines) === target) {
      yield sliceWindow(content, spans, i, wanted.length);
    }
  }
}

// --- stage 5: escape-normalized ---------------------------------------------

// Models sometimes double-escape: literal \n \t \" etc. arrive in old_string
// where the file holds the real character. Compare after unescaping both.
function unescapeString(s: string): string {
  return s.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (_m, ch: string): string => {
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "\n":
        return "\n";
      default:
        return ch;
    }
  });
}

function* escapeNormalizedCandidates(
  content: string,
  find: string,
): Iterable<string> {
  const unescaped = unescapeString(find);
  if (unescaped === find) return;
  if (content.includes(unescaped)) yield unescaped;
  const wanted = findLines(unescaped);
  const spans = splitWithOffsets(content);
  for (let i = 0; i + wanted.length <= spans.length; i += 1) {
    const block = sliceWindow(content, spans, i, wanted.length);
    if (unescapeString(block) === unescaped) yield block;
  }
}

// --- stage 6: trimmed-boundary ----------------------------------------------

// Stray whitespace on the boundaries of the whole block (leading blank line,
// trailing spaces) — only meaningful when trimming changes the string.
function* trimmedBoundaryCandidates(
  content: string,
  find: string,
): Iterable<string> {
  const trimmed = find.trim();
  if (trimmed === find || trimmed.length === 0) return;
  if (content.includes(trimmed)) yield trimmed;
  const wanted = trimmed.split("\n");
  const spans = splitWithOffsets(content);
  for (let i = 0; i + wanted.length <= spans.length; i += 1) {
    const block = sliceWindow(content, spans, i, wanted.length);
    if (block.trim() === trimmed) yield block;
  }
}

// --- stage 7: block-anchor ---------------------------------------------------

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

function lineSimilarity(a: string, b: string): number {
  const x = a.trim();
  const y = b.trim();
  const maxLen = Math.max(x.length, y.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(x, y) / maxLen;
}

// When several skeleton-identical blocks exist, the middle lines must clear
// this average similarity for the best candidate to win. A single anchored
// candidate is accepted as-is: the model got the boundaries right and there
// is nowhere else the block could be.
const BLOCK_ANCHOR_MULTI_THRESHOLD = 0.3;

// Anchor on the first and last lines of a >=3-line block and tolerate drift
// in the middle. Span is capped relative to the find so an anchor pair far
// apart in the file can't swallow half the module.
function* blockAnchorCandidates(
  content: string,
  find: string,
): Iterable<string> {
  const wanted = findLines(find);
  if (wanted.length < 3) return;
  const firstAnchor = wanted[0]!.trim();
  const lastAnchor = wanted[wanted.length - 1]!.trim();
  if (firstAnchor === "" || lastAnchor === "") return;
  const spans = splitWithOffsets(content);
  const maxSpan = Math.max(wanted.length * 2, wanted.length + 3);

  const candidates: { start: number; end: number }[] = [];
  for (let i = 0; i < spans.length; i += 1) {
    if (spans[i]!.text.trim() !== firstAnchor) continue;
    for (let j = i + 2; j < spans.length && j - i + 1 <= maxSpan; j += 1) {
      if (spans[j]!.text.trim() === lastAnchor) {
        candidates.push({ start: i, end: j });
        break;
      }
    }
  }
  if (candidates.length === 0) return;

  const middleSimilarity = (c: { start: number; end: number }): number => {
    const middleWanted = wanted.slice(1, -1);
    const middleGot = spans
      .slice(c.start + 1, c.end)
      .map((s: LineSpan) => s.text);
    if (middleWanted.length === 0) return 1;
    let total = 0;
    const n = Math.max(middleWanted.length, middleGot.length);
    for (let k = 0; k < n; k += 1) {
      total += lineSimilarity(middleWanted[k] ?? "", middleGot[k] ?? "");
    }
    return total / n;
  };

  if (candidates.length === 1) {
    const c = candidates[0]!;
    yield sliceWindow(content, spans, c.start, c.end - c.start + 1);
    return;
  }
  let best: { start: number; end: number } | null = null;
  let bestScore = -1;
  for (const c of candidates) {
    const score = middleSimilarity(c);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (best && bestScore >= BLOCK_ANCHOR_MULTI_THRESHOLD) {
    yield sliceWindow(content, spans, best.start, best.end - best.start + 1);
  }
}

// --- driver ------------------------------------------------------------------

const LADDER: { stage: MatchStage; gen: CandidateGen }[] = [
  { stage: "exact", gen: exactCandidates },
  { stage: "line-trimmed", gen: lineTrimmedCandidates },
  { stage: "whitespace-normalized", gen: whitespaceNormalizedCandidates },
  { stage: "indentation-flexible", gen: indentationFlexibleCandidates },
  { stage: "escape-normalized", gen: escapeNormalizedCandidates },
  { stage: "trimmed-boundary", gen: trimmedBoundaryCandidates },
  { stage: "block-anchor", gen: blockAnchorCandidates },
];

export function resolveEditMatch(
  content: string,
  oldString: string,
  opts?: { replaceAll?: boolean },
): MatchOutcome | MatchFailure {
  let sawAmbiguous = false;
  for (const { stage, gen } of LADDER) {
    const seen = new Set<string>();
    for (const candidate of gen(content, oldString)) {
      if (candidate.length === 0 || seen.has(candidate)) continue;
      seen.add(candidate);
      const first = content.indexOf(candidate);
      if (first === -1) continue;
      if (opts?.replaceAll) {
        return { ok: true, matched: candidate, stage };
      }
      if (content.lastIndexOf(candidate) === first) {
        return { ok: true, matched: candidate, stage };
      }
      sawAmbiguous = true;
    }
  }
  return { ok: false, reason: sawAmbiguous ? "not_unique" : "no_match" };
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}
