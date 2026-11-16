/**
 * Usage aggregation over DSH's durable session logs.
 *
 * Every assistant message DSH commits carries a `usage` block, so token
 * accounting needs no provider API and no background scraping: the session log is
 * already the ledger. This module folds those records into the few shapes the
 * dashboard asks for.
 *
 * Aggregation is incremental against a persistent index. A session log is a
 * zstd-compressed JSONL file and one real profile here holds 400 MB across 470
 * sessions, so rescanning after a cache TTL takes tens of seconds — long enough
 * that the first dashboard request would time out. Instead the index records each
 * session's file identity (mtime + size) beside the usage rows already extracted
 * from it, and a refresh re-reads only sessions whose file actually changed. A
 * refresh over an unchanged corpus costs a few hundred `stat` calls.
 */
import { dataRoot, num, pool, readJson, writeJsonAtomic } from '../util.js';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** One in-memory usage record, the atom every aggregate folds. */
function recordFromEvent(sessionId, event, context) {
  const usage = event.data?.usage;
  if (usage === undefined || usage === null) return undefined;
  const message = event.data?.message;
  const source = message?.source ?? {};
  const provider = typeof source.provider === 'string' ? source.provider : 'unknown';
  const model = typeof source.model === 'string' ? source.model : 'unknown';
  const input = num(usage.inputTokens);
  const output = num(usage.outputTokens);
  if (input === 0 && output === 0) return undefined;
  return {
    sessionId,
    seq: event.seq,
    time: event.time,
    provider,
    model,
    input,
    output,
    total: num(usage.totalTokens, input + output),
    cacheRead: num(usage.cacheReadTokens),
    cacheWrite: num(usage.cacheWriteTokens),
    reasoning: num(usage.reasoningTokens),
    workspace: context.workspace ?? null,
    turn: event.data?.turn ?? null,
    step: event.data?.step ?? null,
  };
}

/** Extract usage records from one session log. */
export function recordsFromLog(sessionId, events, context = {}) {
  const out = [];
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue;
    const record = recordFromEvent(sessionId, event, context);
    if (record !== undefined) out.push(record);
  }
  return out;
}

/** Inclusive time window helper; `from`/`to` are epoch milliseconds. */
export function inWindow(record, from, to) {
  return record.time >= from && record.time < to;
}

/** Preset ranges the dashboard offers, resolved against "now". */
export const RANGE_PRESETS = Object.freeze({
  today: () => startOfToday(),
  '3d': () => startOfToday() - 2 * 86_400_000,
  '7d': () => startOfToday() - 6 * 86_400_000,
  '30d': () => startOfToday() - 29 * 86_400_000,
  '90d': () => startOfToday() - 89 * 86_400_000,
  // Everything the index holds. An unknown preset silently falls back to `7d`, so before
  // this existed a caller asking for "all" got a seventh of the history with a plausible
  // total and no hint that anything was missing. Epoch zero predates any real record.
  all: () => 0,
});

export function startOfToday(now = Date.now()) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Resolve a range spec into `{ from, to, bucketMs }`.
 *
 * The bucket size scales with the window so a 90-day chart still draws a
 * readable number of columns instead of 90 unreadable ones.
 *
 * `spec.bucket` overrides that choice. A heatmap needs one cell per calendar day
 * whatever the span, which the scaling rule cannot give it: a quarter becomes weekly
 * buckets, so the calendar would show 13 cells instead of 90.
 */
export function resolveRange(spec, now = Date.now()) {
  if (spec?.kind === 'custom' && Number.isFinite(spec.from) && Number.isFinite(spec.to)) {
    const span = Math.max(1, spec.to - spec.from);
    return { from: spec.from, to: spec.to, bucketMs: pickBucket(span, spec?.bucket), label: 'custom' };
  }
  const preset = typeof spec?.kind === 'string' && spec.kind in RANGE_PRESETS ? spec.kind : '7d';
  const from = RANGE_PRESETS[preset]();
  return { from, to: now, bucketMs: pickBucket(now - from, spec?.bucket), label: preset };
}

const BUCKET_SIZES = Object.freeze({ hour: 3_600_000, day: 86_400_000, week: 604_800_000 });

function pickBucket(spanMs, override) {
  if (typeof override === 'string' && override in BUCKET_SIZES) return BUCKET_SIZES[override];
  const day = 86_400_000;
  if (spanMs <= 2 * day) return 3_600_000;      // hourly for a day or two
  if (spanMs <= 31 * day) return day;           // daily for a month
  if (spanMs <= 92 * day) return 7 * day;       // weekly for a quarter
  return 30 * day;
}

