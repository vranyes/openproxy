// F7b: cost accounting. Pricing comes from models.dev (or an explicit config
// override) as USD per 1,000,000 tokens; usage comes from the translated
// adapter's `Usage`. This module is pure: it never loads a catalog or touches
// the network, so the mapping from billed tokens to USD is unit-testable.

/** USD per 1,000,000 tokens, per billing category. */
export interface ModelCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * Billed token counts for one request. Non-cached input MUST exclude cache
 * reads/writes (the @opencode/ai `Usage` breakdown already guarantees this);
 * a null count means "not reported" and contributes nothing.
 */
export interface UsageBilling {
  nonCachedInputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

/**
 * USD for one request, or null when pricing is unknown. Prices are USD per 1e6
 * tokens. `cacheRead`/`cacheWrite` fall back to the `input` price when absent.
 *
 * Returns null when BOTH `input` and `output` prices are absent, and when any
 * category with `tokens > 0` has no resolvable price (never guess). Null (or
 * non-positive) token counts contribute nothing. The result is rounded to 6 dp.
 */
export function costUsd(billing: UsageBilling, cost: ModelCost | null | undefined): number | null {
  if (!cost) return null;
  if (cost.input === undefined && cost.output === undefined) return null;
  // Nothing was reported: cost is unknown, not zero. (A usage with zero tokens
  // still resolves to 0, distinguishing "not reported" from "free".)
  if (
    billing.nonCachedInputTokens === null &&
    billing.outputTokens === null &&
    billing.cacheReadTokens === null &&
    billing.cacheWriteTokens === null
  ) {
    return null;
  }

  const pIn = cost.input;
  const pCr = cost.cacheRead ?? cost.input;
  const pCw = cost.cacheWrite ?? cost.input;

  const categories: ReadonlyArray<{ tokens: number | null; price: number | undefined }> = [
    { tokens: billing.nonCachedInputTokens, price: pIn },
    { tokens: billing.cacheReadTokens, price: pCr },
    { tokens: billing.cacheWriteTokens, price: pCw },
    { tokens: billing.outputTokens, price: cost.output },
  ];

  let total = 0;
  for (const { tokens, price } of categories) {
    if (tokens === null || tokens <= 0) continue;
    if (price === undefined) return null;
    total += tokens * price;
  }
  return Math.round((total / 1_000_000) * 1_000_000) / 1_000_000;
}
