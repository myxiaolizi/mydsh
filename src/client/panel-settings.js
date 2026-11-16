/**
 * The one page that owns configuration.
 *
 * Every module page used to carry its own settings inline — backup had seventeen rows plus a
 * generated form, retry had a form and a bypass row, the usage page had a settings card, and
 * half the pages repeated the same module switch. That made a feature page read as a form:
 * the thing you came to look at was buried under the thing you configure once.
 *
 * This page is the single place a switch or a field lives. Feature pages keep what they are
 * good at — status, history, and the actions that operate on them — and link here when a
 * setting is what the user actually wants.
 *
 * Sections are collapsed rather than stacked: nine full forms laid end to end is a wall of
 * controls, which is the same problem moved rather than solved.
 */
import * as React from 'react';
import { Badge, Card, Empty, Icon, cx } from './ui.js';
import { api, useAsync } from './data.js';
import { useT } from './i18n-react.js';
import { FieldForm, FieldRow, ModuleToggle, useSettings } from './settings-page.js';

const h = React.createElement;

/**
 * The order sections appear in.
 *
 * Placement first because it decides whether anything else is reachable, then the modules in
 * the order a new user would turn them on. `budget` sits with `usage` because a budget is a
 * property of spend, not a separate feature.
 */
const GROUPS = [
  { id: 'display', titleKey: 'settings.groupDisplay', hintKey: 'settings.groupDisplayHint', modules: ['display'] },
  { id: 'interface', titleKey: 'settings.groupInterface', hintKey: 'settings.groupInterfaceHint', modules: ['interface'] },
  { id: 'usage', titleKey: 'settings.groupUsage', hintKey: 'settings.groupUsageHint', modules: ['usage', 'budget'] },
  { id: 'backup', titleKey: 'settings.groupBackup', hintKey: 'settings.groupBackupHint', modules: ['backup'] },
  { id: 'retry', titleKey: 'settings.groupRetry', hintKey: 'settings.groupRetryHint', modules: ['retry'] },
  { id: 'prompt', titleKey: 'settings.groupPrompt', hintKey: 'settings.groupPromptHint', modules: ['prompt'] },
  { id: 'remote', titleKey: 'settings.groupRemote', hintKey: 'settings.groupRemoteHint', modules: ['remote'] },
  { id: 'toolbox', titleKey: 'settings.groupToolbox', hintKey: 'settings.groupToolboxHint', modules: ['toolbox'] },
];

export function SettingsPanel() {
  const t = useT();
  const { settings, meta, loading } = useSettings();

  // One section open at a time: the page's job is to make a setting findable, and two open
  // forms make both harder to scan than one.
  const [open, setOpen] = React.useState('display');
  const toggle = (id) => setOpen((current) => (current === id ? undefined : id));

  if (loading && settings === undefined) {
    return h('div', { className: 'mydsh-stack' }, h(Empty, { title: t('common.loading') }));
  }

  return h('div', { className: 'mydsh-stack mydsh-settings' },
    h('div', { className: 'mydsh-dash-head' },
      h('div', null,
        h('h2', { className: 'mydsh-dash-title' }, t('settings.title')),
        h('p', { className: 'mydsh-dash-sub' }, t('settings.subtitle')),
      ),
    ),

    GROUPS.map((group) => {
      const isOpen = open === group.id;
      // A module that is off still shows its switch — that is how it is turned back on — but
      // its fields are not worth expanding, because they do nothing while it is off.
      const anyOn = group.modules.some((name) => settings?.[name]?.enabled === true);

      return h('div', { key: group.id, className: 'mydsh-settings-group', 'data-open': isOpen ? 'true' : 'false' },
        h('button', {
          type: 'button',
          className: 'mydsh-settings-head',
          'aria-expanded': isOpen,
          onClick: () => toggle(group.id),
        },
          h('span', { className: 'mydsh-settings-caret', 'data-open': isOpen ? 'true' : 'false' },
            h(Icon, { name: 'chevron', size: 13 })),
          h('span', { className: 'mydsh-settings-title' }, t(group.titleKey)),
          h('span', { className: 'mydsh-settings-hint' }, t(group.hintKey)),
          anyOn
            ? null
            : h(Badge, { tone: 'muted' }, t('common.disabled')),
        ),

        isOpen
          ? h('div', { className: 'mydsh-settings-body' },
            group.modules.map((name) =>
              h('div', { key: name, className: 'mydsh-settings-section' },
                // `display` has no master switch of its own — it is the page that makes the
                // others reachable — so the switch is drawn only where the Host declares one.
                name === 'display'
                  ? null
                  : h(ModuleToggle, {
                    section: name,
                    titleKey: `${name}.title`,
                    descriptionKey: `${name}.description`,
                  }),
                h(FieldForm, { section: name }),
                // `toolbox.modules` is a `list` field, which the generated form skips because it
                // needs a purpose-built control. It belongs here with the other switches.
                name === 'toolbox' ? h(ToolboxModules, null) : null,
              ),
            ),
          )
          : null,
      );
    }),

    // The registry state lives here rather than on the toolbox page, because "which modules
    // exist on this build" is configuration knowledge, not a live reading.
    h('p', { className: 'mydsh-hint' }, t('settings.footerHint')),
  );
}