/** Zero-filled bucket skeleton so a chart never has gaps. */
export function bucketize(from, to, bucketMs) {
  const buckets = [];
  for (let start = from; start < to; start += bucketMs) {
    buckets.push({ start, end: Math.min(start + bucketMs, to), input: 0, output: 0, total: 0, calls: 0, cost: 0 });
  }
  return buckets;
}

/**
 * Fold records into totals plus grouped breakdowns.
 *
 * `groupBy` is one of the dashboard dimensions. Grouping is a single pass per
 * dimension rather than one pass per group, which keeps a large corpus linear.
 */
export function aggregate(records, { from, to, bucketMs, groupBy = 'provider', costOf } = {}) {
  const totals = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0, cost: 0 };
  const groups = new Map();
  const buckets = bucketize(from, to, bucketMs);
  const bucketIndex = (time) => {
    if (bucketMs <= 0) return -1;
    const index = Math.floor((time - from) / bucketMs);
    return index >= 0 && index < buckets.length ? index : -1;
  };

  for (const record of records) {
    if (!inWindow(record, from, to)) continue;
    const cost = costOf === undefined ? 0 : (costOf(record)?.amount ?? 0);

    totals.input += record.input;
    totals.output += record.output;
    totals.total += record.total;
    totals.cacheRead += record.cacheRead;
    totals.cacheWrite += record.cacheWrite;
    totals.reasoning += record.reasoning;
    totals.calls += 1;
    totals.cost += cost;

    const key = groupKey(record, groupBy);
    const group = groups.get(key) ?? {
      key, input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, calls: 0, cost: 0,
    };
    group.input += record.input;
    group.output += record.output;
    group.total += record.total;
    group.cacheRead += record.cacheRead;
    group.cacheWrite += record.cacheWrite;
    group.calls += 1;
    group.cost += cost;
    groups.set(key, group);

    const index = bucketIndex(record.time);
    if (index >= 0) {
      const bucket = buckets[index];
      bucket.input += record.input;
      bucket.output += record.output;
      bucket.total += record.total;
      bucket.calls += 1;
      bucket.cost += cost;
    }
  }

  return {
    range: { from, to, bucketMs },
    totals,
    groups: [...groups.values()].sort((a, b) => b.total - a.total),
    buckets,
  };
}

function groupKey(record, groupBy) {
  switch (groupBy) {
    case 'model': return record.model;
    case 'session': return record.sessionId;
    case 'workspace': return record.workspace ?? '(none)';
    case 'provider':
    default: return record.provider;
  }
}

/**
 * Index format version; a mismatch discards the cache rather than misreading it.
 *
 * Bumped to 5 when the string fields became indexes into a shared table. An old file is
 * discarded and rebuilt once, which is the same cost it would have paid to parse it.
 */
const INDEX_VERSION = 5;

/**
 * Field order for the compact on-disk record encoding.
 *
 * At 73,000 records a plain JSON array of objects spends most of its bytes on
 * repeated field names — roughly 30 MB, which is slow to parse on every start. Storing
 * each record as a positional array instead strips that redundancy while keeping
 * the format inspectable and version-tagged.
 */
const FIELDS = ['seq', 'time', 'provider', 'model', 'input', 'output', 'total', 'cacheRead', 'cacheWrite', 'reasoning', 'workspace', 'turn', 'step'];

/**
 * How many context points to return for the trend.
 *
 * A session can run to hundreds of turns; the last 60 show the shape of the growth
 * without shipping a large payload for every panel open.
 */
const HISTORY_LIMIT = 60;

/**
 * Encode one record as a positional array, dropping trailing nulls.
 *
 * Most records leave the tail of `FIELDS` empty — cache counters and turn
 * numbers are optional on the wire — so trailing nulls are pure overhead at this
 * scale. Rows are padded back to full length on decode, which is why the trailing
 * padding carries no information.
 *
 * The three string fields (`provider`, `model`, `workspace`) repeat heavily: a session
 * uses one working directory and a handful of models, yet each of 73k rows spelled them
 * out. They are written as indexes into a per-file string table and expanded back on
 * decode, which is what keeps the index from growing to tens of megabytes — and parsing
 * that JSON was the bulk of the cold-start cost.
 */
const POOLED_FIELDS = new Set(['provider', 'model', 'workspace']);

