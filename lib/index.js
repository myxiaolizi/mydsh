/**
 * dsh-mydsh — Host half.
 *
 * This is the plugin's Node entry. DSH loads it inside its own process, so the
 * rules here are stricter than for a standalone service:
 *
 *  - Activation must never throw. A plugin that throws during load takes down the
 *    composition, so every optional capability is probed before use and a missing
 *    one degrades that feature instead of the whole plugin.
 *  - Nothing heavy runs at import time. Every subsystem starts on demand, and the
 *    UI reaches them through the HTTP route this file mounts.
 *  - Every listener is an effect on this context's fiber, so unloading the plugin
 *    removes them without a reload.
 */
import { SettingsStore, MODULE_DEFAULTS } from './host/settings.js';
import { collection } from './host/settings-meta.js';
import { ApiRouter, mountApi, API_PREFIX, ApiError } from './host/api.js';
import { dataRoot, clamp, newId, readJson, resolveDshHome, sweepTempFiles, writeJsonAtomic } from './host/util.js';
import { PromptCustomizer } from './host/prompt.js';
import { RemoteAccessManager } from './host/remote/index.js';
import { RetryLedger, previewBackoff } from './host/retry/engine.js';
import { StreamRetryEngine } from './host/retry/stream-retry.js';
import { ERROR_KINDS, RETRYABLE_BY_DEFAULT, classifyError } from './host/retry/classify.js';
import { UsageStore, aggregate, contextInsight, resolveRange } from './host/usage/store.js';
import { DEFAULT_PRICES, effectivePrices, estimateCost } from './host/usage/pricing.js';
import { BackupEngine, STAGES } from './host/backup/engine.js';
import { createSources } from './host/backup/sources.js';

/** Plugin name used in logs and the settings namespace. */
const PLUGIN = 'dsh-mydsh';

/**
 * Activation entry point.
 *
 * `ctx` is the plugin's Cordis context; `config` is this entry's row from
 * cordis.patch.yml and only carries bootstrap values, because everything a user
 * changes lives in the settings store.
 */
