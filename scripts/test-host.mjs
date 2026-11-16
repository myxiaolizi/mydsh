/**
 * Host smoke test.
 *
 * The Host half runs inside DSH's process, so a broken import or a wrong default
 * only shows up when a user activates the plugin. This script exercises the
 * modules directly in plain Node so those failures surface during the build
 * instead of in someone's editor.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error) });
  }
};

// ── util ───────────────────────────────────────────────────────────────────
await check('util: mergeDeep merges objects but replaces arrays', async () => {
  const { mergeDeep, clamp, num, pool } = await import('../lib/host/util.js');
  assert.deepEqual(mergeDeep({ a: 1, b: { c: 2 } }, { b: { d: 3 } }), { a: 1, b: { c: 2, d: 3 } });
  assert.deepEqual(mergeDeep({ a: [1, 2] }, { a: [3] }), { a: [3] });
  assert.equal(clamp(Number.NaN, 2, 8), 2);
  assert.equal(clamp(99, 2, 8), 8);
  assert.equal(num('12'), 12);
  assert.equal(num('abc', 5), 5);
  const order = await pool([1, 2, 3, 4], 2, async (n) => n * 2);
  assert.deepEqual(order, [2, 4, 6, 8]);
});

await check('util: atomic write and read round-trip', async () => {
  const { writeJsonAtomic, readJson } = await import('../lib/host/util.js');
  const dir = await mkdtemp(join(tmpdir(), 'mydsh-'));
  try {
    const file = join(dir, 'nested', 'doc.json');
    await writeJsonAtomic(file, { hello: 'world', n: 1 });
    assert.deepEqual(await readJson(file), { hello: 'world', n: 1 });
    assert.equal(await readJson(join(dir, 'absent.json')), undefined);
    assert.equal(await readJson(join(dir, 'nested', 'doc.json')).then((v) => v.n), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── settings ───────────────────────────────────────────────────────────────
await check('settings: defaults, patch merge, and persistence', async () => {
  const { SettingsStore } = await import('../lib/host/settings.js');
  const dir = await mkdtemp(join(tmpdir(), 'mydsh-'));
  try {
    const file = join(dir, 'settings.json');
    const store = new SettingsStore(file);
    const snapshot = await store.snapshot();
    assert.equal(snapshot.interface.enabled, true);
    assert.equal(snapshot.backup.enabled, false);

    await store.patch('interface', { hideBrandName: true });
    const reloaded = new SettingsStore(file);
    const persisted = await reloaded.section('interface');
    assert.equal(persisted.hideBrandName, true);
    assert.equal(persisted.enabled, true, 'sibling defaults must survive a partial patch');

    // Coalescing: many patches in flight must leave one coherent document.
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.patch('usage', { usdToCny: 7 + i / 100 })));
    const final = await new SettingsStore(file).section('usage');
    assert.ok(final.usdToCny >= 7 && final.usdToCny < 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── retry classification ──────────────────────────────────────────────────
await check('retry: classifies provider failures into kinds', async () => {
  const { classifyError, RETRYABLE_BY_DEFAULT } = await import('../lib/host/retry/classify.js');
  assert.equal(classifyError({ status: 429 }), 'rate-limit');
  assert.equal(classifyError({ message: 'The engine is currently overloaded' }), 'overloaded');
  assert.equal(classifyError({ message: 'Request timed out' }), 'timeout');
  assert.equal(classifyError({ message: 'ECONNRESET' }), 'network');
  assert.equal(classifyError({ status: 401 }), 'auth');
  assert.equal(classifyError({ status: 402 }), 'quota');
  assert.equal(classifyError({ message: 'maximum context length exceeded' }), 'context-overflow');
  assert.equal(classifyError({ message: 'The operation was aborted' }), 'cancelled');
  assert.equal(classifyError({ status: 500 }), 'server-error');
  assert.ok(!RETRYABLE_BY_DEFAULT.includes('auth'), 'auth must not retry blindly');
  assert.ok(!RETRYABLE_BY_DEFAULT.includes('quota'), 'quota must not retry blindly');
});

await check('retry: backoff grows, caps, and stays non-negative', async () => {
  const { backoffDelay } = await import('../lib/host/retry/classify.js');
  const fixed = { random: () => 0.5, jitterRatio: 0 };
  assert.equal(backoffDelay(1, fixed), 1000);
  assert.equal(backoffDelay(2, fixed), 2000);
  assert.equal(backoffDelay(3, fixed), 4000);
  assert.equal(backoffDelay(20, { ...fixed, maxDelayMs: 30_000 }), 30_000);
  const jittered = backoffDelay(1, { random: () => 0, jitterRatio: 0.5 });
  assert.ok(jittered >= 0);
});

// ── pricing ────────────────────────────────────────────────────────────────
await check('pricing: resolves known routes and reports unknown ones', async () => {
  const { estimateCost, DEFAULT_PRICES } = await import('../lib/host/usage/pricing.js');
  const known = estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'deepseek', 'deepseek-chat');
  assert.ok(known !== undefined);
  assert.equal(known.currency, 'CNY');
  assert.equal(known.amount, 10, 'deepseek-chat is 2 + 8 CNY per million');

  const dated = estimateCost({ inputTokens: 1_000_000 }, 'deepseek', 'deepseek-chat-0715');
  assert.ok(dated !== undefined, 'a dated model must inherit its series price');

  const unknown = estimateCost({ inputTokens: 10 }, 'nobody', 'nothing');
  assert.equal(unknown, undefined);

  assert.ok(Object.keys(DEFAULT_PRICES).length > 5);
});

// ── usage aggregation ─────────────────────────────────────────────────────
await check('usage: aggregates records into totals, groups, and buckets', async () => {
  const { aggregate, resolveRange, recordsFromLog } = await import('../lib/host/usage/store.js');
  const now = Date.now();
  const events = [
    { type: 'assistant/message', seq: 1, time: now - 1000, data: { usage: { inputTokens: 100, outputTokens: 50 }, turn: 1, message: { source: { provider: 'deepseek', model: 'deepseek-chat' } } } },
    { type: 'assistant/message', seq: 2, time: now - 500, data: { usage: { inputTokens: 200, outputTokens: 100 }, turn: 1, message: { source: { provider: 'openai', model: 'gpt-4o' } } } },
    { type: 'user/message', seq: 3, time: now, data: {} },
  ];
  const records = recordsFromLog('s1', events, { workspace: '/w' });
  assert.equal(records.length, 2, 'only assistant messages with usage count');

  const range = resolveRange({ kind: 'today' }, now);
  const result = aggregate(records, { ...range, groupBy: 'provider', costOf: () => ({ amount: 0.5 }) });
  assert.equal(result.totals.calls, 2);
  assert.equal(result.totals.input, 300);
  assert.equal(result.totals.output, 150);
  assert.equal(result.totals.cost, 1);
  assert.equal(result.groups.length, 2);
  assert.ok(result.buckets.length > 0);
});

await check('usage: empty corpus yields a valid empty aggregate', async () => {
  const { aggregate, resolveRange } = await import('../lib/host/usage/store.js');
  const range = resolveRange({ kind: '7d' });
  const result = aggregate([], { ...range, groupBy: 'model' });
  assert.equal(result.totals.total, 0);
  assert.equal(result.groups.length, 0);
});

// ── zip writer ─────────────────────────────────────────────────────────────
await check('backup: zip writer produces a structurally valid archive', async () => {
  const { ZipWriter } = await import('../lib/host/backup/archive.js');
  const dir = await mkdtemp(join(tmpdir(), 'mydsh-'));
  try {
    const source = join(dir, 'hello.txt');
    await writeFile(source, 'hello mydsh', 'utf8');
    const archive = join(dir, 'out.zip');
    const writer = await ZipWriter.create(archive);
    await writer.addFile(source, 'docs/hello.txt');
    await writer.addBuffer('manifest.json', Buffer.from('{"a":1}', 'utf8'));
    await writer.close();

    const bytes = await readFile(archive);
    assert.equal(bytes.readUInt32LE(0), 0x04034b50, 'must start with a local file header');
    const endOffset = bytes.length - 22;
    assert.equal(bytes.readUInt32LE(endOffset), 0x06054b50, 'must end with the end-of-central-directory');
    assert.equal(bytes.readUInt16LE(endOffset + 8), 2, 'two entries recorded');
    assert.ok(bytes.length > 100);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await check('backup: listFiles walks a tree and skips nothing unexpected', async () => {
  const { listFiles } = await import('../lib/host/backup/archive.js');
  const dir = await mkdtemp(join(tmpdir(), 'mydsh-'));
  try {
    await mkdir(join(dir, 'a', 'b'), { recursive: true });
    await writeFile(join(dir, 'root.txt'), '1', 'utf8');
    await writeFile(join(dir, 'a', 'one.txt'), '2', 'utf8');
    await writeFile(join(dir, 'a', 'b', 'two.txt'), '3', 'utf8');
    const files = await listFiles(dir);
    assert.equal(files.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await check('backup: destinations validate their own configuration', async () => {
  const { LocalDestination, WebdavDestination, OssDestination, destinationFrom } = await import('../lib/host/backup/destinations.js');
  assert.equal((await new LocalDestination({ directory: '' }).ready()).ok, false);
  assert.equal((await new WebdavDestination({ url: '' }).ready()).ok, false);
  assert.equal((await new OssDestination({ bucket: '', endpoint: '' }).ready()).ok, false);
  assert.equal((await new OssDestination({ bucket: 'b', endpoint: 'e' }).ready()).reason, 'no-credentials');

  const dir = await mkdtemp(join(tmpdir(), 'mydsh-'));
  try {
    const local = destinationFrom({ kind: 'local', directory: join(dir, 'copies') });
    assert.equal((await local.ready()).ok, true);
    const file = join(dir, 'x.zip');
    await writeFile(file, 'data', 'utf8');
    const put = await local.put(file);
    assert.ok(put.bytes > 0);
    const listed = await local.list();
    assert.equal(listed.length, 1);
    assert.equal((await local.prune(0)).length, 1);
    assert.equal((await local.list()).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── api ────────────────────────────────────────────────────────────────────
await check('api: router dispatches and rejects unknown routes', async () => {
  const { ApiRouter, ApiError } = await import('../lib/host/api.js');
  const router = new ApiRouter();
  router.get('/ping', async () => ({ pong: true }));
  router.post('/echo', async ({ body }) => ({ got: body }));
  assert.deepEqual(await router.dispatch('GET', '/ping', {}), { pong: true });
  assert.deepEqual(await router.dispatch('GET', '/ping/', {}), { pong: true }, 'trailing slash is insignificant');
  assert.deepEqual(await router.dispatch('POST', '/echo', { body: { a: 1 } }), { got: { a: 1 } });
  await assert.rejects(() => router.dispatch('GET', '/nope', {}), (error) => error instanceof ApiError && error.status === 404);
  assert.throws(() => router.get('/ping', async () => {}), /duplicate route/);
});

// ── sources ────────────────────────────────────────────────────────────────
await check('backup: sources resolve against a synthetic home', async () => {
  const { createSources } = await import('../lib/host/backup/sources.js');
  const dir = await mkdtemp(join(tmpdir(), 'mydsh-'));
  try {
    const home = join(dir, '.dsh');
    const profile = join(home, 'profiles', 'desktop');
    await mkdir(join(home, 'workspaces', 'w1'), { recursive: true });
    await mkdir(join(profile, 'node_modules', 'dsh-x'), { recursive: true });
    await writeFile(join(home, 'config.json'), '{}', 'utf8');
    await writeFile(join(profile, 'cordis.patch.yml'), '- name: x', 'utf8');
    await writeFile(join(profile, 'node_modules', 'dsh-x', 'package.json'), '{"name":"dsh-x","version":"1.2.3"}', 'utf8');

    const sources = createSources({ dshHome: home, profileName: 'desktop', logger: () => {} });
    assert.equal((await sources.workspaces.roots()).length, 1);
    assert.equal((await sources.systemConfig.files()).length >= 2, true);
    const plugins = await sources.plugins.manifest();
    const dshX = plugins.find((p) => p.name === 'dsh-x');
    assert.equal(dshX?.version, '1.2.3');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── settings metadata ──────────────────────────────────────────────────────
await check('settings: every declared field exists in the defaults', async () => {
  const { SettingsStore } = await import('../lib/host/settings.js');
  const { collection } = await import('../lib/host/settings-meta.js');
  const dir = await mkdtemp(join(tmpdir(), 'mydsh-'));
  try {
    const store = new SettingsStore(join(dir, 'settings.json'));
    const snapshot = await store.snapshot();
    const problems = [];

    for (const [section, definition] of Object.entries(collection)) {
      const values = snapshot[section];
      if (values === undefined) {
        problems.push(`${section}: no defaults`);
        continue;
      }
      for (const field of definition.fields) {
        if (!(field.key in values)) problems.push(`${section}.${field.key}: declared but no default`);
        // A gate names a sibling boolean; a typo would grey out a field forever.
        if (field.gate !== undefined && !(field.gate in values)) {
          problems.push(`${section}.${field.gate}: gate target has no default`);
        }
        if (field.kind === 'select' && Array.isArray(field.options)) {
          const allowed = field.options.map((option) => option.value);
          if (allowed.length > 0 && !allowed.includes(values[field.key])) {
            problems.push(`${section}.${field.key}: default ${JSON.stringify(values[field.key])} is not one of ${allowed.join('/')}`);
          }
        }
      }
    }
    // The reverse direction matters too: a default nobody can edit is dead config.
    for (const section of Object.keys(snapshot)) {
      if (collection[section] === undefined) problems.push(`${section}: has defaults but no metadata`);
    }
    assert.deepEqual(problems, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await check('settings: no field is declared in two sections', async () => {
  // Two declarations of one key render the same control on two different pages, and both
  // edit the same stored value behind the other's back — the display page and the
  // interface page had drifted into exactly that for three toggles. `enabled` is exempt
  // because it is each module's own on/off switch and lives in every section by design.
  const { collection } = await import('../lib/host/settings-meta.js');
  const owner = new Map();
  const shared = [];

  for (const [section, definition] of Object.entries(collection)) {
    for (const field of definition.fields) {
      if (field.key === 'enabled') continue;
      const previous = owner.get(field.key);
      if (previous !== undefined) shared.push(`${field.key} in "${previous}" and "${section}"`);
      else owner.set(field.key, section);
    }
  }

  assert.deepEqual(shared, []);
});

// ── retry ledger ───────────────────────────────────────────────────────────
await check('retry: the ledger records outcomes and stays bounded', async () => {
  const { RetryLedger, previewBackoff } = await import('../lib/host/retry/engine.js');
  const ledger = new RetryLedger(20);
  ledger.record({ kind: 'rate-limit', outcome: 'retrying' });
  ledger.record({ kind: 'rate-limit', outcome: 'succeeded' });
  ledger.record({ kind: 'timeout', outcome: 'exhausted' });
  ledger.record({ kind: 'auth', outcome: 'stopped' });

  const totals = ledger.totals();
  assert.equal(totals.retries, 1);
  assert.equal(totals.recovered, 1);
  assert.equal(totals.exhausted, 1);
  assert.equal(totals.stopped, 1);

  const stats = ledger.stats();
  assert.equal(stats[0].kind, 'rate-limit', 'busiest kind sorts first');
  assert.equal(stats[0].attempts, 2);

  // The ledger must not grow without bound during a retry storm.
  for (let i = 0; i < 100; i += 1) ledger.record({ kind: 'network', outcome: 'retrying' });
  assert.equal(ledger.recent(1000).length, 20);

  const preview = previewBackoff({ attempts: 4 });
  assert.deepEqual(preview, [1000, 2000, 4000, 8000]);
  assert.ok(previewBackoff({ attempts: 20, maxDelayMs: 30_000 }).every((delay) => delay <= 30_000));
});

await check('util: stale atomic-write temp files are swept, fresh ones survive', async () => {
  const { sweepTempFiles } = await import('../lib/host/util.js');
  const { utimes } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'mydsh-sweep-'));

  // A file killed mid-write: old timestamp, full-size body.
  const stale = join(dir, 'usage-index.json.123.456.tmp');
  await writeFile(stale, 'x'.repeat(1024));
  const old = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(stale, old, old);

  // A write happening right now must never be removed.
  const fresh = join(dir, 'usage-index.json.789.101.tmp');
  await writeFile(fresh, 'in flight');

  // An unrelated file that merely ends in .tmp should not match the prefix.
  const unrelated = join(dir, 'other-file.tmp');
  await writeFile(unrelated, 'keep me');
  await utimes(unrelated, old, old);

  const removed = await sweepTempFiles(dir, { prefix: 'usage-index.json' });
  assert.equal(removed, 1, 'only the stale, prefixed temp file is removed');

  const remaining = (await readdir(dir)).sort();
  assert.deepEqual(remaining, ['other-file.tmp', 'usage-index.json.789.101.tmp']);

  // The real file must be untouched by the sweep.
  assert.equal(await readFile(fresh, 'utf8'), 'in flight');

  await rm(dir, { recursive: true, force: true });
});

await check('util: a missing directory does not make the sweep throw', async () => {
  const { sweepTempFiles } = await import('../lib/host/util.js');
  const missing = join(tmpdir(), `mydsh-absent-${Date.now()}`, 'nested');
  assert.equal(await sweepTempFiles(missing), 0);
});

// ── report ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : `\n        ${result.error}`}`);
}
console.log(`\nhost smoke: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
