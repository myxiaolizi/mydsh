/**
 * Backup engine: compose sources into an archive, then publish it to every
 * configured destination.
 *
 * The job is deliberately sequential and observable. A backup that runs while
 * the user watches must report progress it can act on, and a failure must name
 * the stage that failed rather than surfacing a generic error. Each run therefore
 * walks an explicit pipeline and records a step log.
 *
 * Incremental is a filter, not a different archive shape: the writer still emits
 * one self-contained archive, but only entries changed since the previous run go
 * in. That keeps restore trivial — the newest archive alone is sufficient — while
 * making daily runs cheap on a large workspace.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  archivePathFor,
  assertZipCapacity,
  hashFile,
  listFiles,
  splitFile,
  ZipWriter,
  runSevenZip,
} from './archive.js';
import { destinationFrom } from './destinations.js';
import { newId, pool } from '../util.js';

/** Ordered stages, so a failure names the step a user can act on. */
export const STAGES = Object.freeze(['prepare', 'collect', 'archive', 'upload', 'prune', 'done']);

/** Files that never belong in a backup archive. */
const EXCLUDED_PATTERNS = [
  /[\\/]node_modules[\\/]\.cache[\\/]/i,
  /[\\/]\.git[\\/]/i,
  /[\\/]cache[\\/]/i,
  /[\\/]tmp[\\/]/i,
  /\.log$/i,
  /\.partial$/i,
];

function isExcluded(path) {
  return EXCLUDED_PATTERNS.some((pattern) => pattern.test(path));
}

export class BackupEngine {
  #settings;
  #sources;
  #logger;
  #secrets;
  #state;
  #running;
  #history = [];

  constructor({ settings, sources, logger, secrets, state }) {
    this.#settings = settings;
    this.#sources = sources;
    this.#logger = logger;
    this.#secrets = secrets;
    this.#state = state;
  }

  /** Whether a job is in flight; a second job is refused rather than interleaved. */
  get busy() {
    return this.#running !== undefined;
  }

  /** Recent runs, newest first, for the dashboard. */
  history(limit = 20) {
    return this.#history.slice(0, limit);
  }