export async function apply(ctx, config = {}) {
  const logger = (level) => (message) => {
    try {
      const method = ctx.logger?.[level];
      if (typeof method === 'function') method.call(ctx.logger, message);
      else if (level === 'error') console.error(message);
    } catch {
      // Logging must never be the reason activation fails.
    }
  };

  const profileName = typeof config.profile === 'string' && config.profile !== '' ? config.profile : 'desktop';
  const dshHome = resolveDshHome();
  const settings = new SettingsStore();

  // A killed process leaves its in-flight atomic-write temp file behind. Those copies
  // are full-size, so a few restarts during development piled up hundreds of megabytes
  // next to the usage index. Sweeping on start keeps the data directory proportional to
  // the data rather than to the restart count; it never touches a fresh file.
  try {
    const removed = await sweepTempFiles(dataRoot(), { prefix: 'usage-index.json' });
    if (removed > 0) logger('info')(`${PLUGIN}: removed ${removed} stale temp file(s)`);
  } catch {
    // Cleanup is housekeeping; it must never stop the plugin from loading.
  }

  // Settings load is the one thing every module shares; a failure here means a
  // corrupt file, which must not be fatal — defaults are safe.
  try {
    await settings.load();
  } catch (error) {
    logger('warn')(`${PLUGIN}: settings unreadable, falling back to defaults: ${error}`);
  }

  const runtime = {
    settings,
    logger,
    dshHome,
    profileName,
    services: resolveServices(ctx, logger),
  };

  // ── interface settings are pure configuration; the client reads them ──────
  const router = new ApiRouter();
  registerSettingsRoutes(router, runtime);
  registerUsageRoutes(router, runtime);
  registerBackupRoutes(router, runtime);
  registerRetryRoutes(router, runtime);
  registerPromptRoutes(router, runtime);
  registerRemoteRoutes(router, runtime);
  registerToolboxRoutes(router, runtime);
  registerSystemRoutes(router, runtime);

  const disposeApi = mountApi(ctx, router, {});
  ctx.effect?.(() => disposeApi);

  // ── prompt customization ────────────────────────────────────────────────
  const prompt = new PromptCustomizer({ settings, logger });
  prompt.attach(ctx);
  ctx.effect?.(() => prompt.dispose());

  // ── remote access ───────────────────────────────────────────────────────
  const remote = new RemoteAccessManager({ settings, logger });
  runtime.remote = remote;
  // Restore the previous state, but only after activation has settled: a relay
  // that hangs on connect must not delay the plugin appearing in the UI.
  settings.section('remote').then((section) => {
    if (section.enabled === true) remote.start(runtime.services.webServer).catch(() => {});
  }).catch(() => {});
  ctx.effect?.(() => remote.stop());

  // ── retry engine on the model stream ────────────────────────────────────
  const retryLedger = new RetryLedger();
  runtime.retryLedger = retryLedger;
  const streamRetry = new StreamRetryEngine({
    settings,
    logger,
    ledger: retryLedger,
    routes: () => resolveFallbackRoutes(settings, runtime.services),
  });
  runtime.streamRetry = streamRetry;

  const llm = runtime.services.llm;
  if (llm !== undefined && typeof ctx.on === 'function') {
    ctx.on('llm/stream', (options, next) => {
      // The waterfall must stay synchronous in its decision to wrap: returning a
      // generator keeps the platform's own dispatch intact when retry is off.
      const sessionKey = options?.sessionId ?? 'global';
      return streamRetry.wrap(options, next, sessionKey);
    });
  }

  // ── usage cache invalidation on new activity ────────────────────────────
  const usage = new UsageStore({
    sessionQuery: runtime.services.sessionQuery,
    dshHome,
    logger,
    workspaceDirOf: (record) => record?.header?.cwd ?? null,
  });
  runtime.usage = usage;
  if (typeof ctx.on === 'function') {
    // Targeted invalidation: only the session that grew needs re-reading. A
    // blanket invalidate would rescan the whole corpus on every message, which is
    // exactly the cost the persistent index exists to avoid.
    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'assistant/message') return;
      const id = session?.id ?? event?.data?.sessionId;
      if (typeof id === 'string') usage.invalidateSession(id);
      else usage.invalidate();
    });
  }

  // Warm the usage index in the background.
  //
  // A first build decompresses every session log, which on a large profile takes
  // minutes. Doing that inside the first dashboard request would time it out, so the
  // work starts here and the request either joins it or answers from whatever is
  // already indexed. Nothing waits on this, and a failure only costs the cache.
  //
  // The settings read is wrapped rather than awaited bare: a Host that is still
  // wiring its services can throw here, and activation must not fail because an
  // optional warmup could not start.
  try {
    const usageConfig = await settings.section('usage');
    if (usageConfig?.enabled === true) {
      // Never awaited, and its rejection is consumed here so an unreadable corpus
      // cannot surface as an unhandled rejection.
      Promise.resolve(usage.load()).catch((error) => {
        logLevel(ctx, 'warn', `dsh-mydsh: usage warmup failed: ${error?.message ?? error}`);
      });
    }
  } catch (error) {
    logLevel(ctx, 'warn', `dsh-mydsh: usage warmup skipped: ${error?.message ?? error}`);
  }

  // ── backup engine ───────────────────────────────────────────────────────
  const backupState = { lastBackupAt: 0 };
  const backup = new BackupEngine({
    settings,
    sources: createSources({ dshHome, profileName, logger }),
    logger,
    secrets: {
      async forDestination(destination) {
        return readDestinationSecrets(ctx, destination);
      },
      async get(key) {
        if (key === 'backup.password') return readBackupPassword(ctx);
        return undefined;
      },
    },
    state: backupState,
  });
  runtime.backup = backup;
  runtime.backupState = backupState;

  // ── backup triggers ─────────────────────────────────────────────────────
  installBackupTriggers(ctx, runtime, backup, settings, logger);

  logger('info')(`${PLUGIN}: host ready (profile=${profileName}, api=${API_PREFIX})`);
}

