/**
 * Static, ESTIMATE-ONLY token prices used to compute how much prompt caching saved.
 * The Usage & Cost headline COST stays provider-reported; these prices only drive
 * the "saved by caching" figure, which is inherently an estimate (real per-call
 * pricing varies by plan, region, batch, and 1M-context tiers).
 *
 * Prompt caching economics: a token served from cache (cache READ) is billed far
 * below a full input token — ~0.1x for Anthropic, ~0.5x for OpenAI, ~0.25x for
 * Gemini. So each cached-read token saves roughly (inputPrice − cacheReadPrice).
 * We only have cache-READ counts (`cachedInputTokens`) cross-provider, so we
 * estimate savings from those; cache-WRITE surcharge is ignored (small, and not
 * tracked). Prices are USD per 1,000,000 tokens.
 */
export interface TokenInputPrices {
  inputPerMillion: number;
  cacheReadPerMillion: number;
}

interface PriceRule {
  match: RegExp;
  prices: TokenInputPrices;
}

// Matched in ORDER against the (normalized) model id. Anthropic values mirror the
// Claude Code pricing catalog (cache read = 0.1× input); OpenAI/Gemini are list
// prices from their pricing pages. ESTIMATES only; 1M-context variants carry a
// server-side surcharge not reflected here (so savings undercount there).
const PRICE_RULES: PriceRule[] = [
  // Anthropic (more specific first).
  { match: /opus-4(\.|-)?[01]\b/i, prices: { inputPerMillion: 15, cacheReadPerMillion: 1.5 } }, // Opus 4 / 4.1
  { match: /opus/i, prices: { inputPerMillion: 5, cacheReadPerMillion: 0.5 } }, // Opus 4.5+ / 5
  { match: /sonnet-?5/i, prices: { inputPerMillion: 2, cacheReadPerMillion: 0.2 } }, // Sonnet 5
  { match: /sonnet/i, prices: { inputPerMillion: 3, cacheReadPerMillion: 0.3 } }, // Sonnet 3.x/4.x
  { match: /haiku/i, prices: { inputPerMillion: 1, cacheReadPerMillion: 0.1 } },
  { match: /fable|mythos/i, prices: { inputPerMillion: 10, cacheReadPerMillion: 1 } },
  // OpenAI / Codex — cached input ≈ 0.25–0.5× (automatic caching, no write surcharge).
  {
    match: /gpt-4o-mini|o4-mini|o3-mini/i,
    prices: { inputPerMillion: 0.6, cacheReadPerMillion: 0.15 },
  },
  {
    match: /gpt-4\.1|gpt-4o|codex|gpt-5|o3|o4/i,
    prices: { inputPerMillion: 2.5, cacheReadPerMillion: 0.625 },
  },
  // Google Gemini — cached ≈ 0.25× input.
  { match: /gemini.*flash/i, prices: { inputPerMillion: 0.3, cacheReadPerMillion: 0.075 } },
  { match: /gemini/i, prices: { inputPerMillion: 1.25, cacheReadPerMillion: 0.3125 } },
];

/** Input prices for a model id, or null when it isn't in the estimate table. */
export function modelInputPrices(model: string): TokenInputPrices | null {
  for (const rule of PRICE_RULES) {
    if (rule.match.test(model)) {
      return rule.prices;
    }
  }
  return null;
}

/**
 * Estimated USD saved by serving `cacheReadTokens` from the prompt cache instead of
 * as full-price input, for `model`. Returns null when the model isn't priced (so
 * callers can fall back to showing the cached-token count without a dollar figure).
 */
export function estimateCacheSavingsUsd(model: string, cacheReadTokens: number): number | null {
  if (cacheReadTokens <= 0) {
    return 0;
  }
  const prices = modelInputPrices(model);
  if (!prices) {
    return null;
  }
  return (cacheReadTokens / 1_000_000) * (prices.inputPerMillion - prices.cacheReadPerMillion);
}

/** Sum of per-model cache savings; null-priced models contribute 0 but are counted separately. */
export function sumCacheSavingsUsd(perModel: Array<{ model: string; cacheReadTokens: number }>): {
  savingsUsd: number;
  pricedModels: number;
  unpricedModels: number;
} {
  let savingsUsd = 0;
  let priced = 0;
  let unpriced = 0;
  for (const entry of perModel) {
    const s = estimateCacheSavingsUsd(entry.model, entry.cacheReadTokens);
    if (s === null) {
      if (entry.cacheReadTokens > 0) unpriced += 1;
    } else {
      savingsUsd += s;
      if (entry.cacheReadTokens > 0) priced += 1;
    }
  }
  return { savingsUsd, pricedModels: priced, unpricedModels: unpriced };
}

/** Compact USD formatter for savings figures. */
export function formatSavingsUsd(value: number): string {
  if (value >= 100) return `$${value.toFixed(0)}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(3)}`;
}
