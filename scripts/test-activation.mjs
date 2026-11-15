/**
 * Activation test against a simulated Cordis context.
 *
 * The Host half only ever runs inside DSH, so the failures that matter most — a
 * missing service, a throwing listener, a route that never mounts — would otherwise
 * appear only in a user's app. This harness builds a context that behaves like the
 * real one (services, `ctx.on`, `ctx.effect`, `ctx.get`) and proves activation
 * completes and the routes respond.
 *
 * `DSH_HOME` is redirected to an empty temporary directory before any import. The
 * usage store reads that home, so without this the background warmup would walk the
 * machine's real session corpus — minutes of work that also makes the suite depend on
 * whatever the developer happens to have run lately.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isolatedHome = mkdtempSync(join(tmpdir(), 'mydsh-activation-'));
process.env.DSH_HOME = isolatedHome;

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error) });
  }
};

/**
 * Build a context that records what activation does.
 *
 * `webServer.register` is captured rather than performed so the test can call the
 * mounted handler directly, the way the real server would.
 */
function makeContext({ services = {} } = {}) {
  const effects = [];
  const listeners = new Map();
  const routes = [];
  const logs = [];

  const registered = {
    kind: undefined,
    path: undefined,
    handler: undefined,
  };

  const ctx = {
    logger: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
      error: (message) => logs.push({ level: 'error', message }),
    },
    get: (key) => services[key],
    on: (event, handler) => {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => {};
    },
    effect: (fn) => {
      effects.push(fn);
      return () => {};
    },
    fiber: { entry: { id: 'dsh-mydsh' } },
  };

  // The web server service the API mounts onto.
  const webServer = {
    register: (options) => {
      registered.kind = options.kind;
      registered.path = options.path;
      registered.handler = options.handler;
      routes.push(options);
      return () => {};
    },
    getOrigin: () => 'http://127.0.0.1:59382',
    registerUpgrade: () => () => {},
  };

  return {
    ctx: { ...ctx, get: (key) => (key === 'webServer' ? webServer : services[key]) },
    webServer,
    registered,
    listeners,
    effects,
    logs,
  };
}

/**
 * Invoke the mounted API handler for one request.
 *
 * `settleMs` exists because some routes legitimately outlive the request
 * callback: usage refreshes an index, and the response is written when that
 * finishes. A tight timeout would report a false failure.
 */
async function callApi(registered, path, { method = 'GET', body, settleMs = 40 } = {}) {
  const url = new URL(`http://127.0.0.1${path}`);
  const payload = body === undefined ? '' : JSON.stringify(body);

  const request = {
    method,
    url: `${url.pathname}${url.search}`,
    headers: { origin: 'http://127.0.0.1:59382', host: '127.0.0.1:59382' },
    on: (event, handler) => {
      if (event === 'data' && payload !== '') handler(Buffer.from(payload));
      if (event === 'end') setImmediate(handler);
      return request;
    },
    destroy: () => {},
  };

  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader: (name, value) => {
      response.headers[name.toLowerCase()] = value;
    },
    writeHead: (status, headers) => {
      response.statusCode = status;
      Object.assign(response.headers, headers ?? {});
      return response;
    },
    end: (chunk) => {
      if (chunk !== undefined) response.body += String(chunk);
    },
  };

  registered.handler(request, response);
  // Poll for the response instead of sleeping a fixed period, so a fast route
  // returns quickly and a slow one gets the full budget.
  const deadline = Date.now() + 5000;
  while (response.statusCode === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }
  return { status: response.statusCode, headers: response.headers, json: safeJson(response.body) };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ── activation ─────────────────────────────────────────────────────────────

await check('activation: completes with no optional services present', async () => {
  const { apply } = await import('../lib/index.js');
  const { ctx } = makeContext();
  await apply(ctx, {});
  // Nothing thrown is the assertion; the plugin must survive a bare build.
});

await check('activation: mounts the API on a prefix route', async () => {
  const { apply } = await import('../lib/index.js');
  const harness = makeContext();
  await apply(harness.ctx, {});
  assert.equal(harness.registered.kind, 'prefix');
  assert.equal(harness.registered.path, '/mydsh/api');
  assert.equal(typeof harness.registered.handler, 'function');
});

await check('activation: registers a disposer through ctx.effect', async () => {
  const { apply } = await import('../lib/index.js');
  const harness = makeContext();
  await apply(harness.ctx, {});
  assert.ok(harness.effects.length > 0, 'activation must register cleanup effects');
  // Every effect must be callable without throwing.
  for (const effect of harness.effects) {
    const disposer = effect();
    if (typeof disposer === 'function') disposer();
  }
});

await check('activation: subscribes to the model stream when llm is present', async () => {
  const { apply } = await import('../lib/index.js');
  const llm = { listProviders: async () => [{ id: 'deepseek' }] };
  const harness = makeContext({ services: { llm } });
  await apply(harness.ctx, {});
  assert.ok(harness.listeners.has('llm/stream'), 'the retry seam must be registered');
});