/**
 * Probe every optional service once, so request handlers never repeat the check
 * and a missing service is visible in one place.
 */
function resolveServices(ctx, logger) {
  const get = (key) => {
    try {
      return ctx.get(key);
    } catch {
      return undefined;
    }
  };
  return {
    webServer: get('webServer'),
    llm: get('llm'),
    sessionQuery: get('sessionQuery'),
    sessionProjections: get('sessionProjections'),
    workspaceRegistry: get('workspaceRegistry'),
    deepseekAccount: get('deepseekAccount'),
    credentials: get('credentials'),
    systemPrompt: get('systemPrompt'),
    mcpManager: get('mcpManager'),
    pluginManager: get('pluginManager'),
    schedule: get('schedule'),
    storage: get('storage'),
    tools: get('tools'),
  };
}

// ── settings routes ────────────────────────────────────────────────────────

function registerSettingsRoutes(router, runtime) {
  router.get('/settings', async () => {
    const snapshot = await runtime.settings.snapshot();
    return { settings: snapshot, defaults: MODULE_DEFAULTS, meta: collection };
  });

  router.post('/settings', async ({ body }) => {
    const section = body?.section;
    if (typeof section !== 'string' || section === '') {
      throw new ApiError('bad-request', 'section is required');
    }
    const patch = body?.patch;
    if (patch === null || typeof patch !== 'object') {
      throw new ApiError('bad-request', 'patch must be an object');
    }
    const next = await runtime.settings.patch(section, patch);
    // A master switch change has side effects beyond storage.
    if (section === 'remote' && 'enabled' in patch) {
      if (next.enabled === true) await runtime.remote?.start(runtime.services.webServer);
      else await runtime.remote?.stop();
    }
    return { section, value: next };
  });
}

// ── usage routes ───────────────────────────────────────────────────────────

/**
 * Session titles, cached out of the request path.
 *
 * `readTitleSnapshots` reads and decompresses each session's log, so a single id costs
 * ~80 ms and the endpoint scaled with how many it was given: 2 s at `limit=1`, 20 s at
 * `limit=200`. Resolving even a slice of them inside the request made latency a lottery —
 * 1.4 s when the batch happened to be cached, 3.9 s when it was not — so titles are now a
 * pure enhancement:
 *
 *  - A request reads only `cachedTitles`, which touches no I/O and cannot fail.
 *  - `prewarmTitles` fills the cache in the background, after the response is assembled.
 *  - A title never changes once set, so entries do not expire; the cap bounds the map.
 *
 * A row without a title renders its short session id, so nothing is ever blank.
 */
const TITLE_CACHE_LIMIT = 2000;
const titleCache = new Map();
const titlePending = new Map();

/** Read one batch of titles, sharing the in-flight promise between callers. */
function requestTitles(query, ids) {
  const fresh = [];
  const waiting = [];
  for (const id of ids) {
    const pending = titlePending.get(id);
    if (pending === undefined) fresh.push(id);
    else waiting.push(pending.then((title) => [id, title]));
  }

  if (fresh.length > 0) {
    const batch = query.readTitleSnapshots(fresh).catch(() => []);
    for (const id of fresh) {
      titlePending.set(id, batch.then((items) => {
        const item = (items ?? []).find((entry) => entry?.sessionId === id);
        return item?.status === 'fulfilled' ? item.value?.title?.title ?? null : null;
      }));
    }
  }

  return { fresh, waiting };
}

/**
 * Titles the cache already knows.
 *
 * Deliberately synchronous and I/O-free. Reading a title means decompressing a session log
 * (~80 ms each), so any attempt to resolve one inside a request made the endpoint's latency
 * a lottery: 1.4 s on a warm cache, 3.9 s when a batch happened to land. The rows ship with
 * whatever is known and the cache is filled afterwards by `prewarmTitles`.
 */
