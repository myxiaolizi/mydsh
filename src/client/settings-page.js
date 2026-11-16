/**
 * The settings page for 我的DSH.
 *
 * One page with a tab per capability keeps the feature count manageable and gives
 * every module the same chrome, so adding a module is a tab entry rather than
 * another page.
 *
 * Two things are worth knowing about the structure here:
 *
 *  - Tabs are declared as `labelKey` rather than literal text. The label is
 *    resolved through the translator at render time, which is what makes the whole
 *    page follow the shell's language.
 *  - A module that is switched off contributes no tab. Showing a tab whose entire
 *    body is "this is off" wastes a click, so the master switch is moved into the
 *    Display tab where the user chooses what exists at all.
 */
import React from 'react';
import { Card, cx, Empty, Icon, Segments, Badge, ErrorBanner } from './ui.js';
import { api, useAsync } from './data.js';
import { useT } from './i18n-react.js';

const h = React.createElement;

/**
 * Tab definitions, in display order.
 *
 * `section` names the settings section that owns the tab: a tab renders only while
 * that section is enabled, except for tabs with no section (Display always shows,
 * because it is where modules get switched on).
 */
export const TABS = [
  { id: 'display', labelKey: 'tab.display', icon: 'settings', section: null },
  { id: 'interface', labelKey: 'tab.interface', icon: 'palette', section: 'interface' },
  { id: 'usage', labelKey: 'tab.usage', icon: 'chart', section: 'usage' },
  { id: 'backup', labelKey: 'tab.backup', icon: 'database', section: 'backup' },
  { id: 'retry', labelKey: 'tab.retry', icon: 'refresh', section: 'retry' },
  { id: 'prompt', labelKey: 'tab.prompt', icon: 'prompt', section: 'prompt' },
  { id: 'remote', labelKey: 'tab.remote', icon: 'globe', section: 'remote' },
  { id: 'toolbox', labelKey: 'tab.toolbox', icon: 'toolbox', section: 'toolbox' },
];

/**
 * The sections whose switches decide whether the plugin is reachable at all.
 *
 * Restoring only these keeps a recovery from overwriting a user's real configuration;
 * `display` is included because its placement fields are what put the entry on screen.
 */
const RESTORE_SECTIONS = ['display', 'interface', 'usage', 'toolbox'];

/**
 * Shared settings context.
 *
 * Every panel reads the same snapshot and writes through the same helper, so a
 * toggle in one panel is reflected everywhere without a per-panel refetch.
 */
export const SettingsContext = React.createContext(undefined);

export function useSettings() {
  const value = React.useContext(SettingsContext);
  if (value === undefined) throw new Error('useSettings must be used inside the settings provider');
  return value;
}

/**
 * Provider that owns the settings document.
 *
 * The whole document is small enough to hold in memory, so writes patch locally
 * first and then persist: the switch responds immediately instead of waiting for a
 * round trip, and a failed write rolls the optimistic value back.
 */
export function SettingsProvider({ children }) {
  const loaded = useAsync(() => api.settings(), [], { immediate: true });
  const [settings, setSettings] = React.useState(undefined);
  const [error, setError] = React.useState(undefined);
  const [saving, setSaving] = React.useState(undefined);

  React.useEffect(() => {
    if (loaded.data?.settings !== undefined) setSettings(loaded.data.settings);
  }, [loaded.data]);

  const update = React.useCallback(async (section, patch) => {
    setSaving(section);
    setError(undefined);
    setSettings((previous) => {
      if (previous === undefined) return previous;
      return { ...previous, [section]: { ...previous[section], ...patch } };
    });
    try {
      const result = await api.saveSettings(section, patch);
      setSettings((previous) => ({ ...previous, [section]: result.value }));
      return result.value;
    } catch (failure) {
      setError(failure?.message ?? String(failure));
      // Re-read rather than guess which fields the Host rejected.
      loaded.reload();
      throw failure;
    } finally {
      setSaving(undefined);
    }
  }, [loaded]);

  const value = React.useMemo(() => ({
    settings,
    meta: loaded.data?.meta,
    defaults: loaded.data?.defaults,
    loading: loaded.loading,
    error: error ?? loaded.error?.message,
    saving,
    update,
    reload: loaded.reload,
    clearError: () => setError(undefined),
  }), [settings, loaded, error, saving, update]);

  return h(SettingsContext.Provider, { value }, children);
}