await check('activation: does not subscribe to llm/stream without the service', async () => {
  const { apply } = await import('../lib/index.js');
  const harness = makeContext();
  await apply(harness.ctx, {});
  assert.equal(harness.listeners.has('llm/stream'), false);
});

// ── API surface ────────────────────────────────────────────────────────────

await check('api: health reports which services resolved', async () => {
  const { apply } = await import('../lib/index.js');
  const harness = makeContext({ services: { sessionQuery: { listSessions: async () => [] } } });
  await apply(harness.ctx, {});
  const response = await callApi(harness.registered, '/mydsh/api/system/health');
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.data.plugin, 'dsh-mydsh');
  assert.equal(response.json.data.services.sessionQuery, true);
  assert.equal(response.json.data.services.deepseekAccount, false);
});

await check('api: settings returns values, defaults, and field metadata', async () => {
  const { apply } = await import('../lib/index.js');
  const harness = makeContext();
  await apply(harness.ctx, {});
  const response = await callApi(harness.registered, '/mydsh/api/settings');
  assert.equal(response.status, 200);
  const data = response.json.data;
  assert.ok(data.settings.interface !== undefined);
  assert.ok(data.defaults.interface !== undefined);
  assert.ok(Array.isArray(data.meta.interface.fields));
  assert.ok(data.meta.interface.fields.length > 0);
});

await check('api: an unknown route answers a structured 404', async () => {
  const { apply } = await import('../lib/index.js');
  const harness = makeContext();
  await apply(harness.ctx, {});
  const response = await callApi(harness.registered, '/mydsh/api/nope');
  assert.equal(response.status, 404);
  assert.equal(response.json.ok, false);
  assert.equal(response.json.error, 'not-found');
});

await check('api: a bad settings write is rejected with 400', async () => {
  const { apply } = await import('../lib/index.js');
  const harness = makeContext();
  await apply(harness.ctx, {});
  const response = await callApi(harness.registered, '/mydsh/api/settings', { method: 'POST', body: {} });
  assert.equal(response.status, 400);
  assert.equal(response.json.error, 'bad-request');
});

await check('api: a settings write persists and echoes the merged section', async () => {
  const { apply } = await import('../lib/index.js');
  const harness = makeContext();
  await apply(harness.ctx, {});
  const response = await callApi(harness.registered, '/mydsh/api/settings', {
    method: 'POST',
    body: { section: 'interface', patch: { hideBrandName: true } },
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.data.value.hideBrandName, true);
  assert.equal(response.json.data.value.enabled, true, 'siblings must survive a partial patch');
});

await check('api: a cross-origin write is refused', async () => {
  const { apply } = await import('../lib/index.js');
  const harness = makeContext();
  await apply(harness.ctx, {});

  // Build a request from a different origin, which a browser page could attempt.
  const url = new URL('http://127.0.0.1/mydsh/api/settings');
  let status = 0;
  const request = {
    method: 'POST',
    url: `${url.pathname}`,
    headers: { origin: 'https://evil.example.com', host: '127.0.0.1:59382' },
    on: (event, handler) => {
      if (event === 'data') handler(Buffer.from(JSON.stringify({ section: 'interface', patch: {} })));
      if (event === 'end') setImmediate(handler);
      return request;
    },
    destroy: () => {},
  };
  const response = {
    setHeader: () => {},
    writeHead: (code) => {
      status = code;
      return response;
    },
    end: () => {},
  };
  harness.registered.handler(request, response);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(status, 403, 'a cross-origin write must not be accepted');
});

await check('api: usage answers even with no session service', async () => {
  const { apply } = await import('../lib/index.js');
  const harness = makeContext();
  await apply(harness.ctx, {});
  const response = await callApi(harness.registered, '/mydsh/api/usage?range=7d');
  // The usage module is off by default, so the honest answer is "disabled";
  // turning it on must still produce a well-formed empty aggregate.
  assert.equal(response.status, 200);
  const data = response.json.data;
  assert.ok(data.disabled === true || data.totals !== undefined,
    'usage must either say it is disabled or return an aggregate');
});

await check('api: balance reports unavailability instead of failing', async () => {
  const { apply } = await import('../lib/index.js');
  const harness = makeContext();
  await apply(harness.ctx, {});
  const response = await callApi(harness.registered, '/mydsh/api/usage/balance');
  assert.equal(response.status, 200);
  assert.equal(response.json.data.available, false);
  assert.equal(response.json.data.reason, 'no-account-service');
});

await check('api: retry reports its kinds and a backoff schedule', async () => {
  const { apply } = await import('../lib/index.js');
  const harness = makeContext();
  await apply(harness.ctx, {});
  const response = await callApi(harness.registered, '/mydsh/api/retry');
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.json.data.kinds));
  assert.ok(response.json.data.kinds.includes('rate-limit'));
});

