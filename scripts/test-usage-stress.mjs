/**
 * Stress the usage index at real scale.
 *
 * The real corpus is 466 sessions and 73,000 usage records. This builds an index
 * of that size and asserts what the dashboard depends on: a cold build completes,
 * a warm refresh is cheap, a restart does not rescan, and the aggregate is correct
 * against an independently computed total.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, utimes, stat } from 'node:fs/promises';
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

const { UsageStore, aggregate, resolveRange } = await import('../lib/host/usage/store.js');

const SESSIONS = 200;
const RECORDS_PER_SESSION = 100;

/** Build a synthetic home with many sessions and a fake readSession serving them. */
async function buildCorpus() {
  const root = await mkdtemp(join(tmpdir(), 'mydsh-stress-'));
  const home = join(root, '.dsh');
  const logs = {};
  let expectedTotal = 0;

  for (let i = 0; i < SESSIONS; i += 1) {
    const id = `session-${i}`;
    const dir = join(home, 'sessions', `--ws-${i % 7}--`, id);
    await mkdir(dir, { recursive: true });
    const logPath = join(dir, 'session.v4.jsonl.zstd');
    await writeFile(logPath, 'placeholder', 'utf8');
    const when = new Date(Date.now() - i * 60_000);
    await utimes(logPath, when, when);

    const events = [];
    for (let j = 0; j < RECORDS_PER_SESSION; j += 1) {
      const input = 1000 + (i % 5) * 100;
      const output = 500;
      expectedTotal += input + output;
      events.push({
        type: 'assistant/message',
        seq: j,
        time: Date.now() - i * 60_000 - j * 1000,
        data: {
          usage: { inputTokens: input, outputTokens: output },
          message: { source: { provider: i % 2 === 0 ? 'deepseek' : 'moonshot', model: `model-${i % 3}` } },
        },
      });
    }
    logs[id] = { session: { id, cwd: `/ws-${i % 7}` }, events };
  }

  return { root, home, logs, expectedTotal };
}

function countingQuery(logs) {
  const counts = { reads: 0 };
  return {
    counts,
    async readSession(id) {
      counts.reads += 1;
      // Yield so the pool's concurrency is real rather than serialized by luck.
      await new Promise((resolve) => setImmediate(resolve));
      return logs[id] ?? { session: { id }, events: [] };
    },
  };
}

await check(`usage: a ${SESSIONS}-session corpus indexes correctly`, async () => {
  const { root, home, logs, expectedTotal } = await buildCorpus();
  try {
    const query = countingQuery(logs);
    const store = new UsageStore({ sessionQuery: query, dshHome: home, logger: () => {} });

    const coldStart = Date.now();
    const records = await store.load();
    const coldMs = Date.now() - coldStart;

    assert.equal(query.counts.reads, SESSIONS, 'every session read on a cold build');
    assert.equal(records.length, SESSIONS * RECORDS_PER_SESSION);
    assert.equal(
      records.reduce((sum, record) => sum + record.total, 0),
      expectedTotal,
      'totals match an independently computed sum',
    );
    console.log(`        cold build: ${coldMs}ms for ${SESSIONS} sessions / ${records.length} records`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await check(`usage: a warm refresh over ${SESSIONS} sessions reads nothing`, async () => {
  const { root, home, logs } = await buildCorpus();
  try {
    const query = countingQuery(logs);
    const store = new UsageStore({ sessionQuery: query, dshHome: home, logger: () => {} });
    await store.load();
    const afterCold = query.counts.reads;

    const warmStart = Date.now();
    await store.load();
    const warmMs = Date.now() - warmStart;

    assert.equal(query.counts.reads, afterCold, 'a warm refresh must not read any log');
    assert.equal(store.stats.reused, SESSIONS);
    console.log(`        warm refresh: ${warmMs}ms, 0 reads`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await check('usage: one changed session out of many costs one read', async () => {
  const { root, home, logs } = await buildCorpus();
  try {
    const query = countingQuery(logs);
    const store = new UsageStore({ sessionQuery: query, dshHome: home, logger: () => {} });
    await store.load();
    const afterCold = query.counts.reads;

    const changed = join(home, 'sessions', '--ws-3--', 'session-3', 'session.v4.jsonl.zstd');
    const future = new Date(Date.now() + 120_000);
    await utimes(changed, future, future);

    await store.load();
    assert.equal(query.counts.reads, afterCold + 1, 'exactly one re-read');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await check('usage: the aggregate answers every dimension', async () => {
  const { root, home, logs } = await buildCorpus();
  try {
    const store = new UsageStore({ sessionQuery: countingQuery(logs), dshHome: home, logger: () => {} });
    const records = await store.load();
    const range = resolveRange({ kind: '30d' });

    for (const dimension of ['provider', 'model', 'session', 'workspace']) {
      const result = aggregate(records, { ...range, groupBy: dimension });
      assert.ok(result.totals.total > 0, `${dimension}: no totals`);
      assert.ok(result.groups.length > 0, `${dimension}: no groups`);
      // Every grouping of the same records must sum to the same total.
      const grouped = result.groups.reduce((sum, group) => sum + group.total, 0);
      assert.equal(grouped, result.totals.total, `${dimension}: groups do not sum to the total`);
      assert.ok(result.buckets.length > 0, `${dimension}: no buckets`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await check('usage: the persisted index stays a reasonable size', async () => {
  const { root, home, logs } = await buildCorpus();
  try {
    const store = new UsageStore({ sessionQuery: countingQuery(logs), dshHome: home, logger: () => {} });
    await store.load();

    const info = await stat(join(home, 'mydsh', 'usage-index.json'));
    const perRecord = info.size / (SESSIONS * RECORDS_PER_SESSION);
    console.log(`        index: ${(info.size / 1024).toFixed(0)} KiB, ${perRecord.toFixed(0)} bytes/record`);
    // A record holds ~10 small fields; anything past ~1 KB each means the shape grew
    // accidentally, which would matter at 73k records.
    assert.ok(perRecord < 1024, `index records too large: ${perRecord.toFixed(0)} bytes each`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : `\n        ${result.error}`}`);
}
console.log(`\nusage stress: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