function encodeRecord(record, pool) {
  const values = FIELDS.map((field) => {
    const value = record[field] ?? null;
    if (value === null || !POOLED_FIELDS.has(field)) return value;
    const key = String(value);
    let index = pool.index.get(key);
    if (index === undefined) {
      index = pool.values.length;
      pool.values.push(key);
      pool.index.set(key, index);
    }
    return index;
  });
  while (values.length > 0 && values[values.length - 1] === null) values.pop();
  return values;
}

function decodeRecord(sessionId, values, strings) {
  const record = { sessionId };
  for (let i = 0; i < FIELDS.length; i += 1) {
    const value = values[i] ?? null;
    // A pooled field is an index into the file's string table; anything else is literal.
    // A missing table means an older file, which wrote the strings inline.
    if (value !== null && POOLED_FIELDS.has(FIELDS[i]) && Array.isArray(strings)) {
      record[FIELDS[i]] = strings[value] ?? null;
    } else {
      record[FIELDS[i]] = value;
    }
  }
  // Fields the aggregate does arithmetic on must be numbers, never null.
  for (const field of ['seq', 'time', 'input', 'output', 'total', 'cacheRead', 'cacheWrite', 'reasoning']) {
    record[field] = num(record[field]);
  }
  return record;
}

/**
 * Locate every persisted session log under a DSH home.
 *
 * The layout is `sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd`.
 * Walking it directly is what makes staleness detection cheap: one `stat` per
 * session instead of one full read. Sessions that exist only live have no file and
 * are skipped; their usage arrives once persisted.
 */
