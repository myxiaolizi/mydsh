/**
 * Backup panel.
 *
 * Backup is the one module where a wrong click loses data, so the panel leads
 * with what will be included and where it will go, and only then offers the run
 * button. Every selection is a checkbox the user can see, not an implicit default.
 *
 * Every user-facing string is resolved through `usePanelT`, so the panel follows
 * DSH's active language. Host machine values — a run's trigger, a status id, a
 * destination kind — stay as ids and are translated only for display, so nothing
 * written back to settings changes with the language.
 */
import React from 'react';
import { Badge, Card, Empty, Segments, Stat, formatBytes, formatRelative } from './ui.js';
import { api, useAsync } from './data.js';
import { useSettings } from './settings-page.js';
import { useT } from './i18n-react.js';

const h = React.createElement;

/**
 * The panel's translate function.
 *
 * The panel's strings live in the shared `i18n.js` dictionary, so this is a thin
 * alias of `useT`. It is kept as a named helper because every call site in this
 * panel already reads through it, and one name is easier to follow than importing
 * the hook in a dozen places.
 */
function usePanelT() {
  return useT();
}

/**
 * Source items, mirroring the Host source table.
 *
 * `key` is what the Host reads; labels and hints are localization keys, so a
 * language switch never changes which items are included.
 */
const ITEMS = [
  { key: 'workspaces', labelKey: 'backup.workspaces', hintKey: 'backup.hintWorkspaces' },
  { key: 'conversations', labelKey: 'backup.conversations', hintKey: 'backup.hintConversations' },
  { key: 'systemConfig', labelKey: 'backup.systemConfig', hintKey: 'backup.hintSystemConfig' },
  { key: 'plugins', labelKey: 'backup.plugins', hintKey: 'backup.hintPlugins' },
  { key: 'extras', labelKey: 'backup.extras', hintKey: 'backup.hintExtras' },
  { key: 'models', labelKey: 'backup.models', hintKey: 'backup.hintModels' },
];

const TRIGGERS = [
  { key: 'scheduled', labelKey: 'backup.scheduled', hintKey: 'backup.hintScheduled' },
  { key: 'afterSession', labelKey: 'backup.afterSession', hintKey: 'backup.hintAfterSession' },
  { key: 'onStartup', labelKey: 'backup.onStartup', hintKey: 'backup.hintOnStartup' },
];

/** Archive formats. `ZIP` and `7z` are the values the Host accepts, shown verbatim. */
const FORMATS = [
  { value: 'zip', label: 'ZIP' },
  { value: '7z', label: '7z' },
];

/** Translate a destination kind. */
function kindLabel(t, kind) {
  if (kind === 'webdav') return t('backup.webdav');
  if (kind === 'oss') return t('backup.oss');
  return t('backup.local');
}

/** Translate a run trigger id; an unknown id stays visible rather than blank. */
function triggerLabel(t, trigger) {
  if (trigger === 'manual') return t('backup.triggerManual');
  if (trigger === 'after-session') return t('backup.afterSession');
  if (trigger === 'startup') return t('backup.onStartup');
  if (trigger === 'scheduled') return t('backup.scheduled');
  return trigger ?? '';
}

/** Translate a run or step status id; an unknown id stays visible rather than blank. */
function statusLabel(t, status) {
  if (status === 'succeeded') return t('common.success');
  if (status === 'failed') return t('common.failed');
  if (status === 'skipped') return t('backup.statusSkipped');
  if (status === 'done') return t('backup.stage.done');
  if (status === 'running') return t('common.running');
  return status ?? '';
}

