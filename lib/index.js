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
import { join } from 'node:path';
import { dataRoot, clamp, newId, readJson, resolveDshHome, sweepTempFiles, writeJsonAtomic } from './host/util.js';
import { PromptCustomizer } from './host/prompt.js';
import { RemoteAccessManager } from './host/remote/index.js';
import { RetryLedger, previewBackoff } from './host/retry/engine.js';
import { StreamRetryEngine } from './host/retry/stream-retry.js';
import { AutoContinueEngine } from './host/retry/auto-continue.js';
import { TOOLBOX_REGISTRY, availableModules, installToolbox } from './host/toolbox/index.js';
import { ERROR_KINDS, RETRYABLE_BY_DEFAULT, classifyError } from './host/retry/classify.js';
import { UsageStore, aggregate, contextInsight, resolveRange } from './host/usage/store.js';
import { DEFAULT_PRICES, effectivePrices, estimateCost } from './host/usage/pricing.js';
import { BackupEngine, STAGES } from './host/backup/engine.js';
import { createSources } from './host/backup/sources.js';
import { missingDestinationFields } from './host/backup/destinations.js';

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

  // ── automatic turn continuation ─────────────────────────────────────────
  // The stream retry above only replays one model request. A turn that ends on
  // `max-tokens`, or that dies after the stream layer exhausted its budget, leaves the
  // conversation unanswered until the user types "continue". `turn/end` carries the exact
  // reason, so the decision needs no polling.
  const autoContinue = new AutoContinueEngine({
    settings,
    logger,
    agents: runtime.services.agents,
    randomId: () => globalThis.crypto.randomUUID(),
  });
  runtime.autoContinue = autoContinue;
  if (typeof ctx.on === 'function') {
    ctx.on('session/event', (session, event) => {
      // Fire-and-forget: the emit is post-commit and must not delay the append.
      void autoContinue.onSessionEvent(session, event);
    });
  }
  ctx.effect?.(() => autoContinue.dispose());

  // ── toolbox modules ─────────────────────────────────────
  // Implemented here rather than delegated to other plugins: the settings page has offered
  // these switches since the first release, and until now none of them did anything.
  const toolbox = await installToolbox({
    ctx,
    runtime,
    settings,
    logger,
    readJson,
    writeJson: writeJsonAtomic,
    memoryPath: join(dshHome, 'mydsh', 'memory.json'),
    registerTool: makeToolRegistrar(runtime, logger),
  });
  if (toolbox.errors.length > 0) {
    logger?.('warn')?.(`dsh-mydsh: toolbox partially installed: ${toolbox.errors.join('; ')}`);
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
    // The agent-family page needs this to walk a session's subtree. Optional: composition
    // without delegation is normal, and the page then reports the feature as unavailable.
    subagents: get('subagents'),
    agentTeams: get('agentTeams'),
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

/**
 * The agent-family walk is expensive and its composition is stable over seconds.
 *
 * `listDescendants` reads one catalog per descendant, and each read decompresses a session
 * log; a nine-child family measured ~6 s. The page re-reads the family every time it opens,
 * so without a cache every open pays that again. The TTL is short because a family does
 * change — a child finishing flips its activity — but not on a sub-minute timescale.
 *
 * `InFlight` is separate from the cache so two panels opening at once share one walk
 * instead of starting a second six-second traversal.
 */
const AGENT_TREE_TTL = 15_000;
const AGENT_TREE_CACHE_LIMIT = 200;
const agentTreeCache = new Map();
const agentTreeInFlight = new Map();

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
    // The reader may return a promise or a plain array; `await` handles both, while
    // calling `.catch` on an array throws and would silently kill the whole warm.
    const batch = Promise.resolve()
      .then(() => query.readTitleSnapshots(fresh))
      .catch(() => []);
    for (const id of fresh) {
      titlePending.set(id, batch.then((items) => {
        const item = Array.isArray(items)
          ? items.find((entry) => entry?.sessionId === id)
          : undefined;
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
    // One read, exactly as the previously working code did it. Splitting into small
    // batches stalled: the reader never settled for a 16-id slice, and no batch ever
    // logged, so the cache stayed empty while requests kept returning in ~120 ms.
    const { fresh, waiting } = requestTitles(query, missing);
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

  /**
   * The agent family for one session: the root, its parents, and every descendant.
   *
   * `listDescendants` walks the live subagent catalogs. It is the only supported way to
   * learn the tree: there is no session-level "parent" field to read, and catalogs are
   * observed and released one at a time so a large tree does not hold them all open.
   *
   * Returns an empty family rather than failing when the subagent service is absent, which
   * is a normal composition; the panel then says so instead of showing an error.
   */
  router.get('/agents/tree', async ({ url }) => {
    const requested = url.searchParams.get('sessionId');
    const subagents = runtime.services.subagents;

    // A sidebar-mounted entry has no session of its own, so an omitted id means "the most
    // recently active live agent". That is the only sensible subject for an entry point
    // that is not scoped to a session; an explicit id always wins.
    let rootId = typeof requested === 'string' && requested !== '' ? requested : null;
    if (rootId === null) {
      const live = runtime.services.agents?.list?.() ?? [];
      const newest = live[live.length - 1];
      rootId = newest?.id ?? null;
    }
    if (rootId === null) {
      return { available: false, reason: 'no-live-session', rootId: null, members: [] };
    }

    if (subagents === undefined || typeof subagents.listDescendants !== 'function') {
      return { available: false, reason: 'no-subagent-service', rootId, members: [] };
    }

    // Walking the tree decompresses one catalog per descendant — 9 children cost ~6 s on
    // this machine — so the result is cached and concurrent opens share one walk. The short
    // TTL is deliberate: the page is re-read every time it opens, and a family that changed
    // a few seconds ago is not worth another six.
    const now = Date.now();
    const cached = agentTreeCache.get(rootId);
    if (cached !== undefined && now - cached.at < AGENT_TREE_TTL) {
      return cached.value;
    }
    const inFlight = agentTreeInFlight.get(rootId);
    if (inFlight !== undefined) return inFlight;

    const pending = (async () => {
      let entries;
      try {
        entries = await subagents.listDescendants(rootId);
      } catch (error) {
        // A root catalog that cannot be read is reported, not thrown: the caller is a page,
        // and an unreadable family is a state to display rather than a request failure.
        return {
          available: false,
          reason: 'listing-failed',
          detail: String(error?.message ?? error),
          rootId,
          members: [],
        };
      }

      // The root itself has no entry in the descendant list, so it is added explicitly.
      const members = [{
        id: rootId,
        parentId: null,
        depth: 0,
        kind: 'root',
        activity: 'unknown',
        name: 'lead',
        label: null,
        path: null,
        hasChildren: (entries?.length ?? 0) > 0,
      }];

      for (const entry of entries ?? []) {
        members.push({
          id: entry.id,
          parentId: entry.parentId ?? null,
          depth: typeof entry.depth === 'number' ? entry.depth : 1,
          kind: entry.kind === 'diagnostic' ? 'diagnostic' : 'child',
          // Diagnostics carry a reason instead of an activity; the panel shows it as a note.
          activity: entry.activity ?? 'unknown',
          reason: entry.reason ?? null,
          name: entry.name ?? null,
          label: entry.label ?? null,
          path: entry.path ?? null,
          mode: entry.mode ?? null,
          hasChildren: entry.hasChildren === true,
        });
      }

      const value = { available: true, rootId, members };
      agentTreeCache.set(rootId, { at: Date.now(), value });
      // Evict the oldest ids rather than letting a long-lived process grow a map per session.
      while (agentTreeCache.size > AGENT_TREE_CACHE_LIMIT) {
        const oldest = agentTreeCache.keys().next().value;
        agentTreeCache.delete(oldest);
      }
      return value;
    })();

    agentTreeInFlight.set(rootId, pending);
    try {
      return await pending;
    } finally {
      // Released on every path, so a failed walk does not pin the id forever.
      agentTreeInFlight.delete(rootId);
    }
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
    // Report each destination's readiness up front. A destination that was saved without its
    // required fields used to look fine until a run failed after building a 1.6 GB archive,
    // so the panel now knows before the user presses the button.
    const destinationHealth = (Array.isArray(config.destinations) ? config.destinations : [])
      .filter((entry) => entry?.enabled !== false)
      .map((entry) => {
        const missing = missingDestinationFields(entry);
        return {
          id: entry.id ?? null,
          kind: entry.kind ?? 'local',
          ready: missing.length === 0,
          missing: missing.map((field) => field.key),
        };
      });

    return {
      enabled: true,
      config,
      busy: runtime.backup.busy,
      history: runtime.backup.history(20),
      stages: STAGES,
      lastBackupAt: runtime.backupState.lastBackupAt,
      destinationHealth,
      // The one flag the panel needs to say "configure this before running" instead of
      // letting the user discover it through a failed run.
      runnable: destinationHealth.length > 0 && destinationHealth.some((entry) => entry.ready),
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
      // Whole-turn continuation is a second layer above the stream retry, so it reports
      // separately: what is queued right now, and why each session last stopped.
      continuation: runtime.autoContinue?.inspect?.() ?? { watching: 0, sessions: [] },
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
    // `registry` states, per module, whether this build can actually do anything for it and
    // what was installed. Without it the panel cannot tell a working switch from a label.
    return {
      enabled: true,
      config,
      registry: TOOLBOX_REGISTRY,
      available: availableModules(),
      installed: [...(runtime.toolbox?.installed ?? [])],
      errors: [...(runtime.toolbox?.errors ?? [])],
    };
  });

  // Memory is the one module whose content the user edits, so it needs its own read and
  // write. Notes are added through the model's tools; this surface is for pruning.
  router.get('/toolbox/memory', async () => {
    const config = await runtime.settings.section('toolbox');
    if (config.enabled !== true) return { enabled: false, disabled: true, notes: [] };
    // The module switch is a second gate: the section can be on while memory itself is off, and
    // reading the store then would show content the user has switched away from.
    if (config.modules?.memory !== true) return { enabled: true, memoryOff: true, available: false, notes: [] };
    const memory = runtime.toolbox?.memory;
    if (memory === undefined) return { enabled: true, available: false, notes: [] };
    const snapshot = await memory.snapshot();
    return { enabled: true, available: true, ...snapshot };
  });

  router.post('/toolbox/memory', async ({ body }) => {
    const config = await runtime.settings.section('toolbox');
    if (config.enabled !== true) throw new ApiError('forbidden', 'the toolbox is switched off');
    // Writing past a switched-off module would store a note the prompt never injects, which is
    // worse than refusing: the user would believe it was remembered.
    if (config.modules?.memory !== true) throw new ApiError('forbidden', 'the memory module is switched off');
    const memory = runtime.toolbox?.memory;
    if (memory === undefined) throw new ApiError('unavailable', 'memory is not installed');
    const action = typeof body?.action === 'string' ? body.action : '';
    if (action === 'add') {
      const result = await memory.add({ text: body?.text, tags: body?.tags });
      if (result.ok !== true) throw new ApiError('bad-request', `cannot store that note: ${result.reason}`);
      return result;
    }
    if (action === 'remove') {
      const result = await memory.remove(body?.query);
      if (result.ok !== true) throw new ApiError('bad-request', `cannot remove: ${result.reason}`);
      return result;
    }
    throw new ApiError('bad-request', 'action must be add or remove');
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

/**
 * Turn a small tool description into the Host's tool definition shape.
 *
 * The toolbox modules describe a tool as a schema plus a `run` function; the Host wants an
 * `execute` plus an `output.render` that turns the value into content blocks. This adapter
 * keeps that difference in one place so no module has to know the wire shape.
 *
 * A failure inside `run` is returned as a normal result with `ok: false` rather than thrown:
 * a tool that throws is a broken turn, while a tool that reports why it refused is a model
 * that can try something else.
 */
function makeToolRegistrar(runtime, logger) {
  const tools = runtime.services.tools;
  if (tools === undefined || typeof tools.register !== 'function') return undefined;

  return (spec) => {
    const definition = {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: {
        schema: { type: 'object' },
        render: (args, value) => [{
          type: 'text',
          text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
        }],
      },
      async execute(args) {
        try {
          const value = await spec.run(args);
          return value === undefined ? { ok: true } : value;
        } catch (error) {
          logger?.('warn')?.(`dsh-mydsh: tool ${spec.name} failed: ${error?.message ?? error}`);
          return { ok: false, reason: 'tool-failed', detail: String(error?.message ?? error) };
        }
      },
    };
    return tools.register(definition);
  };
}

// ── system routes ──────────────────────────────────────────────────────────

function registerSystemRoutes(router, runtime) {
  /**
   * Report the plugin's own visibility posture.
   *
   * A stored settings file that has every module switched off — and the entry placed
   * nowhere — is indistinguishable from "the plugin is broken": no sidebar button, no
   * settings page content, every route answering `{disabled: true}`. That state is legal to
   * ask for but it is almost never what a user means, and once it is persisted there is no
   * surface left to switch it back on. Naming it here gives the health check something to
   * report and a caller a way to notice.
   */
  async function posture() {
    const sections = ['display', 'interface', 'usage', 'toolbox'];
    const states = {};
    for (const section of sections) {
      const values = await runtime.settings.section(section);
      states[section] = values?.enabled === true;
    }
    const display = await runtime.settings.section('display');
    const anyEnabled = Object.values(states).some(Boolean);
    const entryHidden = display?.entry === 'hidden' || display?.enabled !== true;
    return {
      sections: states,
      entry: display?.entry ?? null,
      // The condition worth surfacing: nothing can be reached, so nothing can be turned on.
      unreachable: anyEnabled === false && entryHidden === true,
    };
  }

  router.get('/system/health', async () => ({
    plugin: PLUGIN,
    version: '1.0.0',
    profile: runtime.profileName,
    dataRoot: dataRoot(),
    services: Object.fromEntries(
      Object.entries(runtime.services).map(([key, value]) => [key, value !== undefined]),
    ),
    posture: await posture(),
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