/** Whether a section is enabled; a missing section counts as off. */
export function sectionEnabled(settings, section) {
  if (section === null || section === undefined) return true;
  return settings?.[section]?.enabled === true;
}

/** Page shell: title, tab bar, and the active panel. */
export function SettingsPage({ panels }) {
  const t = useT();
  const { settings, error, clearError, reload } = useSettings();

  // Only tabs whose module is on are offered, so the bar never shows a page that
  // can only say "this is off".
  const visible = TABS.filter((entry) => sectionEnabled(settings, entry.section));
  const [tab, setTab] = React.useState(undefined);

  // The active tab must survive a module being switched off while its page is open.
  const active = visible.some((entry) => entry.id === tab) ? tab : visible[0]?.id;
  const Panel = active === undefined ? undefined : panels[active];

  return h('div', { className: 'mydsh mydsh-page' },
    h('div', { className: 'mydsh-header' },
      h('div', { className: 'mydsh-title' },
        h('h2', null, t('nav.title')),
        h('p', null, t('nav.subtitle')),
      ),
      h('div', { className: 'mydsh-inline' },
        h('button', {
          type: 'button',
          className: 'mydsh-btn mydsh-btn-sm',
          onClick: () => reload(),
          title: t('common.reloadHint'),
        }, h(Icon, { name: 'refresh', size: 13 }), t('common.reload')),
      ),
    ),
    h(ErrorBanner, {
      message: error,
      dismissLabel: t('common.close'),
      onDismiss: clearError,
    }),
    h('div', { className: 'mydsh-tabs', role: 'tablist' },
      visible.map((entry) =>
        h('button', {
          key: entry.id,
          type: 'button',
          role: 'tab',
          className: 'mydsh-tab',
          'data-active': entry.id === active ? 'true' : 'false',
          'aria-selected': entry.id === active,
          onClick: () => setTab(entry.id),
        },
          h(Icon, { name: entry.icon, size: 14 }),
          h('span', null, t(entry.labelKey)),
        ),
      ),
    ),
    Panel === undefined
      // Every module switched off leaves no tab to render and no way back: the only
      // controls that could re-enable them live inside those same tabs. This is the one
      // state the page must diagnose and repair itself rather than merely report.
      ? h(Empty, {
        title: t('settings.allOff'),
        hint: t('settings.allOffHint'),
        action: h(RecoverDefaults, null),
      })
      : h(Panel),
  );
}

/**
 * Put the shipped defaults back for the fields that decide reachability.
 *
 * Deliberately narrow: it restores the module switches and the placement fields only, not
 * the rest of the configuration. A user whose entry vanished keeps their backup targets,
 * retry policy, and prompt text.
 */
function RecoverDefaults() {
  const { update, defaults } = useSettings();
  const t = useT();
  const [busy, setBusy] = React.useState(false);

  const restore = async () => {
    setBusy(true);
    try {
      for (const section of RESTORE_SECTIONS) {
        const shipped = defaults?.[section] ?? {};
        const patch = { enabled: shipped.enabled === true };
        // A stored `hidden` survives an `enabled` flip, so the placement keys come back
        // from the defaults too.
        for (const key of ['entry', 'usagePlacement', 'fleetPlacement']) {
          if (shipped[key] !== undefined) patch[key] = shipped[key];
        }
        await update(section, patch);
      }
    } finally {
      setBusy(false);
    }
  };

  return h('button', {
    type: 'button',
    className: 'mydsh-btn',
    disabled: busy,
    onClick: restore,
  }, busy ? t('common.save') + '…' : t('settings.restoreDefaults'));
}

/**
 * Renders the fields the Host describes for one section.
 *
 * This is the generic form renderer: the Host owns the field list, so adding a
 * setting is a Host-side change only. Structured (`list`) fields are skipped here
 * because a panel renders those with a purpose-built control.
 */
export function FieldForm({ section, children, skip = [] }) {
  const { settings, meta, update, saving } = useSettings();
  const t = useT();
  const sectionMeta = meta?.[section];
  const values = settings?.[section];
  if (values === undefined || sectionMeta === undefined) return null;

  const busy = saving === section;

  return h('div', { className: 'mydsh-stack' },
    (sectionMeta.fields ?? []).map((field) => {
      if (['list'].includes(field.kind)) return null;
      if (skip.includes(field.key)) return null;

      const gated = field.gate !== undefined && values[field.gate] !== true;
      const value = values[field.key];

      const control = renderControl({
        field,
        value,
        disabled: gated || busy,
        t,
        onChange: (next) => update(section, { [field.key]: next }),
      });

      return h(FieldRow, {
        key: field.key,
        label: fieldLabel(field, t),
        hint: fieldHint(field, t),
        disabled: gated,
        children: control,
      });
    }),
    children,
  );
}

