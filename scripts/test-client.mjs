/**
 * Client bundle tests.
 *
 * The browser half cannot run in Node, but three things about it can be checked
 * here and are exactly the things that break silently in a real browser:
 *
 *  - the module-loader envelope the shell expects;
 *  - that the bundle exposes `apply`/`inject` when the loader evaluates it;
 *  - that the pure helpers used by every panel return sane values.
 */
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import vm from 'node:vm';

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error) });
  }
};

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = join(packageRoot, 'lib', 'client.js');

await check('bundle: exists and is a plausible size', async () => {
  const info = statSync(bundlePath);
  assert.ok(info.size > 40_000, `bundle too small: ${info.size} bytes`);
  assert.ok(info.size < 1_500_000, `bundle unexpectedly large: ${info.size} bytes`);
});

await check('bundle: uses the module-loader envelope, not a bare export', async () => {
  const text = readFileSync(bundlePath, 'utf8');
  assert.match(text, /__ModuleLoader__\.load\(/);
  assert.match(text, /id:\s*['"]dsh-mydsh['"]/);
  assert.match(text, /factory\s*\(\s*require\s*\)/);
  // A stray ESM export would make the loader treat the file as native and fail.
  assert.equal(/^\s*export\s/m.test(text.slice(0, 2000)), false);
});

await check('bundle: evaluates and yields apply/inject without a browser', async () => {
  const source = readFileSync(bundlePath, 'utf8');

  // Capture what the loader receives. `React` is a minimal stand-in: the bundle
  // only needs `createElement` at module scope.
  let captured;
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
    createContext: () => ({ Provider: 'provider', Consumer: 'consumer' }),
    useContext: () => undefined,
    Fragment: 'fragment',
  };
  const requireShim = (id) => {
    if (id === 'react') return React;
    if (id === 'react-dom') return {};
    if (id === 'react/jsx-runtime') return { jsx: React.createElement, jsxs: React.createElement };
    throw new Error(`unexpected require: ${id}`);
  };

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (definition) => {
          captured = definition;
        },
      },
    },
    document: {
      createElement: () => ({ dataset: {}, textContent: '', style: {} }),
      head: { appendChild: () => {} },
      body: { setAttribute: () => {}, removeAttribute: () => {} },
      querySelector: () => null,
    },
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, data: {} }) }),
    URLSearchParams,
    AbortController,
    TextDecoder,
    WebSocket: class {},
    location: { hash: '' },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });

  assert.ok(captured !== undefined, 'the bundle must call __ModuleLoader__.load');
  assert.equal(captured.id, 'dsh-mydsh');

  const moduleExport = captured.factory(requireShim);
  assert.equal(typeof moduleExport.apply, 'function', 'apply is the activation entry');
  assert.ok(Array.isArray(moduleExport.inject), 'inject must declare client services');
  assert.ok(moduleExport.inject.includes('slots'), 'the plugin renders into slots');
});

await check('bundle: activation mounts every surface against a stub slot service', async () => {
  const source = readFileSync(bundlePath, 'utf8');
  let captured;
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
    createContext: () => ({ Provider: 'provider', Consumer: 'consumer' }),
    useContext: () => undefined,
    Fragment: 'fragment',
  };
  const requireShim = (id) => (id === 'react' ? React : {});

  // Recorded so the test can prove CSS reaches the document. The shipped pattern
  // appends a <style> to <head>; there is no `ctx.styles` service to observe.
  const appended = [];
  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => { captured = definition; } } },
    document: {
      createElement: () => ({ dataset: {}, textContent: '', style: {}, remove: () => {} }),
      head: { appendChild: (tag) => appended.push(tag) },
      body: { setAttribute: () => {}, removeAttribute: () => {} },
      querySelector: () => null,
    },
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, data: {} }) }),
    URLSearchParams,
    AbortController,
    TextDecoder,
    WebSocket: class {},
    location: { hash: '' },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });

  const registered = [];
  const ctx = {
    slots: {
      inject: (slot, factory) => {
        const disposer = factory();
        registered.push({ slot, disposer });
        return () => {};
      },
      register: (options, Component) => {
        // The runtime needs a component or a function returning one.
        assert.ok(options?.name !== undefined, 'a registration must name its slot');
        assert.ok(typeof Component === 'function', 'a registration must supply a component');
        return () => {};
      },
    },
    logger: { warn: () => {} },
    effect: () => {},
  };

  const client = captured.factory(requireShim);
  const dispose = client.apply(ctx);
  assert.equal(typeof dispose, 'function', 'activation must return a disposer');

  const slots = registered.map((entry) => entry.slot);
  assert.ok(slots.includes('settings.section'), 'the settings page must mount');
  assert.ok(slots.includes('settings.section.icon'), 'the nav icon must mount');
  assert.ok(slots.includes('sidebar.brand.mark'), 'the brand mark must mount');
  assert.ok(slots.includes('sidebar.brand.name'), 'the brand name must mount');

  // CSS must reach the page as a tagged <style>. The plugin used to route through a
  // `ctx.styles` service that does not exist, which left every surface unstyled, so
  // this asserts the mechanism that actually works.
  assert.ok(appended.length >= 1, 'at least one stylesheet must be appended to <head>');
  const tagged = appended.filter((tag) => tag?.dataset?.plugin === 'dsh-mydsh');
  assert.ok(tagged.length >= 1, 'every sheet must carry the plugin tag for cleanup');
  assert.ok(
    tagged.some((tag) => typeof tag.textContent === 'string' && tag.textContent.length > 0),
    'an appended sheet must carry CSS text',
  );
  assert.ok(
    tagged.some((tag) => String(tag.dataset.pluginCss ?? '').includes('mydsh')),
    'sheet ids must be namespaced so reloads can dedupe',
  );

  // Disposal must be safe and must not throw.
  dispose();
});