export function BackupPanel() {
  const t = usePanelT();
  const { settings, update } = useSettings();
  const config = settings?.backup ?? {};
  const enabled = config.enabled === true;
  const items = config.items ?? {};
  const triggers = config.triggers ?? {};
  const archive = config.archive ?? {};
  const destinations = Array.isArray(config.destinations) ? config.destinations : [];

  const status = useAsync(() => api.backup(), [], { immediate: enabled });
  const [running, setRunning] = React.useState(false);
  const [result, setResult] = React.useState(undefined);

  const selectedCount = ITEMS.filter((item) => items[item.key] === true).length;

  const runNow = async () => {
    setRunning(true);
    setResult(undefined);
    try {
      const outcome = await api.backupRun();
      setResult(outcome);
      status.reload();
    } catch (error) {
      // The machine code travels with the message so the render side can localize
      // a transport failure instead of printing the Host's English detail.
      setResult({ ok: false, error: error?.message ?? String(error), code: error?.code });
    } finally {
      setRunning(false);
    }
  };

  const toggleItem = (key) => update('backup', { items: { ...items, [key]: items[key] !== true } });
  const toggleTrigger = (key) => update('backup', { triggers: { ...triggers, [key]: triggers[key] !== true } });
  const patchArchive = (patch) => update('backup', { archive: { ...archive, ...patch } });

  const addDestination = () => {
    update('backup', {
      destinations: [...destinations, { kind: 'local', directory: '', keepCopies: 7, enabled: true, id: `dest_${Date.now()}` }],
    });
  };

  const patchDestination = (index, patch) => {
    update('backup', {
      destinations: destinations.map((entry, position) => (position === index ? { ...entry, ...patch } : entry)),
    });
  };

  const removeDestination = (index) => {
    update('backup', { destinations: destinations.filter((_, position) => position !== index) });
  };

  return h('div', { className: 'mydsh-stack', style: { gap: 'var(--mydsh-space-4)' } },
    // Configuration lives on the settings tab. This page keeps the two things that are not
    // configuration: what is about to be archived, and what happened last time.
    enabled !== true
      ? h(Card, null, h(Empty, { title: t('backup.disabledTitle'), hint: t('settings.whereHint') }))
      : h(React.Fragment, null,
      // ── run card ─────────────────────────────────────────────────────────
      h(Card, {
        title: t('backup.runCard'),
        description: selectedCount === 0
          ? t('backup.runHintEmpty')
          : t('backup.runSummary', { n: selectedCount, m: destinations.length }),
        actions: h('div', { className: 'mydsh-inline' },
          h('button', {
            type: 'button',
            className: 'mydsh-btn mydsh-btn-primary',
            disabled: running || selectedCount === 0 || destinations.length === 0,
            onClick: runNow,
          }, running ? t('backup.running') : t('backup.run')),
        ),
      },
        status.data?.busy === true ? h('p', { className: 'mydsh-hint' }, t('backup.busyHint')) : null,
        result !== undefined ? h(RunResult, { result }) : null,
        status.data?.lastBackupAt > 0
          ? h('p', { className: 'mydsh-hint' }, `${t('backup.lastBackup')} ${formatRelative(status.data.lastBackupAt, Date.now(), t)}`)
          : h('p', { className: 'mydsh-hint' }, t('backup.noRunsYet')),
        selectedCount === 0 ? h('p', { className: 'mydsh-notice' }, t('backup.noticeNone')) : null,
        destinations.length === 0 ? h('p', { className: 'mydsh-notice' }, t('backup.noticeNoDestination')) : null,
      ),

      // ── history ──────────────────────────────────────────────────────────
      h(Card, { title: t('backup.history'), description: t('backup.historyHint') },
        (status.data?.history ?? []).length === 0
          ? h(Empty, { title: t('backup.noRuns') })
          : h('div', { className: 'mydsh-table-wrap' },
            h('table', { className: 'mydsh-table' },
              h('thead', null,
                h('tr', null,
                  h('th', null, t('backup.columnStarted')),
                  h('th', null, t('backup.columnTrigger')),
                  h('th', null, t('backup.columnStatus')),
                  h('th', { className: 'num' }, t('backup.columnSize')),
                  h('th', { className: 'num' }, t('backup.columnDuration')),
                ),
              ),
              h('tbody', null,
                status.data.history.map((entry) =>
                  h('tr', { key: entry.id },
                    h('td', { className: 'mydsh-hint' }, formatRelative(entry.startedAt, Date.now(), t)),
                    h('td', null, h(Badge, null, triggerLabel(t, entry.trigger))),
                    h('td', null,
                      h(Badge, {
                        tone: entry.status === 'succeeded' ? 'success'
                          : entry.status === 'failed' ? 'danger'
                            : entry.status === 'skipped' ? 'warn' : undefined,
                      }, statusLabel(t, entry.status)),
                    ),
                    h('td', { className: 'num' }, entry.bytes === undefined ? '—' : formatBytes(entry.bytes)),
                    h('td', { className: 'num' }, entry.durationMs === undefined ? '—' : `${(entry.durationMs / 1000).toFixed(1)}s`),
                  ),
                ),
              ),
            ),
          ),
      ),

      ),
  );
}

/** One run's outcome, naming the failing stage when it failed. */
function RunResult({ result }) {
  const t = usePanelT();
  if (result?.ok === true && result.skipped === true) {
    return h('p', { className: 'mydsh-hint' }, t('backup.skipped'));
  }
  if (result?.ok === false) {
    // A transport failure has no Host prose worth showing, so it is named with
    // shared wording; anything the Host did send is shown as it arrived.
    const detail = result.code === 'network'
      ? t('error.network')
      : result.code === 'bad-response' ? t('error.badResponse') : (result.error ?? result.reason);
    return h('div', { className: 'mydsh-error' },
      h('div', null, t('backup.failed', { message: detail })),
      Array.isArray(result.record?.steps)
        ? h('div', { className: 'mydsh-hint', style: { marginTop: 6 } },
          result.record.steps.map((step, index) =>
            h('div', { key: index }, `${step.name}: ${typeof step.detail === 'object' ? JSON.stringify(step.detail) : step.detail}`),
          ),
        )
        : null,
    );
  }
  const record = result?.record;
  return h('div', { className: 'mydsh-grid' },
    h(Stat, { label: t('backup.columnStatus'), value: statusLabel(t, record?.status ?? 'done') }),
    h(Stat, { label: t('backup.archived'), value: formatBytes(record?.bytes ?? 0) }),
    h(Stat, { label: t('backup.columnDuration'), value: `${((record?.durationMs ?? 0) / 1000).toFixed(1)}s` }),
  );
}

