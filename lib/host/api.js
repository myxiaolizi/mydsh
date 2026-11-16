/**
 * HTTP API for the dsh-mydsh client half.
 *
 * DSH plugin bundles have no direct Host RPC: the browser half reaches Host
 * capabilities over an HTTP route the Host registers on `ctx.webServer`. This
 * module owns that route, the request/response envelope, and the origin guard
 * that keeps a foreign page from driving a loopback DSH instance.
 *
 * Every handler returns plain JSON. Errors travel as `{ ok: false, error }`
 * with a machine code plus a human message, so the Client can localize without
 * parsing prose.
 */
import { clamp } from './util.js';

/** Route prefix claimed on the DSH web server. */
export const API_PREFIX = '/mydsh/api';

/** Largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export class ApiError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Reject requests a browser on another origin could have forged.
 *
 * A same-origin `fetch` from the DSH page carries an `Origin` header equal to
 * the page origin. Loopback hosts are also accepted for tooling. Anything else
 * would let a visited web page drive this instance, so it is refused.
 */
function guardRequest(req, trustedOrigins) {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '') {
    if (trustedOrigins.has(origin)) return null;
    // Same-origin requests may omit Origin for simple GETs; when present it
    // must match the host actually serving the page.
    const host = req.headers.host;
    if (typeof host === 'string' && origin === `http://${host}`) return null;
    if (typeof host === 'string' && origin === `https://${host}`) return null;
    if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) return null;
    return new ApiError('forbidden-origin', `Origin not allowed: ${origin}`, 403);
  }
  return null;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body, 'utf8'),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/**
 * Read and parse a JSON request body.
 *
 * The body source is read through both shapes a request can take: an async
 * iterable (Node's `IncomingMessage`, and what a fetch-style adapter exposes) and
 * an event emitter (`data`/`end`). Supporting only one means the plugin works in
 * whichever composition the probe happened to use and fails silently in the other.
 *
 * The size limit is enforced while reading, not after, so a hostile body cannot
 * force the Host to buffer it first.
 */
async function readBody(req) {
  const chunks = [];
  let total = 0;

  const accept = (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_BODY_BYTES) {
      throw new ApiError('body-too-large', 'Request body exceeds the size limit', 413);
    }
    chunks.push(bytes);
  };

  const finish = () => {
    if (total === 0) return undefined;
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.trim() === '') return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new ApiError('body-not-json', 'Request body is not valid JSON', 400);
    }
  };

  // Declared length is a cheap early refusal; a liar still hits the streaming cap.
  const declared = Number(req.headers?.['content-length'] ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ApiError('body-too-large', 'Request body exceeds the size limit', 413);
  }

  if (typeof req[Symbol.asyncIterator] === 'function') {
    for await (const chunk of req) accept(chunk);
    return finish();
  }

  if (typeof req.on === 'function') {
    await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      req.on('data', (chunk) => {
        try {
          accept(chunk);
        } catch (error) {
          settle(reject, error);
        }
      });
      req.on('end', () => settle(resolve, undefined));
      req.on('error', (error) => settle(reject, error));
      // `close` fires without `end` when a client disconnects mid-body: settle
      // there so the handler is never left waiting, but only after `end` has had
      // its chance — otherwise a normal request would lose its body.
      req.on('close', () => {
        if (settled) return;
        // A short grace period lets a queued `end` win the race.
        setTimeout(() => settle(resolve, undefined), 0);
      });
    });
    return finish();
  }

  // No readable body source: treat as an empty body rather than failing, because
  // a request with no payload is legitimate.
  return undefined;
}

/**
 * A registry of `METHOD /path` handlers with a stable dispatch order.
 *
 * Paths are matched exactly after the prefix, so an unknown method answers 404
 * with the attempted route instead of guessing.
 */
export class ApiRouter {
  /** @type {Map<string, (ctx: {body: unknown, url: URL, req: unknown}) => Promise<unknown>|unknown>} */
  #routes = new Map();

  /** Register `method` + `path`; a duplicate route is a wiring bug. */
  on(method, path, handler) {
    const key = `${method.toUpperCase()} ${path}`;
    if (this.#routes.has(key)) throw new Error(`duplicate route: ${key}`);
    this.#routes.set(key, handler);
    return this;
  }

  get(path, handler) {
    return this.on('GET', path, handler);
  }

  post(path, handler) {
    return this.on('POST', path, handler);
  }

  /** The registered route keys, for diagnostics and tests. */
  routes() {
    return [...this.#routes.keys()];
  }

  async dispatch(method, path, request) {
    // Trailing slashes are insignificant, so `/state` and `/state/` agree.
    const normalized = path.replace(/\/+$/, '') || '/';
    const handler = this.#routes.get(`${method.toUpperCase()} ${normalized}`);
    if (handler === undefined) {
      throw new ApiError('not-found', `No handler for ${method.toUpperCase()} ${normalized}`, 404);
    }
    return handler(request);
  }
}

/**
 * Mount the API route and return a disposer.
 *
 * `ctx.webServer` is optional: a headless composition without a GUI has no
 * server, and the plugin must stay usable (its Host-only modules keep working)
 * instead of throwing during activation.
 */
export function mountApi(ctx, router, options = {}) {
  const webServer = ctx.get('webServer');
  if (webServer === undefined) {
    logLevel(ctx, 'warn', 'dsh-mydsh: no web server; the settings UI will be unavailable');
    return () => {};
  }

  const trustedOrigins = new Set(options.trustedOrigins ?? []);
  try {
    const origin = webServer.getOrigin?.();
    if (typeof origin === 'string' && origin !== '') trustedOrigins.add(origin);
  } catch {
    // getOrigin throws before the port is bound; the guard still accepts
    // same-host origins and loopback, so this is not fatal.
  }

  return webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        const guarded = guardRequest(req, trustedOrigins);
        if (guarded !== null) {
          sendJson(res, guarded.status, { ok: false, error: guarded.code, message: guarded.message });
          return;
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname.slice(API_PREFIX.length) || '/';
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
        const result = await router.dispatch(req.method ?? 'GET', path, { body, url, req });
        sendJson(res, 200, { ok: true, data: result ?? null });
      } catch (error) {
        if (error instanceof ApiError) {
          sendJson(res, error.status, {
            ok: false,
            error: error.code,
            message: error.message,
            details: error.details ?? null,
          });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logLevel(ctx, 'error', `dsh-mydsh: API failure ${req.method} ${req.url}: ${message}`);
        sendJson(res, 500, { ok: false, error: 'internal', message });
      }
    },
  });
}

/** Parse and clamp a byte or item limit from a query string. */
export function queryLimit(url, name, fallback, min = 1, max = 1000) {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  return clamp(Number.parseInt(raw, 10), min, max);
}

/**
 * Emit one log line through whichever logger shape the context provides.
 *
 * Cordis exposes `ctx.logger` as an object with level methods; a plugin-local
 * factory would be a function. Both are accepted so this module works in either
 * composition, and a logger that throws never masks the original error.
 */
function logLevel(ctx, level, message) {
  try {
    const logger = ctx?.logger;
    if (logger === null || logger === undefined) return;
    if (typeof logger === 'function') {
      logger(level)?.(message);
      return;
    }
    const method = logger[level];
    if (typeof method === 'function') method.call(logger, message);
    else if (level === 'error') console.error(message);
  } catch {
    // Logging must never be the reason a response is lost.
  }
}
