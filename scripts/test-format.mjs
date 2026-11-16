/**
 * Check the number and relative-time formatters.
 *
 * Both rules exist because getting them wrong is visible in the UI rather than failing
 * loudly: `formatNumber` compresses past 万, and a value past 亿 used to render as
 * `1520785.1万` — arithmetically right, unreadable in practice. `formatRelative` used to
 * hard-code English units, which put "13d ago" inside a Chinese interface.
 */
import assert from 'node:assert/strict';
import { formatNumber, formatRelative, formatMoney, formatBytes } from '../src/client/format.js';
import { DICTS, ZH, EN } from '../src/client/i18n.js';

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

// A stand-in for the panel's `t`, reading the shipped dictionaries.
const makeT = (locale) => (key, params = {}) => {
  const template = DICTS[locale][key];
  if (template === undefined) return `«${key}»`;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
};

check('format: small numbers are left alone', () => {
  assert.equal(formatNumber(0), '0');
  assert.equal(formatNumber(999), '999');
  assert.equal(formatNumber(1234), '1,234');
});

check('format: 万 kicks in at ten thousand', () => {
  assert.equal(formatNumber(10_000), '1.0万');
  assert.equal(formatNumber(28_5201), '28.5万');
});

check('format: 亿 replaces 万 past a hundred million', () => {
  // The regression: 1_520_785_101 tokens rendered as "1520785.1万".
  assert.equal(formatNumber(1_520_785_101), '15.2亿');
  assert.equal(formatNumber(100_000_000), '1.0亿');
  // Just under the boundary must stay in 万.
  assert.equal(formatNumber(99_999_999), '10000.0万');
});

check('format: non-finite input degrades to zero', () => {
  assert.equal(formatNumber(undefined), '0');
  assert.equal(formatNumber(Number.NaN), '0');
});

check('format: money keeps small amounts precise', () => {
  assert.equal(formatMoney(0), '¥0');
  assert.equal(formatMoney(0.0001), '¥0.0001');
  assert.equal(formatMoney(12.345), '¥12.35');
});

check('format: bytes use binary units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(398_800_000), '380.3 MiB');
});

check('format: relative time follows the active language', () => {
  const now = 1_700_000_000_000;
  const zh = makeT(ZH);
  const en = makeT(EN);
  const minute = 60_000;

  assert.equal(formatRelative(now - 10_000, now, zh), '刚刚');
  assert.equal(formatRelative(now - 10_000, now, en), 'just now');
  assert.equal(formatRelative(now - 5 * minute, now, zh), '5 分钟前');
  assert.equal(formatRelative(now - 5 * minute, now, en), '5m ago');
  assert.equal(formatRelative(now - 3 * 60 * minute, now, zh), '3 小时前');
  assert.equal(formatRelative(now - 13 * 24 * 60 * minute, now, zh), '13 天前');
});

check('format: Chinese relative time contains no English letters', () => {
  const now = 1_700_000_000_000;
  const zh = makeT(ZH);
  for (const offset of [10_000, 5 * 60_000, 3 * 3_600_000, 13 * 86_400_000]) {
    const text = formatRelative(now - offset, now, zh);
    assert.ok(!/[a-zA-Z]/.test(text), `"${text}" still contains Latin letters`);
  }
});

check('format: a missing translate falls back to neutral units', () => {
  // Not an error state: the module stays React-free so tests can import it directly.
  const now = 1_700_000_000_000;
  assert.equal(formatRelative(now - 3 * 3_600_000, now), '3h');
  assert.equal(formatRelative(now - 10_000, now), '');
});

check('format: relative time rejects nonsense input', () => {
  assert.equal(formatRelative(0), '—');
  assert.equal(formatRelative(-1), '—');
  assert.equal(formatRelative(undefined), '—');
});

check('format: every time key exists in both languages', () => {
  for (const key of ['time.justNow', 'time.minutes', 'time.hours', 'time.days']) {
    assert.ok(DICTS[ZH][key] !== undefined, `zh is missing ${key}`);
    assert.ok(DICTS[EN][key] !== undefined, `en is missing ${key}`);
  }
});

console.log(`\nformat rules: ${11 - failures}/11 passed`);
process.exit(failures === 0 ? 0 : 1);