/** Labels for the toolbox modules, matching the Host registry's keys. */
const TOOLBOX_MODULES = [
  { key: 'memory', labelKey: 'toolbox.memory', hintKey: 'toolbox.memoryHint' },
  { key: 'pua', labelKey: 'toolbox.pua', hintKey: 'toolbox.puaHint' },
  { key: 'imageGen', labelKey: 'toolbox.imageGen', hintKey: 'toolbox.imageGenHint' },
  { key: 'agencyAgents', labelKey: 'toolbox.agencyAgents', hintKey: 'toolbox.agencyAgentsHint' },
  { key: 'agentTeams', labelKey: 'toolbox.agentTeams', hintKey: 'toolbox.agentTeamsHint' },
  { key: 'windowsMcp', labelKey: 'toolbox.windowsMcp', hintKey: 'toolbox.windowsMcpHint' },
  { key: 'mcpConnector', labelKey: 'toolbox.mcpConnector', hintKey: 'toolbox.mcpConnectorHint' },
  { key: 'configManager', labelKey: 'toolbox.configManager', hintKey: 'toolbox.configManagerHint' },
  { key: 'skillExplorer', labelKey: 'toolbox.skillExplorer', hintKey: 'toolbox.skillExplorerHint' },
];

/**
 * The toolbox module switches.
 *
 * `toolbox.modules` is stored as one list field, which the generated form cannot render — it
 * needs a purpose-built control per entry. A module this build cannot implement is reported
 * rather than offered, so the panel never presents a switch that toggles nothing.
 */
function ToolboxModules() {
  const t = useT();
  const { settings, update } = useSettings();
  const status = useAsync(() => api.toolbox(), []);
  const modules = settings?.toolbox?.modules ?? {};
  const enabled = settings?.toolbox?.enabled === true;

  const toggle = (key) => {
    void update('toolbox', { modules: { ...modules, [key]: modules[key] !== true } });
  };

  if (enabled !== true) return null;

  return h('div', { className: 'mydsh-stack' },
    TOOLBOX_MODULES.map((module) => {
      const entry = status.data?.registry?.[module.key];
      const usable = entry === undefined || entry.available === true;
      return h(FieldRow, {
        key: module.key,
        label: t(module.labelKey),
        hint: usable ? t(module.hintKey) : t('toolbox.reason.' + (entry?.reason ?? 'unavailable')),
      },
        usable
          ? h('button', {
            type: 'button',
            className: 'mydsh-switch',
            'data-on': modules[module.key] === true ? 'true' : 'false',
            role: 'switch',
            'aria-checked': modules[module.key] === true,
            'aria-label': t(module.labelKey),
            onClick: () => toggle(module.key),
          })
          : h(Badge, { tone: 'muted' }, t('toolbox.notAvailable')),
      );
    }),
  );
}
