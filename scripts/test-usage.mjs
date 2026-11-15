/**
 * Usage index tests.
 *
 * The index exists to avoid rescanning a large corpus, and the failure it guards
 * against is subtle: it still returns exactly the right numbers. So these tests
 * assert both the totals and the work performed, using a fake session service that
 * counts reads.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, utimes, readFile } from 'node:fs/promises';
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

const { UsageStore, recordsFromLog, aggregate, resolveRange } = await import('../lib/host/usage/store.js');

/** Build a fake DSH home with N session logs on disk. */
async function makeHome(sessions) {
  const root = await mkdtemp(join(tmpdir(), 'mydsh-usage-'));
  const home = join(root, '.dsh');
  for (const [index, tokens] of sessions.entries()) {
    const id = `session-${index}`;
    const dir = join(home, 'sessions', '--demo--', id);
    await mkdir(dir, { recursive: true });
    const log = join(dir, 'session.v4.jsonl.zstd');
    await writeFile(log, 'placeholder', 'utf8');
    // A distinct mtime per file, so one file's change is detectable.
    const when = new Date(Date.now() - (sessions.length - index) * 60_000);
    await utimes(log, when, when);
  }
  return { root, home };
}

/** A session service that counts how many full reads it serves. */
function fakeQuery(logs) {
  const counts = { readSession: 0 };
  return {
    counts,
    async readSession(id) {
      counts.readSession += 1;
      return logs[id] ?? { session: { id, cwd: '/demo' }, events: [] };
    },
  };
}

function usageLog(id, { input = 100, output = 50, time = Date.now(), model = 'deepseek-chat', provider = 'deepseek', cwd = '/demo' } = {}) {
  return {
    session: { id, cwd },
    events: [
      { type: 'assistant/message', seq: 1, time, data: { usage: { inputTokens: input, outputTokens: output }, message: { source: { provider, model } } } },
    ],
  };
}

