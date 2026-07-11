import { type Candidate, estimateTokens, renderCandidates } from "./render.js";

export async function fitToBudget(
  candidates: Candidate[],
  tokenBudget: number,
  cwd: string,
): Promise<{ text: string; included: number; estimatedTokens: number }> {
  if (candidates.length === 0) {
    return { text: "", included: 0, estimatedTokens: 0 };
  }

  // Binary search the largest prefix length whose rendered text fits the
  // budget. Aider's repomap does the same — render is the source of truth
  // for token cost, so we re-render at each midpoint rather than approximate.
  let lo = 1;
  let hi = candidates.length;
  let bestText = "";
  let bestCount = 0;
  let bestTokens = 0;

  // Always render at least the cheapest non-empty option first so we have a
  // floor; if even that overflows, return it anyway (it's the smallest we
  // can produce and is more useful than nothing).
  const minText = await renderCandidates(candidates.slice(0, 1), cwd);
  const minTokens = estimateTokens(minText);
  bestText = minText;
  bestCount = 1;
  bestTokens = minTokens;

  if (minTokens > tokenBudget) {
    return { text: bestText, included: bestCount, estimatedTokens: bestTokens };
  }

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const text = await renderCandidates(candidates.slice(0, mid), cwd);
    const tokens = estimateTokens(text);
    if (tokens <= tokenBudget) {
      bestText = text;
      bestCount = mid;
      bestTokens = tokens;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return { text: bestText, included: bestCount, estimatedTokens: bestTokens };
}
