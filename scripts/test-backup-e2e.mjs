/**
 * End-to-end backup engine test.
 *
 * Exercises the whole pipeline against a synthetic DSH home: real files on disk,
 * the real ZIP writer and the real bundled 7z, a local destination, retention, and
 * the incremental filter. Everything the unit tests stub out is real here.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat, readdir, utimes } from 'node:fs/promises';
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

/** Build a synthetic DSH home with a workspace, a config, and an installed plugin. */
async function makeHome() {
  const root = await mkdtemp(join(tmpdir(), 'mydsh-e2e-'));
  const home = join(root, '.dsh');
  const profile = join(home, 'profiles', 'desktop');

  await mkdir(join(home, 'workspaces', 'demo', 'src'), { recursive: true });
  await writeFile(join(home, 'workspaces', 'demo', 'src', 'index.js'), 'export const x = 1;\n', 'utf8');
  await writeFile(join(home, 'workspaces', 'demo', 'README.md'), '# demo\n', 'utf8');

  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'cordis.patch.yml'), '- insert:\n    - id: demo\n      name: demo\n', 'utf8');
  await writeFile(join(home, 'config.json'), JSON.stringify({ model: 'deepseek-chat' }), 'utf8');

  await mkdir(join(profile, 'node_modules', 'demo-plugin'), { recursive: true });
  await writeFile(
    join(profile, 'node_modules', 'demo-plugin', 'package.json'),
    JSON.stringify({ name: 'demo-plugin', version: '2.1.0' }),
    'utf8',
  );

  return { root, home, profile };
}

/** Build a settings-backed storer the engine can read. */
function settingsStub(config) {
  return { section: async (name) => (name === 'backup' ? config : {}) };
}

