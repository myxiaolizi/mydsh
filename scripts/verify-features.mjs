/**
 * Exercise every feature the plugin claims, against the live Host.
 *
 * The requirement was "integrate everything in the plugin and verify every capability works".
 * A unit suite proves the code's shape; this proves the running Host actually answers. Each
 * check below calls the real endpoint and asserts the real payload, so a route that answers
 * `{disabled: true}` for the wrong reason fails here even though every unit test passes.
 *
 * Run: node verify-features.mjs http://127.0.0.1:<port>
 *
 * Every module is switched on for its own block and restored afterwards, so the check is
 * order-independent and leaves the profile as it found it.
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:50065';
const API = `${BASE}/mydsh/api`;

let pass = 0;
let fail = 0;
const results = [];

const get = async (path) => {
  const response = await fetch(API + path);
  const json = await response.json().catch(() => ({}));
  return { status: response.status, data: json.data, ok: json.ok };
};

const post = async (path, body) => {
  const response = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, data: json.data, ok: json.ok, error: json.error };
};

const setSection = async (section, patch) => {
  const result = await post('/settings', { section, patch });
  if (result.ok !== true) throw new Error(`cannot patch ${section}: ${JSON.stringify(result.error)}`);
  return result.data.value ?? result.data;
};

const check = async (name, fn) => {
  const started = Date.now();
  try {
    const detail = await fn();
    pass += 1;
    results.push({ name, ok: true, ms: Date.now() - started, detail });
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`);
  } catch (error) {
    fail += 1;
    results.push({ name, ok: false, ms: Date.now() - started, detail: error.message });
    console.log(`FAIL  ${name}\n        ${error.message}`);
  }
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** Read one section's stored state so the run can put it back. */
const snapshot = {};
for (const section of ['display', 'interface', 'usage', 'toolbox', 'backup', 'retry', 'prompt', 'remote', 'budget']) {
  const settings = await get('/settings');
  snapshot[section] = settings.data?.settings?.[section];
}

console.log(`\n── system ──`);
await check('health reports the plugin and its posture', async () => {
  const { data } = await get('/system/health');
  assert(data?.plugin === 'dsh-mydsh', 'plugin name missing');
  assert(typeof data.version === 'string', 'version missing');
  assert(data.posture !== undefined, 'posture missing');
  assert(typeof data.posture.unreachable === 'boolean', 'posture.unreachable missing');
  return `v${data.version}, entry=${data.posture.entry}, unreachable=${data.posture.unreachable}`;
});

console.log(`\n── display / interface ──`);
await check('every display placement round-trips', async () => {
  const seen = [];
  for (const value of ['sidebar', 'settings', 'titlebar', 'hidden']) {
    const stored = await setSection('display', { entry: value });
    assert(stored.entry === value, `entry ${value} did not stick (got ${stored.entry})`);
    seen.push(value);
  }
  await setSection('display', { entry: snapshot.display?.entry ?? 'sidebar' });
  return seen.join(' → ');
});

await check('every usage placement round-trips', async () => {
  const seen = [];
  for (const value of ['sidebar', 'panel', 'titlebar', 'off']) {
    const stored = await setSection('display', { usagePlacement: value });
    assert(stored.usagePlacement === value, `usagePlacement ${value} did not stick`);
    seen.push(value);
  }
  await setSection('display', { usagePlacement: snapshot.display?.usagePlacement ?? 'sidebar' });
  return seen.join(' → ');
});

await check('appearance switches persist independently', async () => {
  const on = await setSection('display', { hideNewSessionButton: true, compactSidebar: true });
  assert(on.hideNewSessionButton === true && on.compactSidebar === true, 'switches did not store');
  const off = await setSection('display', { hideNewSessionButton: false, compactSidebar: false });
  assert(off.hideNewSessionButton === false && off.compactSidebar === false, 'switches did not clear');
  return 'set, cleared';
});

console.log(`\n── usage and billing ──`);
await check('the usage aggregate returns every figure the panel draws', async () => {
  await setSection('usage', { enabled: true });
  const { data } = await get('/usage?range=all&groupBy=provider');
  assert(data?.disabled !== true, 'usage reported itself disabled');
  for (const field of ['input', 'output', 'total', 'cacheRead', 'cacheWrite', 'calls', 'cost']) {
    assert(typeof data.totals?.[field] === 'number', `totals.${field} missing`);
  }
  assert(Array.isArray(data.groups), 'groups missing');
  assert(Array.isArray(data.buckets) && data.buckets.length > 0, 'buckets missing');
  return `${data.totals.total} tokens / ¥${data.totals.cost.toFixed(2)} / ${data.groups.length} groups`;
});