/**
 * Resolve a field label.
 *
 * The Host supplies a localization key, so the translator resolves it. A key with
 * no entry falls back to a humanized tail rather than showing `settings.x.y`.
 */
export function fieldLabel(field, t) {
  const translate = t ?? ((key) => key);
  const key = field.label ?? field.key;
  const text = translate(key);
  if (typeof text === 'string' && text !== key) return text;
  return humanize(key);
}

export function fieldHint(field, t) {
  if (field.hint === undefined) return undefined;
  const translate = t ?? ((key) => key);
  const text = translate(field.hint);
  if (typeof text === 'string' && text !== field.hint) return text;
  return humanize(field.hint);
}

/** One labelled field row with consistent spacing. */
export function FieldRow({ label, hint, disabled, children }) {
  return h('div', { className: cx('mydsh-row', disabled === true && 'disabled') },
    h('div', { className: 'mydsh-row-text' },
      h('span', { className: 'mydsh-row-label' }, label),
      hint !== undefined && hint !== '' ? h('span', { className: 'mydsh-row-hint' }, hint) : null,
    ),
    h('div', { className: 'mydsh-row-control' }, children),
  );
}

function renderControl({ field, value, disabled, onChange, t }) {
  switch (field.kind) {
    case 'toggle':
      return h('button', {
        type: 'button',
        className: 'mydsh-switch',
        'data-on': value === true ? 'true' : 'false',
        role: 'switch',
        'aria-checked': value === true,
        disabled,
        onClick: () => onChange(value !== true),
      });
    case 'select':
      return h('select', {
        className: 'mydsh-select',
        value: value ?? '',
        disabled,
        onChange: (event) => onChange(event.target.value),
      }, (field.options ?? []).map((option) => {
        const key = option.label ?? option.value;
        const text = t !== undefined ? t(key) : key;
        return h('option', { key: option.value, value: option.value },
          typeof text === 'string' && text !== key ? text : humanize(key));
      }));
    case 'number':
      return h('input', {
        className: 'mydsh-input mydsh-input-number',
        type: 'number',
        value: value ?? 0,
        min: field.min,
        max: field.max,
        step: field.step,
        disabled,
        onChange: (event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) onChange(parsed);
        },
      });
    case 'textarea':
      return h('textarea', {
        className: 'mydsh-textarea',
        rows: field.rows ?? 4,
        value: value ?? '',
        placeholder: field.placeholder,
        disabled,
        onChange: (event) => onChange(event.target.value),
      });
    case 'text':
    default:
      return h('input', {
        className: 'mydsh-input',
        type: 'text',
        value: value ?? '',
        placeholder: field.placeholder,
        disabled,
        onChange: (event) => onChange(event.target.value),
      });
  }
}

/** Turn `settings.usage.showBalance` into `Show balance`. */
export function humanize(key) {
  if (typeof key !== 'string') return '';
  const tail = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1) : key;
  const spaced = tail.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * A module master switch shown above each panel's fields.
 *
 * The switch lives beside the title so the panel's own controls sit underneath it,
 * and a disabled module still shows its description — the user needs to know what
 * they would be turning on.
 */
export function ModuleToggle({ section, titleKey, descriptionKey }) {
  const { settings, update, saving } = useSettings();
  const t = useT();
  const enabled = settings?.[section]?.enabled === true;

  return h('div', { className: 'mydsh-module-head' },
    h('div', { className: 'mydsh-module-text' },
      h('h3', null, t(titleKey)),
      h('p', null, t(descriptionKey)),
    ),
    h('div', { className: 'mydsh-inline' },
      h(Badge, { tone: enabled ? 'success' : undefined },
        enabled ? t('common.enabled') : t('common.disabled')),
      h('button', {
        type: 'button',
        className: 'mydsh-switch',
        'data-on': enabled ? 'true' : 'false',
        role: 'switch',
        'aria-checked': enabled,
        disabled: saving === section,
        onClick: () => update(section, { enabled: !enabled }),
      }),
    ),
  );
}

/** A short explanatory line, used where a panel needs to state a consequence. */
export function Hint({ children }) {
  return h('p', { className: 'mydsh-hint' }, children);
}