function cachedTitles(sessionIds) {
  const resolved = new Map();
  for (const id of sessionIds) {
    if (titleCache.has(id)) resolved.set(id, titleCache.get(id));
  }
  return resolved;
}

/**
 * Fill the title cache in the background.
 *
 * Started after a response is assembled, so the work is invisible. Batched so one large
 * read cannot monopolise the session reader, and skipped entirely if a pass is already
 * running: the goal is a warmer cache, not throughput.
 */
let prewarming = false;
async function prewarmTitles(query, sessionIds) {
  if (prewarming) return;
  const missing = sessionIds.filter((id) => !titleCache.has(id)).slice(0, TITLE_CACHE_LIMIT);
  if (missing.length === 0) return;
  prewarming = true;
  try {
    for (let index = 0; index < missing.length; index += 16) {
      const slice = missing.slice(index, index + 16);
      const { fresh, waiting } = requestTitles(query, slice);
      const settled = await Promise.all([
        ...fresh.map(async (id) => {
          const title = await titlePending.get(id);
          titlePending.delete(id);
          return [id, title];
        }),
        ...waiting,
      ]);
      for (const [id, title] of settled) {
        if (title !== null && title !== undefined) remember(id, title);
      }
    }
  } catch {
    // Prewarming is a hint; a failure just leaves the labels for the next request.
  } finally {
    prewarming = false;
  }
}

/** Store a title, evicting the oldest entry once the cap is reached. */
function remember(id, title) {
  if (title === null || title === undefined) return;
  titleCache.set(id, title);
  while (titleCache.size > TITLE_CACHE_LIMIT) {
    const oldest = titleCache.keys().next();
    if (oldest.done === true) break;
    titleCache.delete(oldest.value);
  }
}

async function costOfFactory(runtime) {
  const config = await runtime.settings.section('usage');
  const prices = effectivePrices(config.priceOverrides);
  return (record) => estimateCost(record, record.provider, record.model, {
    prices,
    usdToCny: config.usdToCny ?? 7.2,
  });
}

function registerUsageRoutes(router, runtime) {
  router.get('/usage', async ({ url }) => {
    const config = await runtime.settings.section('usage');
    if (config.enabled !== true) return { disabled: true };

    const spec = {
      kind: url.searchParams.get('range') ?? '7d',
      from: Number(url.searchParams.get('from') ?? Number.NaN),
      to: Number(url.searchParams.get('to') ?? Number.NaN),
      // Optional explicit granularity (`hour` / `day` / `week`). The heatmap needs one
      // cell per day regardless of the span, which the automatic scaling cannot provide.
      bucket: url.searchParams.get('bucket') ?? undefined,
    };
    const range = resolveRange(spec);
    const groupBy = url.searchParams.get('groupBy') ?? 'provider';

    const records = await runtime.usage.load();
    const cost = await costOfFactory(runtime);
    const result = aggregate(records, { ...range, groupBy, costOf: cost });
    return { ...result, groupBy, priced: true };
  });

  router.get('/usage/sessions', async ({ url }) => {
    const limit = clamp(Number(url.searchParams.get('limit') ?? 20), 1, 200);
    const records = await runtime.usage.load();
    const cost = await costOfFactory(runtime);

    const bySession = new Map();
    for (const record of records) {
      const entry = bySession.get(record.sessionId) ?? {
        sessionId: record.sessionId, total: 0, input: 0, output: 0, calls: 0, cost: 0, lastTime: 0,
      };
      entry.total += record.total;
      entry.input += record.input;
      entry.output += record.output;
      entry.calls += 1;
      entry.cost += cost(record)?.amount ?? 0;
      entry.lastTime = Math.max(entry.lastTime, record.time);
      bySession.set(record.sessionId, entry);
    }
    const rows = [...bySession.values()].sort((a, b) => b.total - a.total).slice(0, limit);
    // A session id alone is not readable, but a title is decoration: every row ships
    // regardless, and titles fill in from the cache as it warms (see `prewarmTitles`).
    const query = runtime.services.sessionQuery;
    const canTitle = query !== undefined && typeof query.readTitleSnapshots === 'function';
    const ids = rows.map((row) => row.sessionId);
    const titles = cachedTitles(ids);
    for (const row of rows) row.title = titles.get(row.sessionId) ?? null;
    // Warm the cache after the response is assembled, so the next open has the labels
    // without this one having waited for them.
    if (canTitle) void prewarmTitles(query, ids);
    return { rows };
  });

  router.get('/usage/context', async ({ url }) => {
    const sessionId = url.searchParams.get('sessionId');
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new ApiError('bad-request', 'sessionId is required');
    }
    const query = runtime.services.sessionQuery;
    if (query === undefined) return { available: false };
    const log = await query.readSession(sessionId);
    // The model's declared window is the denominator; fall back to the last
    // request's own context record when the model is no longer resolvable.
    let window;
    const context = log?.events?.find((event) => event?.type === 'request/context');
    if (context?.data?.contextWindow !== undefined) window = context.data.contextWindow;
    return { available: true, ...contextInsight(log?.events ?? [], window) };
  });

  router.get('/usage/balance', async () => {
    const account = runtime.services.deepseekAccount;
    if (account === undefined) return { available: false, reason: 'no-account-service' };
    try {
      const balance = await account.getBalance({
        version: '1',
        locale: 'zh',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      });
      return { available: true, balance };
    } catch (error) {
      return { available: false, reason: 'query-failed', detail: String(error?.message ?? error) };
    }
  });

  router.get('/usage/prices', async () => {
    const config = await runtime.settings.section('usage');
    return { defaults: DEFAULT_PRICES, overrides: config.priceOverrides ?? {} };
  });
}