await check('usage: an empty corpus yields a valid empty aggregate', async () => {
  const { root, home } = await makeHome([]);
  try {
    const query = fakeQuery({});
    const store = new UsageStore({ sessionQuery: query, dshHome: home, logger: () => {} });
    const records = await store.load();
    assert.equal(records.length, 0);

    const range = resolveRange({ kind: '7d' });
    const totals = aggregate(records, range);
    assert.equal(totals.totals.total, 0);
    assert.equal(totals.groups.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await check('usage: the first refresh reads every session exactly once', async () => {
  const { root, home } = await makeHome([1, 2, 3]);
  try {
    const query = fakeQuery({
      'session-0': usageLog('session-0', { input: 100, output: 50 }),
      'session-1': usageLog('session-1', { input: 200, output: 100 }),
      'session-2': usageLog('session-2', { input: 300, output: 150 }),
    });
    const store = new UsageStore({ sessionQuery: query, dshHome: home, logger: () => {} });

    const records = await store.load();
    assert.equal(records.length, 3);
    assert.equal(query.counts.readSession, 3, 'each session read once');
    assert.equal(store.stats.reads, 3);
    assert.equal(store.stats.reused, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await check('usage: a refresh with no changes reads nothing', async () => {
  const { root, home } = await makeHome([1, 2, 3]);
  try {
    const query = fakeQuery({
      'session-0': usageLog('session-0'),
      'session-1': usageLog('session-1'),
      'session-2': usageLog('session-2'),
    });
    const store = new UsageStore({ sessionQuery: query, dshHome: home, logger: () => {} });
    await store.load();
    assert.equal(query.counts.readSession, 3);

    // Second load must not re-read: this is the whole point of the index.
    const again = await store.load();
    assert.equal(again.length, 3);
    assert.equal(query.counts.readSession, 3, 'an unchanged corpus must not be reread');
    assert.equal(store.stats.reused, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await check('usage: only a changed session is re-read', async () => {
  const { root, home } = await makeHome([1, 2, 3]);
  try {
    const logs = {
      'session-0': usageLog('session-0'),
      'session-1': usageLog('session-1'),
      'session-2': usageLog('session-2'),
    };
    const query = fakeQuery(logs);
    const store = new UsageStore({ sessionQuery: query, dshHome: home, logger: () => {} });
    await store.load();
    assert.equal(query.counts.readSession, 3);

    // Grow exactly one session, then move its mtime so the change is visible.
    logs['session-1'] = usageLog('session-1', { input: 999, output: 999 });
    const changed = join(home, 'sessions', '--demo--', 'session-1', 'session.v4.jsonl.zstd');
    const future = new Date(Date.now() + 60_000);
    await utimes(changed, future, future);

    const records = await store.load();
    assert.equal(query.counts.readSession, 4, 'exactly one session re-read');
    assert.equal(store.stats.reused, 2);

    const total = records.reduce((sum, record) => sum + record.total, 0);
    assert.equal(total, 150 + 1998 + 150, 'totals reflect the changed session only');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await check('usage: the persisted index survives a JSON round trip exactly', async () => {
  const { root, home } = await makeHome([1, 2, 3]);
  try {
    const query = fakeQuery({
      'session-0': usageLog('session-0'),
      'session-1': usageLog('session-1'),
      'session-2': usageLog('session-2'),
    });
    const first = new UsageStore({ sessionQuery: query, dshHome: home, logger: () => {} });
    await first.load();
    assert.equal(query.counts.readSession, 3);

    // `stat().mtimeMs` carries sub-millisecond digits that JSON cannot round-trip.
    // Persisting the raw float makes every session look changed on restart and
    // re-reads the whole corpus, so identities must be whole milliseconds.
    const raw = await readFile(join(home, 'mydsh', 'usage-index.json'), 'utf8');
    const stored = JSON.parse(raw);
    for (const [id, entry] of Object.entries(stored.sessions)) {
      assert.equal(
        entry.mtimeMs,
        Math.trunc(entry.mtimeMs),
        `${id}: a fractional mtime will never compare equal after reload`,
      );
    }

    const second = new UsageStore({ sessionQuery: query, dshHome: home, logger: () => {} });
    await second.load();
    assert.equal(query.counts.readSession, 3, 'a restart must not re-read any log');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await check('usage: the index survives a restart without re-reading', async () => {
  const { root, home } = await makeHome([1, 2]);
  try {
    const query = fakeQuery({
      'session-0': usageLog('session-0', { input: 100, output: 50 }),
      'session-1': usageLog('session-1', { input: 200, output: 100 }),
    });
    const first = new UsageStore({ sessionQuery: query, dshHome: home, logger: () => {} });
    await first.load();
    assert.equal(query.counts.readSession, 2);

    // A fresh store simulates a Host restart: it must load the persisted index.
    const second = new UsageStore({ sessionQuery: query, dshHome: home, logger: () => {} });
    const records = await second.load();
    assert.equal(query.counts.readSession, 2, 'a restart must reuse the persisted index');
    assert.equal(records.length, 2);
    assert.equal(records.reduce((sum, record) => sum + record.total, 0), 450);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await check('usage: a vanished session drops out of the ledger', async () => {
  const { root, home } = await makeHome([1, 2]);
  try {
    const query = fakeQuery({
      'session-0': usageLog('session-0'),
      'session-1': usageLog('session-1'),
    });
    const store = new UsageStore({ sessionQuery: query, dshHome: home, logger: () => {} });
    assert.equal((await store.load()).length, 2);

    await rm(join(home, 'sessions', '--demo--', 'session-1'), { recursive: true, force: true });
    const records = await store.load();
    assert.equal(records.length, 1, 'a deleted session must not linger');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await check('usage: one unreadable session does not erase the aggregate', async () => {
  const { root, home } = await makeHome([1, 2]);
  try {
    const query = {
      counts: { readSession: 0 },
      async readSession(id) {
        this.counts.readSession += 1;
        if (id === 'session-1') throw new Error('corrupt log');
        return usageLog(id, { input: 100, output: 50 });
      },
    };
    const store = new UsageStore({ sessionQuery: query, dshHome: home, logger: () => {} });
    const records = await store.load();
    assert.equal(records.length, 1, 'the readable session still counts');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await check('usage: recordsFromLog ignores events without usage', async () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: {} },
    { type: 'assistant/message', seq: 1, time: 2, data: { usage: { inputTokens: 10, outputTokens: 5 }, message: {} } },
    { type: 'assistant/message', seq: 2, time: 3, data: { message: {} } },
    { type: 'assistant/message', seq: 3, time: 4, data: { usage: { inputTokens: 0, outputTokens: 0 }, message: {} } },
    { type: 'tool/result', seq: 4, time: 5, data: {} },
  ];
  const records = recordsFromLog('s', events, { workspace: '/w' });
  assert.equal(records.length, 1);
  assert.equal(records[0].input, 10);
  assert.equal(records[0].workspace, '/w');
  assert.equal(records[0].provider, 'unknown', 'a missing source is labelled, not dropped');
});

await check('usage: an unreadable session is not retried on every refresh', async () => {
  const { root, home } = await makeHome([1, 2]);
  try {
    const query = {
      counts: { readSession: 0 },
      async readSession(id) {
        this.counts.readSession += 1;
        // A corpus can contain logs this profile cannot resolve. Retrying them on
        // every refresh is what made usage requests take seconds.
        if (id === 'session-1') throw new Error('not found');
        return usageLog(id, { input: 100, output: 50 });
      },
    };
    const store = new UsageStore({ sessionQuery: query, dshHome: home, logger: () => {} });

    await store.load();
    const afterFirst = query.counts.readSession;
    assert.equal(afterFirst, 2, 'the first refresh tries every session');

    await store.load();
    assert.equal(query.counts.readSession, afterFirst, 'a rejected log must not be retried');
    assert.equal(store.stats.skipped, 1, 'the rejection is reported, not hidden');

    // A restart must not retry it either, or the saving only lasts until reboot.
    const restarted = new UsageStore({ sessionQuery: query, dshHome: home, logger: () => {} });
    await restarted.load();
    assert.equal(query.counts.readSession, afterFirst, 'the rejection survives a restart');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await check('usage: a rejected session is retried once its log changes', async () => {
  const { root, home } = await makeHome([1]);
  try {
    let refuse = true;
    const query = {
      counts: { readSession: 0 },
      async readSession(id) {
        this.counts.readSession += 1;
        if (refuse) throw new Error('not found');
        return usageLog(id, { input: 100, output: 50 });
      },
    };
    const store = new UsageStore({ sessionQuery: query, dshHome: home, logger: () => {} });
    assert.equal((await store.load()).length, 0);

    // A new write to the same log must get another chance, otherwise a repaired or
    // newly-imported session would stay invisible forever.
    refuse = false;
    const logPath = join(home, 'sessions', '--demo--', 'session-0', 'session.v4.jsonl.zstd');
    const future = new Date(Date.now() + 60_000);
    await utimes(logPath, future, future);

    const records = await store.load();
    assert.equal(records.length, 1, 'a changed log is read again');
    assert.equal(store.stats.skipped, 0, 'the rejection is cleared once the read succeeds');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : `\n        ${result.error}`}`);
}
console.log(`\nusage index: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