await check('e2e: a ZIP backup captures the selected sources and lands in the destination', async () => {
  const { home, profile, root } = await makeHome();
  try {
    const { BackupEngine } = await import('../lib/host/backup/engine.js');
    const { createSources } = await import('../lib/host/backup/sources.js');

    const copies = join(root, 'copies');
    const engine = new BackupEngine({
      settings: settingsStub({
        enabled: true,
        items: { workspaces: true, systemConfig: true, plugins: true },
        destinations: [{ kind: 'local', directory: copies, keepCopies: 3, enabled: true }],
        archive: { format: 'zip', level: 6, splitSizeMb: 0, incremental: false },
        triggers: {},
      }),
      sources: createSources({ dshHome: home, profileName: 'desktop', logger: () => {} }),
      logger: () => () => {},
      secrets: { forDestination: async () => ({}), get: async () => undefined },
      state: {},
    });

    const result = await engine.run({ trigger: 'manual' });
    assert.equal(result.ok, true, `backup failed: ${result.error ?? ''}`);

    const stored = await readdir(copies);
    assert.equal(stored.length, 1, 'one archive must be stored');
    assert.match(stored[0], /\.zip$/);
    assert.ok((await stat(join(copies, stored[0]))).size > 200);

    // The archive must be a real ZIP, checked by its signature.
    const bytes = await readFile(join(copies, stored[0]));
    assert.equal(bytes.readUInt32LE(0), 0x04034b50);

    // And the manifest the engine writes must describe this run.
    const text = bytes.toString('latin1');
    assert.ok(text.includes('manifest.json'), 'manifest entry present');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await check('e2e: a 7z backup is produced by the bundled binary', async () => {
  const { home, root } = await makeHome();
  try {
    const { BackupEngine } = await import('../lib/host/backup/engine.js');
    const { createSources } = await import('../lib/host/backup/sources.js');

    const copies = join(root, 'seven');
    const engine = new BackupEngine({
      settings: settingsStub({
        enabled: true,
        items: { workspaces: true },
        destinations: [{ kind: 'local', directory: copies, keepCopies: 2, enabled: true }],
        archive: { format: '7z', level: 5, splitSizeMb: 0, incremental: false },
        triggers: {},
      }),
      sources: createSources({ dshHome: home, profileName: 'desktop', logger: () => {} }),
      logger: () => () => {},
      secrets: { forDestination: async () => ({}), get: async () => undefined },
      state: {},
    });

    const result = await engine.run({ trigger: 'manual' });
    assert.equal(result.ok, true, `7z backup failed: ${result.error ?? ''}`);

    const stored = await readdir(copies);
    assert.equal(stored.length, 1);
    assert.match(stored[0], /\.7z$/);
    // 7z signature: 37 7A BC AF 27 1C
    const bytes = await readFile(join(copies, stored[0]));
    assert.deepEqual([...bytes.subarray(0, 6)], [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await check('e2e: retention keeps the configured number of copies', async () => {
  const { home, root } = await makeHome();
  try {
    const { BackupEngine } = await import('../lib/host/backup/engine.js');
    const { createSources } = await import('../lib/host/backup/sources.js');

    const copies = join(root, 'retained');
    const config = {
      enabled: true,
      items: { workspaces: true },
      destinations: [{ kind: 'local', directory: copies, keepCopies: 2, enabled: true }],
      archive: { format: 'zip', level: 1, splitSizeMb: 0, incremental: false },
      triggers: {},
    };
    const makeEngine = () => new BackupEngine({
      settings: settingsStub(config),
      sources: createSources({ dshHome: home, profileName: 'desktop', logger: () => {} }),
      logger: () => () => {},
      secrets: { forDestination: async () => ({}), get: async () => undefined },
      state: {},
    });

    // Three sequential runs. Each archive name carries a timestamp to the second,
    // so space them out to avoid a same-name overwrite masking the retention.
    for (let i = 0; i < 3; i += 1) {
      const result = await makeEngine().run({ trigger: 'manual' });
      assert.equal(result.ok, true, `run ${i} failed: ${result.error ?? ''}`);
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }

    const stored = await readdir(copies);
    assert.equal(stored.length, 2, `retention must keep 2 copies, found ${stored.length}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await check('e2e: incremental mode skips when nothing changed', async () => {
  const { home, root } = await makeHome();
  try {
    const { BackupEngine } = await import('../lib/host/backup/engine.js');
    const { createSources } = await import('../lib/host/backup/sources.js');

    const copies = join(root, 'incremental');
    const state = {};
    const config = {
      enabled: true,
      items: { workspaces: true },
      destinations: [{ kind: 'local', directory: copies, keepCopies: 5, enabled: true }],
      archive: { format: 'zip', level: 1, splitSizeMb: 0, incremental: true },
      triggers: {},
    };
    const makeEngine = () => new BackupEngine({
      settings: settingsStub(config),
      sources: createSources({ dshHome: home, profileName: 'desktop', logger: () => {} }),
      logger: () => () => {},
      secrets: { forDestination: async () => ({}), get: async () => undefined },
      state,
    });

    const first = await makeEngine().run({ trigger: 'manual' });
    assert.equal(first.ok, true, `first run failed: ${first.error ?? ''}`);

    const second = await makeEngine().run({ trigger: 'manual' });
    assert.equal(second.ok, true);
    assert.equal(second.skipped, true, 'a second run with no changes must skip');
    assert.equal(second.reason, 'no-changes');

    // Repeat it. A single skip passed even while the behaviour was broken, because the
    // old comparison used the wall-clock start of the run: a file written in the same
    // millisecond as the start compared as "changed" and the run archived everything.
    // That made the failure intermittent, so one skip proves nothing — several in a row
    // do, because a same-millisecond write lands in one of them.
    for (let round = 0; round < 5; round += 1) {
      const repeat = await makeEngine().run({ trigger: 'manual' });
      assert.equal(repeat.skipped, true, `round ${round + 2} of no changes must also skip`);
    }

    // Touching a file must make the next run produce work again.
    const touched = join(home, 'workspaces', 'demo', 'README.md');
    const future = new Date(Date.now() + 60_000);
    await utimes(touched, future, future);
    const third = await makeEngine().run({ trigger: 'manual' });
    assert.equal(third.ok, true, `third run failed: ${third.error ?? ''}`);
    assert.notEqual(third.skipped, true, 'a changed file must produce an archive');

    // And having archived the change, it goes back to skipping rather than archiving
    // the same file forever.
    const settled = await makeEngine().run({ trigger: 'manual' });
    assert.equal(settled.skipped, true, 'after the change is archived, runs skip again');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await check('e2e: a backup with no items selected fails with a clear reason', async () => {
  const { home, root } = await makeHome();
  try {
    const { BackupEngine } = await import('../lib/host/backup/engine.js');
    const { createSources } = await import('../lib/host/backup/sources.js');

    const engine = new BackupEngine({
      settings: settingsStub({
        enabled: true,
        items: { workspaces: false, conversations: false },
        destinations: [{ kind: 'local', directory: join(root, 'x'), enabled: true }],
        archive: { format: 'zip' },
        triggers: {},
      }),
      sources: createSources({ dshHome: home, profileName: 'desktop', logger: () => {} }),
      logger: () => () => {},
      secrets: { forDestination: async () => ({}), get: async () => undefined },
      state: {},
    });

    const result = await engine.run({ trigger: 'manual' });
    assert.equal(result.ok, false);
    assert.match(result.error, /no backup items selected/i);
    // The step log must name where it stopped.
    assert.ok(result.record.steps.some((step) => step.name === 'prepare'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : `\n        ${result.error}`}`);
}
console.log(`\nbackup e2e: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