/** Editor for one destination, with its own connection test. */
function DestinationEditor({ destination, onChange, onRemove }) {
  const t = usePanelT();
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState(undefined);

  const test = async () => {
    setTesting(true);
    setTestResult(undefined);
    try {
      setTestResult(await api.backupTestDestination(destination));
    } catch (error) {
      setTestResult({ ok: false, reason: error?.message ?? String(error) });
    } finally {
      setTesting(false);
    }
  };

  return h('div', { className: 'mydsh-card', style: { background: 'var(--mydsh-surface-sunken)' } },
    h('div', { className: 'mydsh-card-head' },
      h('div', null,
        h('h3', null, t('backup.destinationTitle', { kind: kindLabel(t, destination.kind ?? 'local') })),
        destination.kind === 'local' && destination.directory
          ? h('p', { className: 'mydsh-mono' }, destination.directory)
          : null,
      ),
      h('div', { className: 'mydsh-inline' },
        testResult !== undefined
          ? h(Badge, { tone: testResult.ok ? 'success' : 'danger' },
            testResult.ok ? t('backup.reachable') : (testResult.reason ?? t('common.failed')))
          : null,
        h('button', { type: 'button', className: 'mydsh-btn mydsh-btn-sm', disabled: testing, onClick: test },
          testing ? t('backup.testing') : t('common.test')),
        h('button', { type: 'button', className: 'mydsh-btn mydsh-btn-sm mydsh-btn-danger', onClick: onRemove },
          t('common.remove')),
      ),
    ),

    h(FieldRow, { label: t('backup.type') },
      h('select', {
        className: 'mydsh-select',
        style: { width: 'auto', minWidth: 130 },
        'aria-label': t('backup.type'),
        value: destination.kind ?? 'local',
        onChange: (event) => onChange({ kind: event.target.value }),
      },
      h('option', { value: 'local' }, t('backup.local')),
      h('option', { value: 'webdav' }, t('backup.webdav')),
      h('option', { value: 'oss' }, t('backup.oss')),
      ),
    ),

    destination.kind === 'webdav' ? h(React.Fragment, null,
      h(FieldRow, { label: t('backup.serverUrl') },
        h('input', {
          className: 'mydsh-input',
          style: { width: 280 },
          'aria-label': t('backup.serverUrl'),
          placeholder: 'https://dav.example.com/remote.php/dav/files/me',
          value: destination.url ?? '',
          onChange: (event) => onChange({ url: event.target.value }),
        }),
      ),
      h(FieldRow, { label: t('backup.folder') },
        h('input', {
          className: 'mydsh-input',
          style: { width: 180 },
          'aria-label': t('backup.folder'),
          value: destination.directory ?? 'mydsh',
          onChange: (event) => onChange({ directory: event.target.value }),
        }),
      ),
      h('p', { className: 'mydsh-hint' }, t('backup.credentialsHint')),
    ) : destination.kind === 'oss' ? h(React.Fragment, null,
      h(FieldRow, { label: t('backup.bucket') },
        h('input', {
          className: 'mydsh-input',
          style: { width: 180 },
          'aria-label': t('backup.bucket'),
          value: destination.bucket ?? '',
          onChange: (event) => onChange({ bucket: event.target.value }),
        }),
      ),
      h(FieldRow, { label: t('backup.endpoint') },
        h('input', {
          className: 'mydsh-input',
          style: { width: 260 },
          'aria-label': t('backup.endpoint'),
          placeholder: 'oss-cn-guangzhou.aliyuncs.com',
          value: destination.endpoint ?? '',
          onChange: (event) => onChange({ endpoint: event.target.value }),
        }),
      ),
      h(FieldRow, { label: t('backup.prefix') },
        h('input', {
          className: 'mydsh-input',
          style: { width: 180 },
          'aria-label': t('backup.prefix'),
          value: destination.prefix ?? 'Agent/mydsh',
          onChange: (event) => onChange({ prefix: event.target.value }),
        }),
      ),
      h('p', { className: 'mydsh-hint' }, t('backup.accessKeysHint')),
    ) : h(React.Fragment, null,
      h(FieldRow, { label: t('backup.directory') },
        h('input', {
          className: 'mydsh-input',
          style: { width: 320 },
          'aria-label': t('backup.directory'),
          placeholder: 'D:\\Backups\\mydsh',
          value: destination.directory ?? '',
          onChange: (event) => onChange({ directory: event.target.value }),
        }),
      ),
    ),

    h(FieldRow, { label: t('backup.keepCopies') },
      h('input', {
        className: 'mydsh-input',
        type: 'number',
        style: { width: 90 },
        min: 1,
        'aria-label': t('backup.keepCopies'),
        value: destination.keepCopies ?? 7,
        onChange: (event) => onChange({ keepCopies: Number(event.target.value) }),
      }),
    ),
  );
}
