/**
 * Localization tests.
 *
 * The plugin must follow DSH's language, and the one failure mode that matters is a
 * key present in one dictionary and missing from the other: that renders an English
 * string inside a Chinese page, or a raw key anywhere. These checks are cheap and
 * catch exactly that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DICTS, KEYS, NS, ZH, EN, makeTranslator } from '../src/client/i18n.js';

test('i18n: both dictionaries define the same keys', () => {
  const zh = new Set(Object.keys(DICTS[ZH]));
  const en = new Set(Object.keys(DICTS[EN]));
  const onlyZh = [...zh].filter((key) => !en.has(key));
  const onlyEn = [...en].filter((key) => !zh.has(key));
  assert.deepEqual(onlyZh, [], `keys only in ${ZH}: ${onlyZh.join(', ')}`);
  assert.deepEqual(onlyEn, [], `keys only in ${EN}: ${onlyEn.join(', ')}`);
});

test('i18n: no dictionary has an empty string', () => {
  for (const [locale, dict] of Object.entries(DICTS)) {
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(typeof value, 'string', `${locale}.${key} must be a string`);
      assert.notEqual(value.trim(), '', `${locale}.${key} must not be empty`);
    }
  }
});

test('i18n: the Chinese dictionary contains no English-only sentences', () => {
  // A sentence with no CJK characters in the Chinese dictionary means a translation
  // was forgotten. Acronyms and units are legitimately Latin, so only multi-word
  // prose is checked.
  const prose = /[A-Za-z]{4,}\s+[A-Za-z]{4,}/;
  const offenders = [];
  for (const [key, value] of Object.entries(DICTS[ZH])) {
    const cjk = /[\u4e00-\u9fff]/.test(value);
    if (!cjk && prose.test(value)) offenders.push(`${key}: ${value}`);
  }
  assert.deepEqual(offenders, [], `untranslated Chinese entries:\n${offenders.join('\n')}`);
});

test('i18n: the English dictionary contains no Chinese characters', () => {
  const offenders = [];
  for (const [key, value] of Object.entries(DICTS[EN])) {
    if (/[\u4e00-\u9fff]/.test(value)) offenders.push(`${key}: ${value}`);
  }
  assert.deepEqual(offenders, [], `Chinese leaked into English:\n${offenders.join('\n')}`);
});

test('i18n: the translator resolves in the active locale', () => {
  const zh = makeTranslator(ZH);
  const en = makeTranslator(EN);
  assert.equal(zh('nav.title'), DICTS[ZH]['nav.title']);
  assert.equal(en('nav.title'), DICTS[EN]['nav.title']);
  assert.notEqual(zh('nav.title'), en('nav.title'), 'the two locales must differ');
  assert.equal(zh.locale, ZH);
  assert.equal(en.locale, EN);
});

test('i18n: an unknown key falls back to the key instead of blank', () => {
  const t = makeTranslator(ZH);
  assert.equal(t('no.such.key'), 'no.such.key');
});

test('i18n: placeholders are interpolated and unknown ones are left visible', () => {
  const t = makeTranslator(EN);
  assert.match(t('usage.indexedSessions', { n: 440 }), /440/);
  // A missing variable must stay as `{n}` rather than printing `undefined`.
  assert.match(t('usage.indexedSessions'), /\{n\}/);
});

test('i18n: every locale registers under one namespace', () => {
  assert.equal(NS, 'mydsh');
  assert.deepEqual(Object.keys(DICTS).sort(), [EN, ZH].sort());
  // KEYS is the union the client renders, so it must match the Chinese dictionary
  // exactly — that is the one the test above proves is complete.
  assert.deepEqual([...KEYS].sort(), Object.keys(DICTS[ZH]).sort());
});

test('i18n: keys are grouped by surface', () => {
  // Catches a typo such as `usage .title`, which would silently become a new key.
  for (const key of KEYS) {
    assert.match(key, /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/, `malformed key: ${key}`);
  }
});

test('i18n: a transport failure is worded in the active language', async () => {
  const { describeFailure } = await import('../src/client/failure.js');
  const zh = makeTranslator(ZH);
  const en = makeTranslator(EN);

  // The browser's own text for a failed fetch is English regardless of session
  // language, so the code must win over the message.
  const network = { code: 'network', message: 'Failed to fetch' };
  assert.equal(describeFailure(zh, network), DICTS[ZH]['error.network']);
  assert.equal(describeFailure(en, network), DICTS[EN]['error.network']);
  assert.doesNotMatch(describeFailure(zh, network), /Failed to fetch/);

  // A Host message is the authority on its own diagnostics and passes through,
  // because replacing it with a generic sentence would hide the cause.
  assert.equal(describeFailure(zh, { code: 'job-failed', message: 'disk full' }), 'disk full');

  // An unrecognized shape still says something rather than rendering `undefined`.
  assert.equal(describeFailure(zh, undefined), DICTS[ZH]['error.unknown']);
  assert.equal(describeFailure(zh, 'plain string'), 'plain string');
});

test('i18n: every field label the Host declares resolves in both locales', async () => {
  const { collection } = await import('../lib/host/settings-meta.js');
  const zh = makeTranslator(ZH);
  const en = makeTranslator(EN);
  const missing = [];

  for (const [section, definition] of Object.entries(collection)) {
    // The section's own title and description are rendered by the Display panel.
    for (const key of [definition.title, definition.description]) {
      if (typeof key !== 'string') continue;
      if (zh(key) === key) missing.push(`${section}: ${key} (zh)`);
      if (en(key) === key) missing.push(`${section}: ${key} (en)`);
    }
    for (const field of definition.fields) {
      if (typeof field.label === 'string' && zh(field.label) === field.label) {
        missing.push(`${section}.${field.key}: ${field.label}`);
      }
      for (const option of field.options ?? []) {
        if (typeof option.label === 'string' && zh(option.label) === option.label) {
          missing.push(`${section}.${field.key} option ${option.value}: ${option.label}`);
        }
      }
    }
  }
  assert.deepEqual(missing, [], `fields without a translation:\n${missing.join('\n')}`);
});

test('i18n: a translator built without a locale service still works', async () => {
  const { createTranslator } = await import('../src/client/i18n.js');
  // No ctx at all: the plugin must not depend on the service to render text.
  const handle = createTranslator(undefined);
  assert.equal(typeof handle.t, 'function');
  assert.equal(handle.t('nav.title'), DICTS[EN]['nav.title']);
  assert.equal(typeof handle.subscribe(), 'function');

  // A ctx whose locale service throws must degrade rather than propagate.
  const hostile = { get: () => { throw new Error('nope'); } };
  const guarded = createTranslator(hostile);
  assert.equal(typeof guarded.t('nav.title'), 'string');
});

test('i18n: the translator follows a locale change', async () => {
  const { createTranslator } = await import('../src/client/i18n.js');
  let active = ZH;
  const listeners = new Set();
  const locale = {
    register: () => () => {},
    bind: (ns) => (key) => DICTS[active]?.[key] ?? key,
    getLocale: () => ({ active, locales: [ZH, EN], revision: 0 }),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const ctx = { get: (name) => (name === 'locale' ? locale : undefined) };

  const seen = [];
  const handle = createTranslator(ctx, (next) => seen.push(next));
  assert.equal(handle.t('nav.title'), DICTS[ZH]['nav.title']);

  active = EN;
  for (const fn of listeners) fn();
  assert.deepEqual(seen, [EN], 'the change callback reports the new locale');
  assert.equal(handle.t('nav.title'), DICTS[EN]['nav.title'], 'lookups follow the change');
});