await check('bundle: a missing slot does not prevent the others from mounting', async () => {
  const source = readFileSync(bundlePath, 'utf8');
  let captured;
  const React = {
    createElement: () => null,
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
    createContext: () => ({ Provider: 'p', Consumer: 'c' }),
    useContext: () => undefined,
    Fragment: 'f',
  };
  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => { captured = definition; } } },
    document: {
      createElement: () => ({ dataset: {}, textContent: '', style: {} }),
      head: { appendChild: () => {} },
      body: { setAttribute: () => {}, removeAttribute: () => {} },
      querySelector: () => null,
    },
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, data: {} }) }),
    URLSearchParams,
    AbortController,
    TextDecoder,
    WebSocket: class {},
    location: { hash: '' },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });

  let attempts = 0;
  const ctx = {
    slots: {
      inject: (slot) => {
        attempts += 1;
        // Throw for the first slot only: the rest must still be attempted.
        if (slot === 'settings.section') throw new Error('slot missing in this build');
        return () => {};
      },
      register: () => () => {},
    },
    logger: { warn: () => {} },
    effect: () => {},
  };

  const client = captured.factory((id) => (id === 'react' ? React : {}));
  assert.doesNotThrow(() => client.apply(ctx));
  assert.ok(attempts >= 5, `all slots must be attempted, got ${attempts}`);
});

await check('bundle: pure helpers format numbers and money the way the UI expects', async () => {
  // The formatters are deliberately free of React so they can be checked here.
  const ui = await import('../src/client/format.js');
  assert.equal(ui.formatNumber(0), '0');
  assert.equal(ui.formatNumber(999), '999');
  // The project rule: past 万, one decimal.
  assert.equal(ui.formatNumber(10_000), '1.0万');
  assert.equal(ui.formatNumber(12_345), '1.2万');
  assert.equal(ui.formatNumber(156_789), '15.7万');

  assert.equal(ui.formatMoney(0), '¥0');
  assert.equal(ui.formatMoney(0.005), '¥0.0050');
  assert.equal(ui.formatMoney(1.5), '¥1.50');
  assert.equal(ui.formatMoney(1.5, 'USD'), '$1.50');

  assert.equal(ui.formatBytes(0), '0 B');
  assert.equal(ui.formatBytes(1024), '1.0 KiB');
  assert.equal(ui.formatBytes(1536), '1.5 KiB');

  assert.equal(ui.formatRelative(Date.now()), 'just now');
  assert.match(ui.formatRelative(Date.now() - 5 * 60_000), /^5m ago$/);
  assert.match(ui.formatRelative(Date.now() - 3 * 3600_000), /^3h ago$/);

  assert.equal(ui.formatDuration(0), '—');
  assert.equal(ui.formatDuration(420), '420ms');
  assert.equal(ui.formatDuration(4200), '4.2s');
  assert.equal(ui.formatDuration(95_000), '1m 35s');

  assert.equal(ui.cx('a', false, 'b', undefined, 'c'), 'a b c');
});

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : `\n        ${result.error}`}`);
}
console.log(`\nclient bundle: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
