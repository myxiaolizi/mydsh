/**
 * Shared helpers for the dsh-mydsh Host half.
 *
 * Everything here is deliberately dependency-free: the Host half of this bundle
 * ships as plain ESM and must load in any DSH profile without a build step.
 */
import { mkdir, readFile, readdir, stat, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Envelope version for the persisted settings document. */
export const SETTINGS_VERSION = 1;

/**
 * Resolve the DeepSeek Harness home the same way the harness itself does:
 * `$DSH_HOME` when it holds a non-blank value, otherwise `~/.dsh`.
 *
 * A blank override must never resolve the home to the working directory, so
 * whitespace-only values are treated as absent.
 */
export function resolveDshHome() {
  const configured = process.env.DSH_HOME;
  if (typeof configured === 'string' && configured.trim() !== '') {
    return configured.trim();
  }
  return join(homedir(), '.dsh');
}

/** Directory that owns every artifact this plugin persists. */
export function dataRoot() {
  return join(resolveDshHome(), 'mydsh');
}

/** Monotonic identifiers for records that need one. */
export function newId(prefix = 'id') {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

/** Clamp a number into an inclusive range, tolerating non-finite input. */
export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Coerce to a finite number, else the fallback. */
export function num(value, fallback = 0) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Write JSON atomically: a reader never observes a half-written document. */
export async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(temporary, body, 'utf8');
  try {
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/**
 * Delete temp files left behind by an interrupted atomic write.
 *
 * `writeJsonAtomic` removes its own temp file when the rename fails, but a process that
 * is killed outright — which is what restarting the Host does — never reaches that
 * cleanup. The leftovers are full-size copies of the document, so an index of a few
 * megabytes can accumulate hundreds of megabytes of them over a few restarts.
 *
 * Only files matching this module's own naming pattern are removed, and only when they
 * are older than `maxAgeMs`, so a write happening right now in another process is never
 * deleted.
 */
export async function sweepTempFiles(directory, { maxAgeMs = 10 * 60 * 1000, prefix } = {}) {
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.tmp')) continue;
    if (prefix !== undefined && !name.startsWith(prefix)) continue;
    const path = join(directory, name);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.mtimeMs > cutoff) continue;
      await unlink(path);
      removed += 1;
    } catch {
      // A file that vanished or is locked is not worth failing startup over.
    }
  }
  return removed;
}

/** Read a JSON document, returning `undefined` when it is absent or unreadable. */
export async function readJson(file) {
  try {
    const text = await readFile(file, 'utf8');
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Deep-merge plain objects; arrays and scalars replace wholesale. */
export function mergeDeep(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    merged[key] = isPlainObject(value) && isPlainObject(base[key])
      ? mergeDeep(base[key], value)
      : value;
  }
  return merged;
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Run `task` with a bounded concurrency pool.
 *
 * Backups and usage aggregation both touch many files; an unbounded
 * `Promise.all` over thousands of paths exhausts file handles on Windows.
 */
export async function pool(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
