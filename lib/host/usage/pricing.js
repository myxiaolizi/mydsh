/**
 * Model price table and cost estimation.
 *
 * Only the DeepSeek official account exposes a balance endpoint, so every other
 * provider has to be priced locally. Prices are declared per million tokens in
 * the provider's own currency and are applied to the token counts DSH already
 * records on each assistant message — no extra provider call is made.
 *
 * The table is data, not logic: an operator can override any entry from the
 * plugin settings without touching this file, which matters because vendors
 * change prices more often than they change APIs.
 */

/**
 * Built-in prices, CNY per million tokens.
 *
 * `cacheRead` and `cacheWrite` are optional; when absent the input price is
 * used, which over-estimates cached reads rather than under-estimating them.
 */
export const DEFAULT_PRICES = Object.freeze({
  'deepseek/deepseek-chat': { input: 2, output: 8, cacheRead: 0.5 },
  'deepseek/deepseek-reasoner': { input: 4, output: 16, cacheRead: 1 },
  'deepseek/deepseek-coder': { input: 2, output: 8, cacheRead: 0.5 },
  'openai/gpt-4o': { input: 18, output: 72, currency: 'USD' },
  'openai/gpt-4o-mini': { input: 1.1, output: 4.3, currency: 'USD' },
  'openai/o1': { input: 108, output: 432, currency: 'USD' },
  'anthropic/claude-3-5-sonnet': { input: 21, output: 108, currency: 'USD' },
  'anthropic/claude-3-5-haiku': { input: 5.8, output: 29, currency: 'USD' },
  'google/gemini-1.5-pro': { input: 9, output: 36, currency: 'USD' },
  'google/gemini-1.5-flash': { input: 0.5, output: 2.2, currency: 'USD' },
  'moonshot/moonshot-v1-8k': { input: 12, output: 12 },
  'zhipu/glm-4': { input: 100, output: 100 },
  'qwen/qwen-max': { input: 20, output: 60 },
  'qwen/qwen-plus': { input: 0.8, output: 2 },
});

/** Prefix matching so `deepseek-chat-0715` inherits the `deepseek-chat` price. */
function lookupPrice(prices, provider, model) {
  const exact = prices[`${provider}/${model}`];
  if (exact !== undefined) return exact;

  // Longest matching prefix wins, so a dated model beats a series entry.
  let best;
  let bestLength = -1;
  const prefix = `${provider}/`;
  for (const [key, price] of Object.entries(prices)) {
    if (!key.startsWith(prefix)) continue;
    const name = key.slice(prefix.length);
    if (model.startsWith(name) && name.length > bestLength) {
      best = price;
      bestLength = name.length;
    }
  }
  return best;
}

/**
 * Cost of one usage record.
 *
 * Returns `undefined` when no price is known, so the caller can show
 * "unknown price" instead of a confident zero.
 */
export function estimateCost(usage, provider, model, { prices = DEFAULT_PRICES, usdToCny = 7.2 } = {}) {
  const price = lookupPrice(prices, provider, model);
  if (price === undefined) return undefined;

  const input = num(usage?.inputTokens);
  const output = num(usage?.outputTokens);
  const cacheRead = num(usage?.cacheReadTokens);
  const cacheWrite = num(usage?.cacheWriteTokens);

  const inputPrice = price.input ?? 0;
  const cacheReadPrice = price.cacheRead ?? inputPrice;
  const cacheWritePrice = price.cacheWrite ?? inputPrice;

  // Cached tokens are billed in addition to the reported input count for most
  // vendors, matching how DSH records cache reads separately from input.
  const perMillion =
    input * inputPrice +
    output * (price.output ?? 0) +
    cacheRead * cacheReadPrice +
    cacheWrite * cacheWritePrice;

  const amount = perMillion / 1_000_000;
  const currency = price.currency ?? 'CNY';
  return {
    amount: currency === 'USD' ? amount * usdToCny : amount,
    original: amount,
    currency: 'CNY',
    priced: true,
  };
}

function num(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Merge a user override table over the built-ins. */
export function effectivePrices(overrides) {
  if (overrides === null || typeof overrides !== 'object') return DEFAULT_PRICES;
  return { ...DEFAULT_PRICES, ...overrides };
}