// ── backup routes ──────────────────────────────────────────────────────────

function registerBackupRoutes(router, runtime) {
  router.get('/backup', async () => {
    const config = await runtime.settings.section('backup');
    // A disabled module answers with its state so the panel can explain itself, but
    // reports itself as off rather than pretending everything is normal.
    if (config.enabled !== true) {
      return { enabled: false, disabled: true, config };
    }
    return {
      enabled: true,
      config,
      busy: runtime.backup.busy,
      history: runtime.backup.history(20),
      stages: STAGES,
      lastBackupAt: runtime.backupState.lastBackupAt,
    };
  });

  router.post('/backup/run', async () => {
    const config = await runtime.settings.section('backup');
    // Disabling the module must stop the work, not just hide the button: a scheduled
    // or externally triggered run would otherwise still write archives.
    if (config.enabled !== true) {
      throw new ApiError('disabled', 'the backup module is turned off');
    }
    const result = await runtime.backup.run({ trigger: 'manual' });
    return result;
  });

  router.post('/backup/test-destination', async ({ body }) => {
    const config = body?.destination;
    if (config === null || typeof config !== 'object') {
      throw new ApiError('bad-request', 'destination is required');
    }
    const { destinationFrom } = await import('./host/backup/destinations.js');
    const secrets = await readDestinationSecrets(runtime.ctx, config);
    const destination = destinationFrom(config, secrets);
    return destination.ready();
  });
}

/** Secrets live in the credential store, never in settings.json. */
async function readDestinationSecrets(ctx, destination) {
  const credentials = ctx?.get?.('credentials');
  if (credentials === undefined) return {};
  const into = {};
  try {
    const record = await credentials.readRecord?.('mydsh.backup');
    if (record !== null && typeof record === 'object') {
      const key = destination?.id ?? destination?.kind;
      const scoped = record[key];
      if (scoped !== null && typeof scoped === 'object') return { ...scoped };
      return { ...record };
    }
  } catch {
    // A missing credential record means "not configured yet", not an error.
  }
  return into;
}

async function readBackupPassword(ctx) {
  const credentials = ctx?.get?.('credentials');
  if (credentials === undefined) return undefined;
  try {
    const record = await credentials.readRecord?.('mydsh.backup');
    return record?.password;
  } catch {
    return undefined;
  }
}

