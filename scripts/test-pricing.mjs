/**
 * Verify cost estimation against both field spellings.
 *
 * The bug this guards: `store.js` normalises records to `input`/`output`, while the Host's
 * raw usage payload says `inputTokens`/`outputTokens`. Reading only the long names found a
 * valid price row but zero tokens, so the whole install reported ¥0 — 152 billion tokens
 * for free. A test that only used one spelling would have missed it.
 */
import assert from 'node:assert/strict';
import { estimateCost, effectivePrices } from '../lib/host/usage/pricing.js';

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}\n        ${error.message}`);
  }
};

const prices = effectivePrices();

check('pricing: a normalised record is priced', () => {
  // This is the shape `store.js` hands to the aggregator.
  const cost = estimateCost(
    { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    'deepseek',
    'deepseek-chat',
    { prices },
  );
  assert.ok(cost !== undefined, 'a known model must produce a cost');
  assert.equal(cost.amount, 2, 'deepseek-chat input is 2 CNY per million');
});

check('pricing: a raw Host usage payload is priced', () => {
  // The shape the event carries, before normalisation.
  const cost = estimateCost(
    { inputTokens: 1_000_000, outputTokens: 0 },
    'deepseek',
    'deepseek-chat',
    { prices },
  );
  assert.ok(cost !== undefined);
  assert.equal(cost.amount, 2);
});

check('pricing: normalised and raw spellings agree', () => {
  const normalised = estimateCost({ input: 3_000_000, output: 500_000 }, 'deepseek', 'deepseek-chat', { prices });
  const raw = estimateCost({ inputTokens: 3_000_000, outputTokens: 500_000 }, 'deepseek', 'deepseek-chat', { prices });
  assert.equal(normalised.amount, raw.amount, 'both spellings must price identically');
  // 3M input at 2 + 0.5M output at 8 = 6 + 4 = 10 CNY.
  assert.equal(normalised.amount, 10);
});

check('pricing: a large real-world record costs real money', () => {
  // A session with 1.19 billion input and 1.7 million output, the shape seen on disk.
  const cost = estimateCost({ input: 1_198_247_840, output: 1_731_821 }, 'deepseek', 'deepseek-chat', { prices });
  assert.ok(cost !== undefined);
  assert.ok(cost.amount > 1000, `expected a four-figure cost, got ${cost.amount}`);
});

check('pricing: a relay provider still resolves through the model family', () => {
  // The real install's provider ids are relay names (`brainyaiclaw`, `kk`, `si`), so a
  // `provider/model` key never matched and everything priced at zero.
  for (const [provider, model] of [
    ['brainyaiclaw', 'wcn/deepseek-v4.1-flash'],
    ['kk', 'deepseek-v4.1-flash'],
    ['plmf', 'plmf/glm-5.3-flash'],
    ['si', 'wcn/qwen3.8-max'],
    ['brainyaiclaw', 'wcn/gemini-4-argon'],
    ['brainyaiclaw', 'deepseek-v4-pro'],
  ]) {
    const cost = estimateCost({ input: 1_000_000 }, provider, model, { prices });
    assert.ok(cost !== undefined, `${provider}/${model} must be priced`);
    assert.ok(cost.amount > 0, `${provider}/${model} must cost something`);
  }
});

check('pricing: a reasoner-class model costs more than a chat model', () => {
  const chat = estimateCost({ input: 1_000_000 }, 'relay', 'wcn/deepseek-v4.1-flash', { prices });
  const reasoner = estimateCost({ input: 1_000_000 }, 'relay', 'deepseek-reasoner', { prices });
  assert.ok(reasoner.amount > chat.amount, 'a reasoner must price above chat');
});

check('pricing: an unknown model reports undefined, not zero', () => {
  const cost = estimateCost({ input: 1_000_000 }, 'nobody', 'nothing-at-all', { prices });
  assert.equal(cost, undefined, 'an unknown model must not claim a confident zero');
});

check('pricing: cache reads bill at the cache rate', () => {
  const cost = estimateCost({ cacheRead: 1_000_000, input: 0, output: 0 }, 'deepseek', 'deepseek-chat', { prices });
  assert.ok(cost !== undefined);
  assert.equal(cost.amount, 0.5, 'deepseek-chat cache read is 0.5 CNY per million');
});

check('pricing: USD prices convert with the configured rate', () => {
  const cost = estimateCost({ input: 1_000_000 }, 'openai', 'gpt-4o', { prices, usdToCny: 7.2 });
  assert.ok(cost !== undefined);
  assert.equal(cost.currency, 'CNY');
  // gpt-4o input is 18 USD per million.
  assert.equal(Math.round(cost.amount * 10) / 10, 129.6);
});

check('pricing: a zero-usage record costs nothing but stays priced', () => {
  const cost = estimateCost({ input: 0, output: 0 }, 'deepseek', 'deepseek-chat', { prices });
  assert.ok(cost !== undefined, 'a known model is still priced even at zero usage');
  assert.equal(cost.amount, 0);
});

console.log(`\npricing: ${8 - failures}/8 passed`);
process.exit(failures === 0 ? 0 : 1);