await check('the session ranking answers with titles', async () => {
  // Titles are read out of the session logs in the background, so the first request after the
  // cache is cold legitimately answers with bare ids. Waiting is the correct behaviour; a
  // verifier that fails here would report a correct cold start as a defect.
  let data;
  let titled = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    ({ data } = await get('/usage/sessions?limit=20'));
    titled = (data?.rows ?? []).filter((row) => typeof row.title === 'string' && row.title !== '').length;
    if (titled > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  assert(Array.isArray(data?.rows), 'rows missing');
  assert(data.rows.length > 0, 'no session rows');
  assert(titled > 0, 'no row carried a title even after warming');
  return `${data.rows.length} rows, ${titled} titled`;
});

await check('context insight answers for a real session', async () => {
  const sessions = await get('/usage/sessions?limit=1');
  const sessionId = sessions.data?.rows?.[0]?.sessionId;
  assert(typeof sessionId === 'string', 'no session to inspect');
  const { data } = await get(`/usage/context?sessionId=${encodeURIComponent(sessionId)}`);
  assert(data?.available !== false, 'context unavailable');
  assert(typeof data.promptTokens === 'number', 'promptTokens missing');
  assert(Array.isArray(data.points) && data.points.length > 0, 'trend points missing');
  return `${data.promptTokens} / ${data.contextWindow} (${(data.ratio * 100).toFixed(1)}%), ${data.points.length} points`;
});

await check('the price table is served', async () => {
  const { data } = await get('/usage/prices');
  assert(data !== undefined, 'no payload');
  assert(data.priced !== false, 'prices reported as unpriced');
  return 'priced=true';
});

await check('the balance endpoint answers (even when unconfigured)', async () => {
  const { data, status } = await get('/usage/balance');
  assert(status === 200, `status ${status}`);
  assert(data !== undefined, 'no payload');
  return data.available === false ? 'not configured (reported)' : 'configured';
});

console.log(`\n── backup ──`);
await check('backup reports stages and refuses nothing while on', async () => {
  await setSection('backup', { enabled: true });
  const { data } = await get('/backup');
  assert(data?.disabled !== true, 'backup reported itself disabled');
  assert(Array.isArray(data.stages), 'stages missing');
  assert(data.config !== undefined, 'config missing');
  await setSection('backup', { enabled: snapshot.backup?.enabled ?? false });
  return `${data.stages.length} stages, ${data.history?.length ?? 0} runs`;
});

console.log(`\n── retry ──`);
await check('retry exposes classification, ledger, and continuation', async () => {
  await setSection('retry', { enabled: true });
  const { data } = await get('/retry');
  assert(data?.disabled !== true, 'retry reported itself disabled');
  assert(Array.isArray(data.kinds) && data.kinds.length > 0, 'error kinds missing');
  assert(data.stats !== undefined, 'ledger stats missing');
  assert(data.continuation !== undefined, 'continuation state missing');
  const classified = await post('/retry/test', { message: '429 Too Many Requests', status: 429 });
  assert(typeof classified.data?.kind === 'string' && classified.data.kind !== '', 'classifier returned no kind');
  await setSection('retry', { enabled: snapshot.retry?.enabled ?? false });
  return `${data.kinds.length} kinds; 429 → ${classified.data.kind}`;
});

console.log(`\n── prompt ──`);
await check('the prompt prefix/suffix round-trips', async () => {
  await setSection('prompt', { enabled: true });
  const before = await get('/prompt');
  assert(before.data?.disabled !== true, 'prompt reported itself disabled');
  const patched = await setSection('prompt', { prefix: 'TEST-PREFIX', suffix: 'TEST-SUFFIX' });
  assert(patched.prefix === 'TEST-PREFIX', 'prefix did not store');
  assert(patched.suffix === 'TEST-SUFFIX', 'suffix did not store');
  await setSection('prompt', { prefix: snapshot.prompt?.prefix ?? '', suffix: snapshot.prompt?.suffix ?? '' });
  await setSection('prompt', { enabled: snapshot.prompt?.enabled ?? false });
  return 'stored and restored';
});

console.log(`\n── remote ──`);
await check('remote reports its status and refuses a connect without a relay', async () => {
  await setSection('remote', { enabled: true, relayUrl: '' });
  const { data } = await get('/remote');
  assert(data?.disabled !== true, 'remote reported itself disabled');
  assert(data.status !== undefined, 'status missing');
  const connect = await post('/remote/connect', {});
  assert(connect.ok !== true || connect.data?.ok === false, 'connect should fail without a relay URL');
  await setSection('remote', { enabled: snapshot.remote?.enabled ?? false });
  return `state=${data.status?.state ?? 'unknown'}`;
});

console.log(`\n── toolbox ──`);
await check('the toolbox reports which modules this build implements', async () => {
  await setSection('toolbox', { enabled: true });
  const { data } = await get('/toolbox');
  assert(data?.registry !== undefined, 'registry missing');
  assert(Array.isArray(data.available) && data.available.length > 0, 'no available modules');
  for (const [key, entry] of Object.entries(data.registry)) {
    if (entry.available !== true) assert(typeof entry.reason === 'string', `${key} unavailable without a reason`);
  }
  return `${data.available.length} available of ${Object.keys(data.registry).length}; installed: ${(data.installed ?? []).join(', ')}`;
});

await check('memory stores, reads, gates on its switch, and prunes', async () => {
  await setSection('toolbox', { modules: { memory: true } });
  const written = await post('/toolbox/memory', { action: 'add', text: 'verify: 全功能验证', tags: ['verify'] });
  assert(written.data?.ok === true, `write failed: ${JSON.stringify(written.error)}`);

  const read = await get('/toolbox/memory');
  assert(read.data?.available === true, 'memory unavailable while on');
  assert(read.data.notes.length >= 1, 'note not stored');

  // The switch must gate the route, not just the prompt.
  await setSection('toolbox', { modules: { memory: false } });
  const offRead = await get('/toolbox/memory');
  assert(offRead.data?.memoryOff === true, 'read did not report the module as off');
  const offWrite = await post('/toolbox/memory', { action: 'add', text: 'must fail' });
  assert(offWrite.status !== 200, 'write succeeded with the module off');

  await setSection('toolbox', { modules: { memory: true } });
  const removed = await post('/toolbox/memory', { action: 'remove', query: 'verify' });
  assert(removed.data?.removed >= 1, 'cleanup removed nothing');
  const after = await get('/toolbox/memory');
  return `stored, gated, pruned (${after.data.notes.length} left)`;
});

await check('MCP and plugin inventories answer', async () => {
  const mcp = await get('/toolbox/mcp');
  assert(mcp.status === 200, `mcp status ${mcp.status}`);
  assert(mcp.data !== undefined, 'mcp payload missing');
  const plugins = await get('/toolbox/plugins');
  assert(plugins.status === 200, `plugins status ${plugins.status}`);
  assert(plugins.data !== undefined, 'plugins payload missing');
  return `mcp servers: ${mcp.data.servers?.length ?? 0}, plugins: ${plugins.data.plugins?.length ?? 0}`;
});

console.log(`\n── agent family ──`);
await check('the agent family tree answers with a root', async () => {
  const { data } = await get('/agents/tree');
  assert(data !== undefined, 'no payload');
  if (data.available === false) {
    assert(typeof data.reason === 'string', 'unavailable without a reason');
    return `unavailable: ${data.reason}`;
  }
  assert(Array.isArray(data.members), 'members missing');
  assert(data.members.some((member) => member.kind === 'root'), 'no root member');
  return `${data.members.length} members`;
});

console.log(`\n── module gating ──`);
await check('a switched-off module reports itself instead of acting', async () => {
  const gated = [];
  for (const section of ['backup', 'retry', 'remote', 'toolbox']) {
    await setSection(section, { enabled: false });
    const { data } = await get(`/${section}`);
    assert(data?.disabled === true, `${section} did not report itself disabled`);
    gated.push(section);
  }
  const run = await post('/backup/run', {});
  assert(run.status !== 200, 'backup ran while switched off');
  // Restore.
  for (const section of ['backup', 'retry', 'remote', 'toolbox']) {
    await setSection(section, { enabled: snapshot[section]?.enabled ?? false });
  }
  await setSection('toolbox', { modules: snapshot.toolbox?.modules ?? {} });
  return `${gated.join(', ')} all gated; /backup/run refused`;
});

// ── restore every section exactly as it was found ──────────────────────────
for (const [section, values] of Object.entries(snapshot)) {
  if (values !== undefined) await post('/settings', { section, patch: values }).catch(() => {});
}

console.log(`\n${'─'.repeat(56)}`);
console.log(`features: ${pass}/${pass + fail} verified`);
if (fail > 0) {
  console.log('\nfailures:');
  for (const entry of results.filter((r) => !r.ok)) console.log(`  ${entry.name}: ${entry.detail}`);
}
process.exit(fail === 0 ? 0 : 1);