await check('api: the retry classifier explains a failure it is given', async () => {
  const { apply } = await import('../lib/index.js');
  const harness = makeContext();
  await apply(harness.ctx, {});
  const response = await callApi(harness.registered, '/mydsh/api/retry/test', {
    method: 'POST',
    body: { status: 429, message: 'rate limit exceeded' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.data.kind, 'rate-limit');
  assert.equal(response.json.data.retryable, true);
  assert.ok(Array.isArray(response.json.data.backoff));
  assert.ok(response.json.data.backoff.length > 0);
});

// Backup and remote ship turned off, so a test that exercises their live surfaces has
// to switch them on first — the same thing a user does in the settings page. Turning
// them on through the settings API also proves the gate reads the stored value.
//
// The suite shares one DSH_HOME across checks, so every module state this test cares
// about is set explicitly instead of being assumed.
async function setEnabled(harness, section, enabled) {
  const response = await callApi(harness.registered, '/mydsh/api/settings', {
    method: 'POST',
    body: { section, patch: { enabled } },
  });
  assert.equal(response.status, 200);
  return response;
}

await check('api: backup reports config, stages, and history', async () => {
  const { apply } = await import('../lib/index.js');
  const harness = makeContext();
  await apply(harness.ctx, {});
  await setEnabled(harness, 'backup', true);
  const response = await callApi(harness.registered, '/mydsh/api/backup');
  assert.equal(response.status, 200);
  assert.equal(response.json.data.enabled, true);
  assert.equal(response.json.data.busy, false);
  assert.ok(Array.isArray(response.json.data.stages));
  assert.ok(Array.isArray(response.json.data.history));
});

await check('api: a disabled module refuses to act and says so', async () => {
  const { apply } = await import('../lib/index.js');
  const harness = makeContext();
  await apply(harness.ctx, {});

  // Force every module off, then confirm each surface reports its disabled posture
  // instead of looking normal. Without the gate these routes answered as if healthy.
  for (const section of ['backup', 'retry', 'remote', 'toolbox']) {
    await setEnabled(harness, section, false);
  }

  for (const path of ['/mydsh/api/backup', '/mydsh/api/retry', '/mydsh/api/remote', '/mydsh/api/toolbox']) {
    const response = await callApi(harness.registered, path);
    assert.equal(response.status, 200);
    assert.equal(response.json.data.disabled, true, `${path} should report itself disabled`);
  }

  // And an action must be refused rather than silently doing nothing, so a schedule or
  // an external caller cannot keep writing archives behind a switched-off module.
  const run = await callApi(harness.registered, '/mydsh/api/backup/run', { method: 'POST', body: {} });
  assert.notEqual(run.status, 200);

  // Turning a module back on restores its surface.
  await setEnabled(harness, 'backup', true);
  const on = await callApi(harness.registered, '/mydsh/api/backup');
  assert.equal(on.json.data.enabled, true);
  assert.equal(on.json.data.disabled, undefined);
});

await check('api: remote reports status and refuses to connect without a URL', async () => {
  const { apply } = await import('../lib/index.js');
  const harness = makeContext();
  await apply(harness.ctx, {});
  await setEnabled(harness, 'remote', true);
  const status = await callApi(harness.registered, '/mydsh/api/remote');
  assert.equal(status.status, 200);
  assert.equal(status.json.data.enabled, true);
  assert.equal(status.json.data.origin, 'http://127.0.0.1:59382');

  const connect = await callApi(harness.registered, '/mydsh/api/remote/connect', { method: 'POST', body: {} });
  assert.equal(connect.status, 200);
  // Without a relay URL there is nothing to dial, so the connect reports a refusal with
  // a reason instead of pretending a tunnel is up. The earlier assertion expected
  // success here, which contradicted both the intent and the manager's own contract.
  assert.equal(connect.json.data.ok, false);
  assert.equal(connect.json.data.reason, 'no-relay-url');

  // The status must reflect that refusal rather than looking healthy.
  const afterConnect = await callApi(harness.registered, '/mydsh/api/remote');
  assert.equal(afterConnect.json.data.status.state, 'error');
});

await check('api: toolbox tolerates missing managers', async () => {
  const { apply } = await import('../lib/index.js');
  const harness = makeContext();
  await apply(harness.ctx, {});
  const mcp = await callApi(harness.registered, '/mydsh/api/toolbox/mcp');
  assert.equal(mcp.status, 200);
  assert.equal(mcp.json.data.available, false);
  const plugins = await callApi(harness.registered, '/mydsh/api/toolbox/plugins');
  assert.equal(plugins.json.data.available, false);
});

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : `\n        ${result.error}`}`);
}
console.log(`\nactivation: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