  /**
   * Run one backup.
   *
   * `trigger` is recorded so the history explains why a run happened.
   */
  async run({ trigger = 'manual', config } = {}) {
    if (this.#running !== undefined) {
      return { ok: false, reason: 'already-running', id: this.#running.id };
    }
    const runId = newId('backup');
    const steps = [];
    const startedAt = Date.now();
    const record = { id: runId, trigger, startedAt, steps, status: 'running' };
    this.#running = record;
    if (this.#history.length > 40) this.#history.length = 40;

    const step = (name, detail) => {
      steps.push({ name, at: Date.now(), detail });
    };

    try {
      const effective = config ?? (await this.#settings.section('backup'));
      if (effective.enabled !== true && trigger !== 'manual') {
        throw new Error('backup module is disabled');
      }

      const selected = Object.entries(effective.items ?? {}).filter(([, on]) => on === true).map(([key]) => key);
      // Record the stage before validating it, so a failure here names `prepare`
      // rather than appearing to happen nowhere.
      step('prepare', { items: selected, format: effective.archive?.format ?? 'zip' });
      if (selected.length === 0) throw new Error('no backup items selected');

      // ── collect ───────────────────────────────────────────────────────────
      const plan = [];
      for (const key of selected) {
        const source = this.#sources[key];
        if (source === undefined) continue;
        const roots = source.roots === undefined ? [] : await source.roots();
        const files = source.files === undefined ? [] : await source.files();
        const collected = [];
        for (const file of files) {
          if (!isExcluded(file)) collected.push({ diskPath: file, prefix: key, root: undefined });
        }
        for (const root of roots) {
          const listed = await listFiles(root);
          for (const file of listed) {
            if (isExcluded(file)) continue;
            collected.push({ diskPath: file, prefix: key, root });
          }
        }
        plan.push({ key, source, entries: collected });
      }

      const totalEntries = plan.reduce((sum, group) => sum + group.entries.length, 0);
      if (totalEntries === 0) throw new Error('selected items contain no files');
      step('collect', { entries: totalEntries, groups: plan.map((g) => ({ key: g.key, entries: g.entries.length })) });

      // ── incremental filter ────────────────────────────────────────────────
      let entries = plan.flatMap((group) => group.entries.map((entry) => ({ ...entry })));
      const incremental = effective.archive?.incremental === true;
      let skipped = 0;
      // The watermark is the newest file timestamp this run actually saw, not the moment
      // the run started. Comparing file times against a wall-clock start is unreliable:
      // `mtimeMs` has a fractional part while the start was an integer, so a file written
      // just before the run looked newer than the run and every run archived everything.
      // Even after truncating to whole milliseconds a file written in the same millisecond
      // as the start still compared as "changed", so the skip was intermittent. Tracking
      // the newest observed timestamp instead puts both sides on the same clock.
      let newest = Math.trunc(this.#state.lastBackupAt ?? 0);
      if (incremental) {
        const previous = Math.trunc(this.#state.lastBackupAt ?? 0);
        const filtered = [];
        for (const entry of entries) {
          const info = await stat(entry.diskPath).catch(() => undefined);
          if (info === undefined) continue;
          const stamp = Math.trunc(info.mtimeMs);
          if (stamp > newest) newest = stamp;
          if (stamp > previous) filtered.push(entry);
          else skipped += 1;
        }
        entries = filtered;
        if (entries.length === 0) {
          // Nothing changed is a success, not a failure: writing an empty archive
          // would consume a retention slot for no reason.
          step('archive', { skipped: 'no changes since the previous run', incremental: true });
          record.status = 'skipped';
          record.finishedAt = Date.now();
          this.#history.unshift(record);
          return { ok: true, id: runId, skipped: true, reason: 'no-changes', record };
        }
      }

      // ── archive ───────────────────────────────────────────────────────────
      const workspace = join(tmpdir(), 'mydsh-backup', runId);
      await mkdir(workspace, { recursive: true });
      const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const format = effective.archive?.format === '7z' ? '7z' : 'zip';
      const baseName = `mydsh-backup-${stamp}`;

      let archivePath;
      let bytes;
      if (format === 'zip') {
        const totalBytes = await Promise.all(
          entries.map(async (entry) => (await stat(entry.diskPath).catch(() => ({ size: 0 }))).size),
        ).then((sizes) => sizes.reduce((a, b) => a + b, 0));
        assertZipCapacity(totalBytes);
        archivePath = join(workspace, `${baseName}.zip`);
        const writer = await ZipWriter.create(archivePath);
        try {
          const level = effective.archive?.level ?? 6;
          await pool(entries, 4, async (entry) => {
            const archiveName = entry.root === undefined
              ? `${entry.prefix}/${entry.diskPath.split(/[\\/]/).pop()}`
              : archivePathFor(entry.root, entry.diskPath, entry.prefix);
            await writer.addFile(entry.diskPath, archiveName, { level });
          });
          await writer.addBuffer('manifest.json', Buffer.from(JSON.stringify({
            runId,
            createdAt: new Date(startedAt).toISOString(),
            trigger,
            entries: entries.length,
            skipped,
            incremental,
            items: selected,
          }, null, 2), 'utf8'));
          await writer.close();
        } catch (error) {
          await writer.abort();
          throw error;
        }
        bytes = (await stat(archivePath)).size;
      } else {
        const sevenZip = await this.#resolveSevenZip();
        if (sevenZip === undefined) {
          throw new Error('7z was requested but no 7z binary is available; switch the format to zip or install 7z');
        }
        archivePath = join(workspace, `${baseName}.7z`);
        // Build a staging tree so the archive layout stays a mirror of the
        // source prefixes rather than a list of absolute paths the binary would
        // mangle. 7z stores entries relative to the wildcard's parent, so the
        // staged tree root becomes the archive root.
        const staging = join(workspace, 'staging');
        await mkdir(staging, { recursive: true });
        const { copyFile } = await import('node:fs/promises');
        for (const entry of entries) {
          const archiveName = entry.root === undefined
            ? `${entry.prefix}/${entry.diskPath.split(/[\\/]/).pop()}`
            : archivePathFor(entry.root, entry.diskPath, entry.prefix);
          // Archive separators are forward slashes; the filesystem needs native
          // ones, which `join` normalizes for us.
          const target = join(staging, ...archiveName.split('/'));
          await mkdir(dirname(target), { recursive: true });
          await copyFile(entry.diskPath, target);
        }
        const level = effective.archive?.level ?? 6;
        // `-bso0`/`-bsp0` keep the binary's progress output off the Host's log;
        // a backup of thousands of files would otherwise flood it.
        const args = ['a', '-t7z', `-mx=${Math.max(0, Math.min(9, level))}`, '-y', '-bso0', '-bsp0', archivePath, join(staging, '*')];
        if (effective.archive?.encrypt === true) {
          const password = await this.#secrets.get?.('backup.password');
          if (typeof password === 'string' && password !== '') {
            // `-p` with `-mhe=on` also encrypts the file names, which is what a
            // password-protected backup should mean.
            args.push(`-p${password}`, '-mhe=on');
          } else {
            throw new Error('encryption is enabled but no backup password is stored');
          }
        }
        const outcome = await runSevenZip(sevenZip, args);
        if (!outcome.ok) throw new Error(`7z failed: ${outcome.detail ?? outcome.reason}`);
        await rm(staging, { recursive: true, force: true });
        bytes = (await stat(archivePath)).size;
      }

      const digest = await hashFile(archivePath);
      step('archive', { path: archivePath, bytes, format, hash: digest.slice(0, 16), entries: entries.length, skipped });

      // ── split ─────────────────────────────────────────────────────────────
      const splitMb = Number(effective.archive?.splitSizeMb ?? 0);
      let uploadFiles = [archivePath];
      if (splitMb > 0) {
        const parts = await splitFile(archivePath, splitMb * 1024 * 1024, workspace);
        if (parts.length > 0) {
          uploadFiles = parts;
          step('archive', { splitInto: parts.length, partBytes: splitMb * 1024 * 1024 });
        }
      }

      // ── upload ────────────────────────────────────────────────────────────
      const destinations = Array.isArray(effective.destinations) ? effective.destinations : [];
      const results = [];
      for (const config of destinations) {
        if (config?.enabled === false) continue;
        const secrets = (await this.#secrets.forDestination?.(config)) ?? {};
        const destination = destinationFrom(config, secrets);
        const ready = await destination.ready();
        if (!ready.ok) {
          results.push({ kind: destination.kind, ok: false, reason: ready.reason, detail: ready.detail });
          continue;
        }
        try {
          const uploaded = [];
          for (const file of uploadFiles) uploaded.push(await destination.put(file));
          results.push({ kind: destination.kind, ok: true, uploaded });
        } catch (error) {
          results.push({ kind: destination.kind, ok: false, reason: 'upload-failed', detail: String(error?.message ?? error) });
        }
      }
      step('upload', results);
      if (results.length > 0 && results.every((result) => result.ok === false)) {
        throw new Error(`every destination failed: ${results.map((r) => `${r.kind}:${r.reason}`).join(', ')}`);
      }

      // ── prune ─────────────────────────────────────────────────────────────
      const pruned = [];
      for (const config of destinations) {
        if (config?.enabled === false) continue;
        const secrets = (await this.#secrets.forDestination?.(config)) ?? {};
        const destination = destinationFrom(config, secrets);
        try {
          pruned.push({ kind: destination.kind, removed: await destination.prune(config.keepCopies) });
        } catch {
          // Retention failing must not fail the backup: the new copy is already safe.
          pruned.push({ kind: destination.kind, removed: [], failed: true });
        }
      }
      step('prune', pruned);

      record.status = results.some((r) => r.ok) ? 'succeeded' : 'partial';
      record.finishedAt = Date.now();
      record.bytes = bytes;
      record.hash = digest;
      record.destinations = results;
      record.durationMs = record.finishedAt - startedAt;
      step('done', { durationMs: record.durationMs });

      // Store the newest timestamp seen, so the next run's comparison is against a value
      // taken from the same clock as the file times.
      this.#state.lastBackupAt = newest > 0 ? newest : startedAt;
      this.#history.unshift(record);
      this.#logger?.('info')?.(`dsh-mydsh: backup ${runId} ${record.status} in ${record.durationMs}ms (${(bytes / 1024 / 1024).toFixed(1)} MiB)`);

      // The staging archive is intentionally kept: it is the only copy when every
      // remote destination failed, and the user can point a local destination at
      // the same run.
      return { ok: true, id: runId, record };
    } catch (error) {
      record.status = 'failed';
      record.finishedAt = Date.now();
      record.error = String(error?.message ?? error);
      step('done', { error: record.error });
      this.#history.unshift(record);
      this.#logger?.('error')?.(`dsh-mydsh: backup ${runId} failed: ${record.error}`);
      return { ok: false, id: runId, error: record.error, record };
    } finally {
      this.#running = undefined;
    }
  }

  /**
   * Locate a 7z binary.
   *
   * Order: the bundled binary for this architecture, then `7z`/`7za` on PATH. The
   * bundle wins because it makes the format work without a system install; the
   * PATH lookup covers users who already have 7-Zip and prefer not to duplicate
   * 1.3 MB.
   *
   * The bundled binaries are GPL-licensed; `vendor/7z/License.txt` ships beside
   * them and is copied into this package's LICENSE notes.
   */
  async #resolveSevenZip() {
    const arch = process.arch === 'ia32' ? 'x86' : 'x64';
    // This module lives at lib/host/backup/, so the package root is three levels
    // up. Getting this wrong is silent: the format simply reports "unavailable".
    const bundled = fileURLToPath(new URL(`../../../vendor/7z/${arch}/7za.exe`, import.meta.url));

    const bundledInfo = await stat(bundled).catch(() => undefined);
    if (bundledInfo?.isFile() === true) return bundled;

    // Non-Windows hosts cannot use the bundled .exe, so fall straight through.
    for (const name of process.platform === 'win32' ? ['7z', '7za'] : ['7z', '7za', '7zz']) {
      const probe = await runSevenZip(name, ['i']);
      if (probe.ok) return name;
    }
    return undefined;
  }
}
