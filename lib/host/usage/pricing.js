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

/**
 * Model-family prices, matched on the model name alone.
 *
 * The built-in table above is keyed `provider/model`, which assumes the provider id names
 * the vendor. It does not: a real install routes through relays called `brainyaiclaw`,
 * `kk`, `si`, so every key missed and the whole install priced at zero.
 *
 * These entries match the model name after the provider prefix is dropped, so
 * `brainyaiclaw` + `wcn/deepseek-v4.1-flash` resolves through the `deepseek` family.
 * Order matters: the first match wins, so put the specific rules before the general ones.
 *
 * This stays a table, not a heuristic: a model that matches nothing is still reported as
 * unpriced rather than guessed, because a confidently wrong cost is worse than none. A
 * user alias like `dsF` deliberately stays unmatched for that reason — the operator can
 * price it from the plugin settings, which beats this file guessing what it points at.
 */
const FAMILY_PRICES = Object.freeze([
  // DeepSeek. The v4 line is priced like chat; reasoner-class models cost more.
  { match: /(^|[-/])deepseek[-_.]?v?\d*(\.\d+)?[-_.]?(reasoner|r1)\b/i, price: { input: 4, output: 16, cacheRead: 1 } },
  { match: /(^|[-/])deepseek([-_.](chat|coder|v\d|flash|pro|max|distill))?\b/i, price: { input: 2, output: 8, cacheRead: 0.5 } },

  // Zhipu GLM.
  { match: /(^|[-/])glm[-_.]?(\d|air|flash|max|plus|turbo|long)/i, price: { input: 4, output: 16, cacheRead: 1 } },

  // Qwen. Version digits sit between the family and the tier (`qwen3.8-max`).
  { match: /(^|[-/])qwen/i, price: { input: 20, output: 60 } },

  // Google Gemini.
  { match: /(^|[-/])gemini/i, price: { input: 9, output: 36, currency: 'USD' } },

  // Anthropic Claude.
  { match: /claude/i, price: { input: 21, output: 108, currency: 'USD' } },

  // Moonshot / Kimi.
  { match: /(moonshot|kimi)/i, price: { input: 12, output: 12 } },

  // OpenAI. The version digits sit between the family and any tier suffix
  // (`gpt-5.6-terra`, `gpt-4o-mini`), so match on the family alone.
  { match: /(^|[-/])gpt[-_.]?4o([-_.]mini)?/i, price: { input: 18, output: 72, currency: 'USD' } },
  { match: /(^|[-/])gpt/i, price: { input: 18, output: 72, currency: 'USD' } },
  { match: /(^|[-/])o[13]([-_.]mini)?\b/i, price: { input: 108, output: 432, currency: 'USD' } },
]);

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
  if (best !== undefined) return best;

  // Fall back to the model family, ignoring who routed the request. Relay providers are
  // the normal case here, and their id says nothing about the underlying model.
  return lookupFamily(model);
}

/**
 * Resolve a price from the model family table.
 *
 * The provider prefix is stripped first because relays namespace models as `vendor/model`
 * (`wcn/deepseek-v4.1-flash`) while first-party ids arrive bare.
 */
function lookupFamily(model) {
  if (typeof model !== 'string' || model === '') return undefined;
  const bare = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  for (const entry of FAMILY_PRICES) {
    if (entry.match.test(bare)) return entry.price;
  }
  return undefined;
}

/**
 * Cost of one usage record.
 *
 * Accepts both field spellings on purpose. The Host's own event payload uses
 * `inputTokens` / `outputTokens`, while `store.js` normalises records down to `input` /
 * `output`. Reading only the long names made every record price out at zero: a valid
 * price row was found, but the token counts came back 0, so 152 billion tokens cost ¥0.
 *
 * Returns `undefined` when no price is known, so the caller can show
 * "unknown price" instead of a confident zero.
 */
export function estimateCost(usage, provider, model, { prices = DEFAULT_PRICES, usdToCny = 7.2 } = {}) {
  const price = lookupPrice(prices, provider, model);
  if (price === undefined) return undefined;

  const input = pick(usage, 'inputTokens', 'input');
  const output = pick(usage, 'outputTokens', 'output');
  const cacheRead = pick(usage, 'cacheReadTokens', 'cacheRead');
  const cacheWrite = pick(usage, 'cacheWriteTokens', 'cacheWrite');

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

/**
 * Read the first of several field names that yields a usable number.
 *
 * The two spellings belong to two layers — Host event payload versus normalised record —
 * and either may reach this function depending on the caller.
 */
function pick(usage, ...names) {
  for (const name of names) {
    if (usage?.[name] === undefined || usage?.[name] === null) continue;
    const value = num(usage[name]);
    if (value !== 0) return value;
  }
  return 0;
}

/** Merge a user override table over the built-ins. */
export function effectivePrices(overrides) {
  if (overrides === null || typeof overrides !== 'object') return DEFAULT_PRICES;
  return { ...DEFAULT_PRICES, ...overrides };
}
