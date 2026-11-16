/**
 * Client-side data access.
 *
 * The browser half reaches the Host over the HTTP route the Host mounts, so this
 * module owns the only place a request is built. Two behaviors matter:
 *
 *  - Requests are deduplicated per key. Several panels mount at once and ask for
 *    the same settings; one in-flight promise serves them all.
 *  - Reads are cached with a short TTL and invalidated on write, so navigation
 *    between tabs does not re-hit the Host on every render.
 */
import React from 'react';

const API_BASE = '/mydsh/api';

/**
 * A failure carrying the Host's machine code, so the UI can localize it.
 *
 * This module sits outside the React tree and has no locale service, so it must not
 * invent prose: a hardcoded English sentence here would surface untranslated in a
 * Chinese session with no way for a caller to reword it. The `code` is the stable
 * part — panels render a localized sentence from it — and the message carries only
 * the underlying technical detail, which is the same in every language.
 */
export class ApiFailure extends Error {
  constructor(code, message, status) {
    super(message ?? code);
    this.code = code;
    this.status = status;
  }
}

const inflight = new Map();
const cache = new Map();

function cacheKey(path, query) {
  return query === undefined ? path : `${path}?${query}`;
}

/**
 * Perform one request.
 *
 * `signal` lets a component abandon a request on unmount, which matters for the
 * usage panel because a full aggregate can take a moment.
 */
export async function request(path, { method = 'GET', body, query, signal } = {}) {
  const url = query === undefined ? `${API_BASE}${path}` : `${API_BASE}${path}?${query}`;
  const init = { method, credentials: 'same-origin', headers: {}, signal };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    // Only the transport's own detail goes in the message: the surrounding
    // sentence is the panel's job, because only the panel knows the language.
    throw new ApiFailure('network', String(error?.message ?? error), 0);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    // `HTTP 500` is language-neutral, unlike the English sentence this used to be:
    // a panel that can localize turns the code into its own wording, and a caller
    // that cannot still shows something specific and recognizable.
    throw new ApiFailure('bad-response', `HTTP ${response.status}`, response.status);
  }

  if (payload?.ok !== true) {
    // The Host's own message is passed through untouched when it sends one. When it
    // sends none, the message falls back to the machine code rather than to an
    // invented English sentence, so a panel can render its own localized wording.
    const code = payload?.error ?? 'unknown';
    throw new ApiFailure(code, payload?.message ?? code, response.status);
  }
  return payload.data;
}

/**
 * A cached read with request coalescing.
 *
 * `ttlMs` of 0 disables caching for that key, which is what a manual refresh
 * wants.
 */
export function read(path, { query, ttlMs = 3000, signal } = {}) {
  const key = cacheKey(path, query);
  const hit = cache.get(key);
  if (hit !== undefined && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value);

  const pending = inflight.get(key);
  if (pending !== undefined) return pending;

  const promise = request(path, { query, signal })
    .then((value) => {
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

/** A write that invalidates the whole read cache. */
export async function write(path, body) {
  const value = await request(path, { method: 'POST', body });
  cache.clear();
  return value;
}

/** Drop cached reads for a path prefix, or everything. */
export function invalidate(prefix) {
  if (prefix === undefined) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

// ── typed endpoints ────────────────────────────────────────────────────────

export const api = {
  settings: () => read('/settings', { ttlMs: 0 }),
  saveSettings: (section, patch) => write('/settings', { section, patch }),

  usage: (params) => {
    // Callers pass an AbortSignal alongside real parameters; URLSearchParams
    // would stringify it into the query, so only scalars are forwarded.
    const flat = {};
    for (const [key, value] of Object.entries(params ?? {})) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') flat[key] = value;
    }
    return read('/usage', { query: new URLSearchParams(flat).toString(), ttlMs: 5000 });
  },
  usageSessions: (limit = 20) => read('/usage/sessions', { query: `limit=${limit}`, ttlMs: 5000 }),
  usageContext: (sessionId) => read('/usage/context', { query: `sessionId=${encodeURIComponent(sessionId)}`, ttlMs: 0 }),
  usageBalance: () => read('/usage/balance', { ttlMs: 30_000 }),
  usagePrices: () => read('/usage/prices', { ttlMs: 60_000 }),

  // The agent family changes as children start and finish, so this is never cached.
  agentsTree: (sessionId) => read('/agents/tree', {
    query: `sessionId=${encodeURIComponent(sessionId)}`,
    ttlMs: 0,
  }),

  backup: () => read('/backup', { ttlMs: 0 }),
  backupRun: () => write('/backup/run', {}),
  backupTestDestination: (destination) => write('/backup/test-destination', { destination }),

  retry: () => read('/retry', { ttlMs: 0 }),
  retryTest: (failure) => write('/retry/test', failure),

  prompt: () => read('/prompt', { ttlMs: 0 }),

  remote: () => read('/remote', { ttlMs: 0 }),
  remoteConnect: () => write('/remote/connect', {}),
  remoteDisconnect: () => write('/remote/disconnect', {}),

  toolbox: () => read('/toolbox', { ttlMs: 0 }),
  toolboxMcp: () => read('/toolbox/mcp', { ttlMs: 0 }),
  toolboxPlugins: () => read('/toolbox/plugins', { ttlMs: 0 }),
  // Memory is user-editable content, so it is read on demand and written through two actions
  // rather than a generic settings patch.
  toolboxMemory: () => read('/toolbox/memory', { ttlMs: 0 }),
  memoryAdd: (text, tags) => write('/toolbox/memory', { action: 'add', text, tags }),
  memoryRemove: (query) => write('/toolbox/memory', { action: 'remove', query }),

  health: () => read('/system/health', { ttlMs: 0 }),
};

/**
 * A hook that runs an async read and re-runs when its dependencies change.
 *
 * A failed read becomes a rendered state rather than an unmounted tree, which is
 * what keeps one broken panel from taking the whole settings page with it.
 */
export function useAsync(loader, deps, { immediate = true } = {}) {
  const [state, setState] = React.useState({ data: undefined, error: undefined, loading: immediate });
  const [nonce, setNonce] = React.useState(0);
  const mounted = React.useRef(true);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  React.useEffect(() => {
    if (!immediate && nonce === 0) return undefined;
    const controller = new AbortController();
    setState((previous) => ({ ...previous, loading: true }));
    Promise.resolve()
      .then(() => loader({ signal: controller.signal }))
      .then((data) => {
        if (!mounted.current || controller.signal.aborted) return;
        setState({ data, error: undefined, loading: false });
      })
      .catch((error) => {
        if (!mounted.current || controller.signal.aborted) return;
        if (error?.name === 'AbortError') return;
        setState({ data: undefined, error, loading: false });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = React.useCallback(() => setNonce((value) => value + 1), []);
  return { ...state, reload };
}
