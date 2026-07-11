// Estimated public API pricing per 1M tokens, as published by each provider.
// List prices only — does not account for batch discounts or negotiated
// rates. cachedInputPerM, when set, is applied to the cached portion of
// input tokens (see calculateCost). Treat any displayed cost as
// "~estimated" — model IDs from OpenAI-compatible providers can be aliases
// that route to a different underlying model than the rate we matched.
//
// Last reviewed: 2026-04. Update PRICING_AS_OF when refreshing the table.

export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  cachedInputPerM?: number;
  contextWindow?: number;
}

const WILDCARD = "*";

const PRICING: Record<string, Record<string, ModelPricing>> = {
  ollama: {
    [WILDCARD]: { inputPerM: 0, outputPerM: 0 },
  },
  openai: {
    "gpt-4o-mini": { inputPerM: 0.15, outputPerM: 0.6, contextWindow: 128_000 },
    "gpt-4o": { inputPerM: 2.5, outputPerM: 10, contextWindow: 128_000 },
    "o1-mini": { inputPerM: 3, outputPerM: 12, contextWindow: 128_000 },
    o1: { inputPerM: 15, outputPerM: 60, contextWindow: 200_000 },
    "o3-mini": { inputPerM: 1.1, outputPerM: 4.4, contextWindow: 200_000 },
    o3: { inputPerM: 30, outputPerM: 60, contextWindow: 200_000 },
  },
  anthropic: {
    "claude-haiku-4-5": {
      inputPerM: 0.8,
      outputPerM: 4,
      contextWindow: 200_000,
    },
    "claude-sonnet-4-6": {
      inputPerM: 3,
      outputPerM: 15,
      contextWindow: 200_000,
    },
    "claude-opus-4-5": {
      inputPerM: 15,
      outputPerM: 75,
      contextWindow: 200_000,
    },
    "claude-opus-4-7": {
      inputPerM: 15,
      outputPerM: 75,
      contextWindow: 200_000,
    },
  },
  deepseek: {
    // DeepSeek bills cache hits at ~10% of normal input price (automatic
    // server-side context caching, no client opt-in needed).
    "deepseek-chat": {
      inputPerM: 0.27,
      outputPerM: 1.1,
      cachedInputPerM: 0.027,
      contextWindow: 128_000,
    },
    "deepseek-reasoner": {
      inputPerM: 0.55,
      outputPerM: 2.19,
      cachedInputPerM: 0.055,
      contextWindow: 128_000,
    },
  },
};

export function lookupPricing(
  provider: string,
  model: string,
): ModelPricing | null {
  const table = PRICING[provider.toLowerCase()];
  if (!table) return null;
  if (table[WILDCARD]) return table[WILDCARD];
  if (table[model]) return table[model];
  // Longest-prefix wins so `gpt-4o-mini-2024-07-18` matches the mini entry, not gpt-4o.
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (model.startsWith(key)) return table[key] ?? null;
  }
  return null;
}

export function lookupContextWindow(
  provider: string,
  model: string,
): number | null {
  const pricing = lookupPricing(provider, model);
  return pricing?.contextWindow ?? null;
}

export function calculateCost(
  pricing: ModelPricing,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens?: number,
): number {
  const totalIn = Math.max(0, inputTokens);
  const cached = Math.max(0, Math.min(cachedInputTokens ?? 0, totalIn));
  const uncached = totalIn - cached;
  const cachedRate = pricing.cachedInputPerM ?? pricing.inputPerM;
  return (
    (uncached / 1_000_000) * pricing.inputPerM +
    (cached / 1_000_000) * cachedRate +
    (Math.max(0, outputTokens) / 1_000_000) * pricing.outputPerM
  );
}

export function formatCost(dollars: number): string {
  if (!Number.isFinite(dollars) || dollars <= 0) return "$0";
  if (dollars < 0.01) return `${(dollars * 100).toFixed(2)}¢`;
  if (dollars < 1) return `$${dollars.toFixed(3)}`;
  if (dollars < 100) return `$${dollars.toFixed(2)}`;
  return `$${Math.round(dollars)}`;
}
