/**
 * Live acceptance test against the running DSH GUI.
 *
 * Every other suite runs against a simulation. This one talks to the real Host on
 * the real profile, which is the only way to prove the plugin actually loaded,
 * the services resolved, and the routes answer over HTTP.
 */
const BASE = 'http://127.0.0.1:59382/mydsh/api';

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error) });
  }
};

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:59382' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json().catch(() => undefined);
  return { status: response.status, payload, data: payload?.data };
}

await check('live: health reports the plugin and its services', async () => {
  const { status, data } = await api('/system/health');
  if (status !== 200) throw new Error(`status ${status}`);
  if (data.plugin !== 'dsh-mydsh') throw new Error(`unexpected plugin ${data.plugin}`);
  // The GUI profile should resolve nearly everything.
  const unresolved = Object.entries(data.services).filter(([, ok]) => ok !== true).map(([name]) => name);
  if (unresolved.length > 3) throw new Error(`too many unresolved services: ${unresolved.join(', ')}`);
});

await check('live: settings round-trip a write and keep siblings', async () => {
  const before = await api('/settings');
  if (before.status !== 200) throw new Error(`read failed: ${before.status}`);

  const original = before.data.settings.interface.hideBrandName;
  const written = await api('/settings', {
    method: 'POST',
    body: { section: 'interface', patch: { hideBrandName: !original } },
  });
  if (written.status !== 200) throw new Error(`write failed: ${written.status} ${JSON.stringify(written.payload)}`);
  if (written.data.value.hideBrandName !== !original) throw new Error('write did not stick');
  if (written.data.value.enabled !== before.data.settings.interface.enabled) {
    throw new Error('a partial patch clobbered a sibling field');
  }

  // Restore, so the test leaves the profile as it found it.
  await api('/settings', { method: 'POST', body: { section: 'interface', patch: { hideBrandName: original } } });
});

await check('live: usage answers with a real aggregate', async () => {
  // Enable usage first: it ships off by default.
  await api('/settings', { method: 'POST', body: { section: 'usage', patch: { enabled: true } } });
  const { status, data } = await api('/usage?range=30d');
  if (status !== 200) throw new Error(`status ${status}`);
  if (data.disabled === true) throw new Error('usage reports disabled right after enabling it');
  if (typeof data.totals?.total !== 'number') throw new Error('no numeric total');
  if (!Array.isArray(data.groups)) throw new Error('groups must be an array');
  await api('/settings', { method: 'POST', body: { section: 'usage', patch: { enabled: false } } });
});

await check('live: usage aggregates real session logs', async () => {
  await api('/settings', { method: 'POST', body: { section: 'usage', patch: { enabled: true } } });
  try {
    const { data } = await api('/usage?range=90d&dimension=model');
    // This profile has real history, so a zero total means the reader is broken.
    if (data.totals.total === 0) throw new Error('no tokens found across 90 days of real sessions');
    if (data.groups.length === 0) throw new Error('no model groups despite non-zero tokens');
  } finally {
    await api('/settings', { method: 'POST', body: { section: 'usage', patch: { enabled: false } } });
  }
});

await check('live: balance reads the DeepSeek account', async () => {
  const { status, data } = await api('/usage/balance');
  if (status !== 200) throw new Error(`status ${status}`);
  // If credential is present the call should succeed and return wallets.
  if (data.available === true && !Array.isArray(data.wallets)) throw new Error('available but no wallets array');
});

await check('live: the retry classifier works over HTTP', async () => {
  for (const [input, expected] of [
    [{ status: 429, message: 'rate limit' }, 'rate-limit'],
    [{ status: 503, message: 'overloaded' }, 'overloaded'],
    [{ code: 'ETIMEDOUT' }, 'timeout'],
    [{ status: 401, message: 'unauthorized' }, 'auth'],
  ]) {
    const { data } = await api('/retry/test', { method: 'POST', body: input });
    if (data.kind !== expected) throw new Error(`${JSON.stringify(input)} classified as ${data.kind}, expected ${expected}`);
  }
});