async function listSessionFiles(dshHome) {
  const root = join(dshHome, 'sessions');
  const files = [];
  let buckets;
  try {
    buckets = await readdir(root, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    const bucketPath = join(root, bucket.name);
    let sessions;
    try {
      sessions = await readdir(bucketPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      // The directory name is the session id, which is what `readSession` wants.
      const logPath = join(bucketPath, session.name, 'session.v4.jsonl.zstd');
      try {
        const info = await stat(logPath);
        if (!info.isFile()) continue;
        // `mtimeMs` is a float with sub-millisecond digits, and JSON round-tripping
        // it through a text file is not bit-exact. Truncating to whole milliseconds
        // makes the identity comparison survive persistence; otherwise every session
        // looks changed on the next start and the corpus is re-read in full — the
        // exact cost this index exists to avoid.
        files.push({ id: session.name, path: logPath, mtimeMs: Math.trunc(info.mtimeMs), size: info.size });
      } catch {
        // A session directory without the expected log name is not a session.
      }
    }
  }
  return files;
}

/**
 * Load and cache usage across the whole corpus, incrementally.
 *
 * The expensive part is reading (and decompressing) session logs, so each
 * session's extracted rows are kept beside the file identity they came from. A
 * refresh then costs one `stat` per session plus a read only for the sessions that
 * moved.
 */
export class UsageStore {
  #sessionQuery;
  #dshHome;
  #logger;
  #index;
  /** Logs this corpus rejected, keyed by id and pinned to the file identity tried. */
  #unreadable;
  #indexLoaded;
  #loading;
  #lastScanAt = 0;
  #stats = { scans: 0, reads: 0, reused: 0, skipped: 0, lastMs: 0 };

  constructor({ sessionQuery, dshHome, workspaceDirOf, logger }) {
    this.#sessionQuery = sessionQuery;
    this.#dshHome = dshHome ?? dataRoot();
    this.#workspaceDirOf = workspaceDirOf;
    this.#logger = logger;
    this.#index = new Map();
    this.#unreadable = new Map();
  }

  #workspaceDirOf;

  /** Diagnostics for the settings panel: how much work the last refresh did. */
  get stats() {
    return { ...this.#stats, indexed: this.#index?.size ?? 0 };
  }

  /** Drop the cache so the next read rescans immediately, bypassing the cooldown. */
  invalidate() {
    this.#lastScanAt = 0;
  }

  /**
   * Forget one session, so its growth is re-read on the next refresh.
   *
   * The cooldown is cleared too: a committed message is exactly the event that makes
   * the cached answer wrong, so waiting out the window would show stale totals.
   */
  invalidateSession(sessionId) {
    this.#index?.delete(sessionId);
    // Also lift a previous rejection: a session that just committed a message is
    // worth re-reading, and leaving it blocked would hide the new usage.
    this.#unreadable?.delete(sessionId);
    this.#lastScanAt = 0;
  }

  /**
   * All usage records, refreshing the index when it is stale.
   *
   * Concurrent callers share one refresh, so a dashboard that fires several
   * requests on mount still performs a single scan. Every call rechecks file
   * identities, which costs a directory walk plus one `stat` per session — tens of
   * milliseconds — while reading a log costs orders of magnitude more. Checking
   * on every call keeps a changed session visible immediately; caching the answer
   * for a few seconds would show stale totals instead.
   */
  async load() {
    if (this.#loading !== undefined) return this.#loading;
    this.#loading = this.#refresh()
      .finally(() => {
        this.#loading = undefined;
      });
    return this.#loading;
  }

  /** Records loaded before the last refresh, without touching disk. */
  peek() {
    const records = [];
    for (const entry of this.#index.values()) records.push(...entry.records);
    records.sort((a, b) => a.time - b.time);
    return records;
  }

  async #refresh() {
    const started = Date.now();
    await this.#loadIndex();
    const files = await listSessionFiles(this.#dshHome);

    const seen = new Set();
    let reads = 0;
    let reused = 0;
    const changed = [];

    for (const file of files) {
      seen.add(file.id);
      const entry = this.#index.get(file.id);
      if (entry !== undefined && entry.mtimeMs === file.mtimeMs && entry.size === file.size) {
        reused += 1;
        continue;
      }
      // A log this corpus cannot resolve is remembered against its exact file
      // identity. Without this, a session that `readSession` refuses would be
      // retried on every single refresh, and a handful of them is enough to turn
      // each request into seconds of wasted IO.
      const failed = this.#unreadable.get(file.id);
      if (failed !== undefined && failed.mtimeMs === file.mtimeMs && failed.size === file.size) {
        reused += 1;
        continue;
      }
      changed.push(file);
    }

    // Sessions whose file disappeared are gone from the ledger.
    for (const id of [...this.#index.keys()]) {
      if (!seen.has(id)) this.#index.delete(id);
    }
    for (const id of [...this.#unreadable.keys()]) {
      if (!seen.has(id)) this.#unreadable.delete(id);
    }

    if (changed.length > 0 && this.#sessionQuery !== undefined) {
      const extracted = await pool(changed, 4, async (file) => {
        try {
          const log = await this.#sessionQuery.readSession(file.id);
          const workspace = log?.session?.cwd ?? this.#workspaceDirOf?.(log) ?? null;
          return {
            file,
            records: recordsFromLog(file.id, log?.events ?? [], { workspace }),
          };
        } catch {
          // One unreadable log must not fail the whole aggregate. When a previous
          // read succeeded, keep those rows so a transient failure does not erase
          // history; on a first sighting there is nothing to keep, and storing an
          // empty entry would wrongly claim the session has no usage.
          const previous = this.#index.get(file.id);
          return { file, records: previous?.records, failed: true };
        }
      });

      for (const result of extracted) {
        if (result.failed === true) {
          // Remember the rejection against this exact file identity so the next
          // refresh skips it instead of retrying. A log that changes gets another
          // chance, which is what lets a repaired or newly-imported log appear.
          this.#unreadable.set(result.file.id, {
            mtimeMs: result.file.mtimeMs,
            size: result.file.size,
          });
        }
        // `failed` with no previous rows means this session contributes nothing and
        // stays out of the index; the entry above stops it from being re-read.
        if (result.records === undefined) continue;
        // A successful read clears any earlier rejection, so the diagnostics report
        // what is still unreadable rather than what once was.
        this.#unreadable.delete(result.file.id);
        reads += 1;
        this.#index.set(result.file.id, {
          mtimeMs: result.file.mtimeMs,
          size: result.file.size,
          records: result.records,
        });
      }
    }

    this.#lastScanAt = Date.now();
    this.#stats = {
      scans: this.#stats.scans + 1,
      reads: this.#stats.reads + reads,
      reused: reused,
      skipped: this.#unreadable.size,
      lastMs: this.#lastScanAt - started,
    };

    // Persist only when something moved, so an idle refresh writes nothing.
    if (reads > 0 || changed.length > 0) await this.#saveIndex();

    return this.peek();
  }

  async #loadIndex() {
    if (this.#indexLoaded === true) return;
    this.#indexLoaded = true;
    if (this.#index.size > 0) return;

    const path = this.#indexPath();
    const stored = await readJson(path, undefined).catch(() => undefined);
    if (stored === undefined || stored === null) return;
    if (stored.sessions === null || typeof stored.sessions !== 'object') return;
    // A stored field order that differs from this build means the rows cannot be
    // interpreted; discard rather than guess.
    if (Array.isArray(stored.fields) && stored.fields.join(',') !== FIELDS.join(',')) return;

    // Version 4 stored the pooled strings inline. It is readable by this build — pass no
    // table and every field decodes as literal — so it is adopted and rewritten in the new
    // shape on the next save. Discarding it instead would force a full re-read of every
    // session log, which on a real corpus is minutes rather than seconds.
    const strings = stored.version === INDEX_VERSION && Array.isArray(stored.strings)
      ? stored.strings
      : undefined;
    const readable = stored.version === INDEX_VERSION || stored.version === 4;
    if (!readable) return;

    for (const [id, entry] of Object.entries(stored.sessions)) {
      if (typeof entry?.mtimeMs !== 'number' || !Array.isArray(entry.records)) continue;
      const records = [];
      for (const values of entry.records) {
        if (Array.isArray(values)) records.push(decodeRecord(id, values, strings));
      }
      this.#index.set(id, { mtimeMs: entry.mtimeMs, size: entry.size ?? 0, records });
    }

    // Rejections persist too. A corpus can hold logs this profile cannot resolve —
    // a session archived elsewhere, or a directory left by another install — and
    // retrying them after every restart would pay the same cost again.
    const skipped = stored.unreadable;
    if (skipped !== null && typeof skipped === 'object') {
      for (const [id, entry] of Object.entries(skipped)) {
        if (typeof entry?.mtimeMs !== 'number') continue;
        this.#unreadable.set(id, { mtimeMs: entry.mtimeMs, size: entry.size ?? 0 });
      }
    }
  }

  async #saveIndex() {
    // Records are stored positionally and tagged with the field order, so a future
    // field addition shows up as a version change rather than silent corruption.
    // One string table is shared by the whole file: the pooled values repeat across
    // sessions as well as rows, so a per-session table would waste most of the saving.
    const pool = { index: new Map(), values: [] };
    const sessions = {};
    for (const [id, entry] of this.#index) {
      sessions[id] = {
        mtimeMs: entry.mtimeMs,
        size: entry.size,
        records: entry.records.map((record) => encodeRecord(record, pool)),
      };
    }
    const unreadable = {};
    for (const [id, entry] of this.#unreadable) {
      unreadable[id] = { mtimeMs: entry.mtimeMs, size: entry.size };
    }
    try {
      await writeJsonAtomic(this.#indexPath(), {
        version: INDEX_VERSION,
        fields: FIELDS,
        strings: pool.values,
        savedAt: Date.now(),
        sessions,
        unreadable,
      });
    } catch (error) {
      // A failed cache write costs time on the next start, never correctness.
      this.#logger?.('warn')?.(`dsh-mydsh: cannot persist the usage index: ${error?.message ?? error}`);
    }
  }

  #indexPath() {
    // The index describes the sessions under one specific DSH home, so it must
    // live beside that home. Hanging it off the process-wide data root would let
    // two profiles share one index and read each other's totals.
    return join(this.#dshHome, 'mydsh', 'usage-index.json');
  }
}

/**
 * Context-window insight for one session.
 *
 * "How full is the context" is the question users actually ask when a turn
 * starts truncating, so report the last request's prompt size against the
 * model's declared window rather than a raw token dump.
 */
export function contextInsight(events, contextWindow) {
  let lastPrompt = 0;
  let lastTime = 0;
  let turn = 0;

  // The per-turn series is what makes the number useful: a single figure says how full
  // the window is now, while the series shows whether it is climbing toward a compaction
  // or stable. Kept to the last `HISTORY_LIMIT` points so a long session stays cheap.
  const history = [];
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue;
    const usage = event.data?.usage;
    if (usage === undefined) continue;
    const prompt = num(usage.inputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens);
    if (prompt > 0) {
      lastPrompt = prompt;
      lastTime = event.time;
      turn = event.data?.turn ?? turn;
      history.push({ time: event.time, turn, prompt });
    }
  }
  const series = history.slice(-HISTORY_LIMIT);

  const ratio = typeof contextWindow === 'number' && contextWindow > 0 ? lastPrompt / contextWindow : undefined;
  const windowFor = typeof contextWindow === 'number' ? contextWindow : null;
  return {
    promptTokens: lastPrompt,
    contextWindow: windowFor,
    ratio: ratio ?? null,
    lastTime,
    turn,
    // A peak matters as much as the latest value: the window may have been full before a
    // compaction reset it, and that is the number that explains a slowdown.
    peakPrompt: series.reduce((peak, point) => Math.max(peak, point.prompt), 0),
    points: series.map((point) => ({
      time: point.time,
      turn: point.turn,
      prompt: point.prompt,
      ratio: windowFor === null || windowFor <= 0 ? null : point.prompt / windowFor,
    })),
  };
}