// ── retry routes ───────────────────────────────────────────────────────────

function registerRetryRoutes(router, runtime) {
  router.get('/retry', async () => {
    const config = await runtime.settings.section('retry');
    if (config.enabled !== true) {
      return { enabled: false, disabled: true, config, kinds: ERROR_KINDS, defaults: RETRYABLE_BY_DEFAULT };
    }
    return {
      enabled: true,
      config,
      kinds: ERROR_KINDS,
      defaults: RETRYABLE_BY_DEFAULT,
      stats: runtime.retryLedger.stats(),
      recent: runtime.retryLedger.recent(50),
    };
  });

  router.post('/retry/test', async ({ body }) => {
    const failure = {
      code: body?.code,
      status: body?.status,
      message: body?.message,
    };
    const kind = classifyError(failure);
    const config = await runtime.settings.section('retry');
    return {
      kind,
      retryable: RETRYABLE_BY_DEFAULT.includes(kind),
      backoff: previewBackoff({
        attempts: Math.min(10, config.maxAttempts ?? 3),
        initialDelayMs: config.initialDelayMs ?? 1000,
        maxDelayMs: config.maxDelayMs ?? 30_000,
        jitterRatio: config.jitterRatio ?? 0.1,
      }),
      stats: runtime.retryLedger.totals(),
    };
  });
}

// ── prompt routes ──────────────────────────────────────────────────────────

function registerPromptRoutes(router, runtime) {
  router.get('/prompt', async () => {
    const config = await runtime.settings.section('prompt');
    // A disabled prompt module contributes no text, so say so rather than reporting
    // configuration that is not in effect.
    if (config.enabled !== true) return { enabled: false, disabled: true, config };
    return { enabled: true, config };
  });
}

// ── remote routes ──────────────────────────────────────────────────────────

function registerRemoteRoutes(router, runtime) {
  router.get('/remote', async () => {
    const config = await runtime.settings.section('remote');
    if (config.enabled !== true) {
      return { enabled: false, disabled: true, config, status: { state: 'off' }, origin: null };
    }
    return {
      enabled: true,
      config,
      status: runtime.remote?.status ?? { state: 'off' },
      origin: runtime.remote?.localOrigin(runtime.services.webServer) ?? null,
    };
  });

  router.post('/remote/connect', async () => {
    const config = await runtime.settings.section('remote');
    // Turning the module off must also stop an existing tunnel from being reopened;
    // otherwise the switch would only hide the button while traffic kept flowing.
    if (config.enabled !== true) {
      throw new ApiError('disabled', 'the remote access module is turned off');
    }
    return runtime.remote.start(runtime.services.webServer);
  });

  router.post('/remote/disconnect', async () => {
    return runtime.remote.stop();
  });
}

// ── toolbox routes ─────────────────────────────────────────────────────────

function registerToolboxRoutes(router, runtime) {
  router.get('/toolbox', async () => {
    const config = await runtime.settings.section('toolbox');
    if (config.enabled !== true) return { enabled: false, disabled: true, config };
    return { enabled: true, config };
  });

  router.get('/toolbox/mcp', async () => {
    const config = await runtime.settings.section('toolbox');
    if (config.enabled !== true) return { enabled: false, disabled: true, available: false, servers: [] };
    const mcpManager = runtime.services.mcpManager;
    if (mcpManager === undefined) return { enabled: true, available: false, servers: [] };
    try {
      const servers = await mcpManager.list?.();
      return { enabled: true, available: true, servers: servers ?? [] };
    } catch (error) {
      return { enabled: true, available: false, reason: String(error?.message ?? error), servers: [] };
    }
  });

  router.get('/toolbox/plugins', async () => {
    const config = await runtime.settings.section('toolbox');
    if (config.enabled !== true) return { enabled: false, disabled: true, available: false, plugins: [] };
    const pluginManager = runtime.services.pluginManager;
    if (pluginManager === undefined) return { enabled: true, available: false, plugins: [] };
    try {
      const plugins = await pluginManager.listPlugins?.();
      return { enabled: true, available: true, plugins: plugins ?? [] };
    } catch (error) {
      return { enabled: true, available: false, reason: String(error?.message ?? error), plugins: [] };
    }
  });
}