await check('live: backup reports its configuration and stages', async () => {
  const { status, data } = await api('/backup');
  if (status !== 200) throw new Error(`status ${status}`);
  if (data.busy !== false) throw new Error('reports busy with no run in flight');
  if (!data.stages.includes('upload')) throw new Error('stage list is incomplete');
});

await check('live: a backup actually runs against real files', async () => {
  // Turn on the two smallest sources and point them at a temp folder.
  const target = 'C:\\Data\\DSH\\myDSH\\APP\\tmp\\live-backup-check';
  await api('/settings', {
    method: 'POST',
    body: {
      section: 'backup',
      patch: {
        enabled: true,
        items: { workspaces: false, conversations: false, systemConfig: true, plugins: false, extras: false, models: true },
        destinations: [{ kind: 'local', directory: target, keepCopies: 2, enabled: true }],
        archive: { format: 'zip', level: 4, splitSizeMb: 0, encrypt: false, incremental: false },
      },
    },
  });

  try {
    const run = await api('/backup/run', { method: 'POST', body: {} });
    if (run.status !== 200) throw new Error(`run rejected: ${run.status} ${JSON.stringify(run.payload)}`);
    const record = run.data.record ?? run.data;
    if (record.ok !== true) throw new Error(`run failed: ${record.error ?? JSON.stringify(record)}`);
    if (!(record.bytes > 0)) throw new Error('archive reports zero bytes');
  } finally {
    await api('/settings', { method: 'POST', body: { section: 'backup', patch: { enabled: false } } });
  }
});

await check('live: 7z is available through the bundled binary', async () => {
  const target = 'C:\\Data\\DSH\\myDSH\\APP\\tmp\\live-backup-7z';
  await api('/settings', {
    method: 'POST',
    body: {
      section: 'backup',
      patch: {
        enabled: true,
        items: { systemConfig: true },
        destinations: [{ kind: 'local', directory: target, keepCopies: 2, enabled: true }],
        archive: { format: '7z', level: 3, splitSizeMb: 0, encrypt: false, incremental: false },
      },
    },
  });

  try {
    const run = await api('/backup/run', { method: 'POST', body: {} });
    const record = run.data.record ?? run.data;
    if (record.ok !== true) throw new Error(`7z run failed: ${record.error ?? JSON.stringify(record)}`);
  } finally {
    await api('/settings', { method: 'POST', body: { section: 'backup', patch: { enabled: false } } });
  }
});

await check('live: prompt customization reports its state', async () => {
  const { status, data } = await api('/prompt');
  if (status !== 200) throw new Error(`status ${status}`);
  if (typeof data.config?.prefix !== 'string') throw new Error('no prefix field');
});

await check('live: remote access reports off and its local origin', async () => {
  const { status, data } = await api('/remote');
  if (status !== 200) throw new Error(`status ${status}`);
  if (data.status.state !== 'off') throw new Error(`unexpected state ${data.status.state}`);
  if (typeof data.origin !== 'string' || !data.origin.startsWith('http')) {
    throw new Error(`no usable origin: ${data.origin}`);
  }
});

await check('live: toolbox inventories real MCP servers and plugins', async () => {
  const mcp = await api('/toolbox/mcp');
  if (mcp.status !== 200) throw new Error(`mcp status ${mcp.status}`);
  const plugins = await api('/toolbox/plugins');
  if (plugins.status !== 200) throw new Error(`plugins status ${plugins.status}`);
  // This profile has plugins installed, so the inventory must not be empty.
  if (plugins.data.available === true && Array.isArray(plugins.data.items) && plugins.data.items.length === 0) {
    throw new Error('plugin inventory returned nothing despite installed bundles');
  }
});

await check('live: a cross-origin write is refused by the live server', async () => {
  const response = await fetch(`${BASE}/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
    body: JSON.stringify({ section: 'interface', patch: {} }),
  });
  if (response.status !== 403) throw new Error(`expected 403, got ${response.status}`);
});

await check('live: an unknown route answers 404 as JSON', async () => {
  const { status, payload } = await api('/definitely-not-a-route');
  if (status !== 404) throw new Error(`expected 404, got ${status}`);
  if (payload?.ok !== false) throw new Error('404 body is not a structured failure');
});

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : `\n        ${result.error}`}`);
}
console.log(`\nlive acceptance: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