// ── system routes ──────────────────────────────────────────────────────────

function registerSystemRoutes(router, runtime) {
  router.get('/system/health', async () => ({
    plugin: PLUGIN,
    version: '1.0.0',
    profile: runtime.profileName,
    dataRoot: dataRoot(),
    services: Object.fromEntries(
      Object.entries(runtime.services).map(([key, value]) => [key, value !== undefined]),
    ),
  }));
}

// ── triggers ───────────────────────────────────────────────────────────────

/**
 * Install the three backup triggers.
 *
 * Each trigger re-reads settings before firing: a user who disables scheduled
 * backups expects the next tick to do nothing, not to run once more.
 */
function installBackupTriggers(ctx, runtime, backup, settings, logger) {
  if (typeof ctx.on !== 'function') return;

  // After a session settles. `agent/disposed` is the one reliable "this work is
  // finished" signal, and it fires after the log is durable.
  ctx.on('agent/disposed', () => {
    settings.section('backup').then((config) => {
      if (config.enabled !== true || config.triggers?.afterSession !== true) return;
      if (backup.busy) return;
      backup.run({ trigger: 'after-session' }).catch((error) => {
        logger('warn')(`${PLUGIN}: after-session backup failed: ${error}`);
      });
    }).catch(() => {});
  });

  // On startup, once, after the composition settles.
  settings.section('backup').then((config) => {
    if (config.enabled !== true || config.triggers?.onStartup !== true) return;
    const timer = setTimeout(() => {
      if (backup.busy) return;
      backup.run({ trigger: 'startup' }).catch(() => {});
    }, 15_000);
    timer.unref?.();
    ctx.effect?.(() => clearTimeout(timer));
  }).catch(() => {});

  // Schedule service owns cron; delegate rather than reimplement a scheduler.
  installScheduledBackup(ctx, settings, backup, logger);
}

async function installScheduledBackup(ctx, settings, backup, logger) {
  const schedule = (() => {
    try {
      return ctx.get('schedule');
    } catch {
      return undefined;
    }
  })();
  if (schedule === undefined || typeof schedule.register !== 'function') {
    logger('info')(`${PLUGIN}: no schedule service; scheduled backups are unavailable`);
    return;
  }

  const config = await settings.section('backup').catch(() => undefined);
  if (config?.enabled !== true || config?.triggers?.scheduled !== true) return;

  try {
    schedule.register({
      id: 'dsh-mydsh-backup',
      title: '我的DSH 自动备份',
      cron: config.triggers.schedule ?? '0 3 * * *',
      run: async () => {
        const current = await settings.section('backup');
        if (current.enabled !== true || current.triggers?.scheduled !== true) return;
        await backup.run({ trigger: 'scheduled' });
      },
    });
  } catch (error) {
    logger('warn')(`${PLUGIN}: cannot register the scheduled backup: ${error}`);
  }
}

/** Fallback routes for a retry that wants a different provider/model. */
async function resolveFallbackRoutes(settings, services) {
  const config = await settings.section('retry');
  const chain = [];
  const seen = new Set();
  const llm = services.llm;

  let available;
  if (llm !== undefined && typeof llm.listProviders === 'function') {
    try {
      available = new Set((await llm.listProviders()).map((provider) => provider.id));
    } catch {
      available = undefined;
    }
  }

  for (const entry of config.alternatives ?? []) {
    const provider = entry?.provider;
    const model = entry?.model;
    if (typeof provider !== 'string' || provider === '') continue;
    if (typeof model !== 'string' || model === '') continue;
    if (available !== undefined && !available.has(provider)) continue;
    const key = `${provider}/${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chain.push({ provider, model });
  }
  return chain;
}
