/**
 * Prompt, remote access, and toolbox panels.
 *
 * These three share a shape — a switch, a small form, and a status read-out — so
 * they live together to keep each one short.
 *
 * Every user-facing string is resolved through `usePanelT`, so each panel follows
 * DSH's active language. Host machine values (a connection state, a module id) stay
 * as ids and are translated only for display, so what is written back to settings
 * never depends on the language.
 */
import React from 'react';
import { Badge, Card, Empty } from './ui.js';
import { api, useAsync } from './data.js';
import { FieldForm, FieldRow, ModuleToggle, useSettings } from './settings-page.js';
import { useT } from './i18n-react.js';
import { describeFailure } from './failure.js';

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

/** Translate a relay connection state id; an unknown id stays visible. */
function relayStateLabel(t, state) {
  if (state === 'online') return t('remote.stateOnline');
  if (state === 'connecting') return t('remote.stateConnecting');
  if (state === 'offline') return t('remote.stateOffline');
  if (state === 'error') return t('remote.stateError');
  if (state === 'off') return t('remote.stateOff');
  return state ?? '';
}

/**
 * Describe a failed request in the active language.
 *
 * The shared helper owns the mapping so every panel words the same failure the same
 * way; this alias exists because the panel's call sites already read through it.
 */
function requestFailure(t, failure) {
  return describeFailure(t, failure);
}

// ── prompt ─────────────────────────────────────────────────────────────────

export function PromptPanel() {
  const t = usePanelT();
  const { settings, update } = useSettings();
  const enabled = settings?.prompt?.enabled === true;
  const values = settings?.prompt ?? {};

  return h('div', { className: 'mydsh-stack', style: { gap: 'var(--mydsh-space-4)' } },
    h(ModuleToggle, {
      section: 'prompt',
      titleKey: 'prompt.title',
      descriptionKey: 'prompt.description',
    }),

    enabled ? h(React.Fragment, null,
      h(Card, {
        title: t('prompt.instructions'),
        description: t('prompt.instructionsHint'),
      },
        h(FieldRow, { label: t('prompt.prefixLabel'), hint: t('prompt.prefixHint') },
          h('div', { style: { flex: 1, maxWidth: 520 } },
            h('textarea', {
              className: 'mydsh-textarea',
              rows: 6,
              'aria-label': t('prompt.prefixLabel'),
              placeholder: t('prompt.prefixPlaceholder'),
              value: values.prefix ?? '',
              onChange: (event) => update('prompt', { prefix: event.target.value }),
            }),
          ),
        ),
        h(FieldRow, { label: t('prompt.suffixLabel'), hint: t('prompt.suffixHint') },
          h('div', { style: { flex: 1, maxWidth: 520 } },
            h('textarea', {
              className: 'mydsh-textarea',
              rows: 6,
              'aria-label': t('prompt.suffixLabel'),
              placeholder: t('prompt.suffixPlaceholder'),
              value: values.suffix ?? '',
              onChange: (event) => update('prompt', { suffix: event.target.value }),
            }),
          ),
        ),
        h('p', { className: 'mydsh-hint' }, t('prompt.advisoryHint')),
        h(FieldForm, { section: 'prompt' }),
      ),
    ) : null,
  );
}

// ── remote ─────────────────────────────────────────────────────────────────

export function RemotePanel() {
  const t = usePanelT();
  const { settings, update } = useSettings();
  const values = settings?.remote ?? {};
  const enabled = values.enabled === true;
  const status = useAsync(() => api.remote(), [], { immediate: enabled });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(undefined);

  const connect = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.remoteConnect();
      status.reload();
    } catch (failure) {
      setError(requestFailure(t, failure));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await api.remoteDisconnect();
      status.reload();
    } catch (failure) {
      setError(requestFailure(t, failure));
    } finally {
      setBusy(false);
    }
  };

  const state = status.data?.status?.state ?? 'off';

  return h('div', { className: 'mydsh-stack', style: { gap: 'var(--mydsh-space-4)' } },
    h(ModuleToggle, {
      section: 'remote',
      titleKey: 'remote.title',
      descriptionKey: 'remote.description',
    }),

    enabled ? h(React.Fragment, null,
      h(Card, {
        title: t('remote.connection'),
        actions: h('div', { className: 'mydsh-inline' },
          h(Badge, {
            tone: state === 'online' ? 'success' : state === 'error' ? 'danger' : state === 'connecting' ? 'warn' : undefined,
          }, relayStateLabel(t, state)),
          h('button', {
            type: 'button',
            className: 'mydsh-btn mydsh-btn-sm',
            disabled: busy || values.relayUrl === '',
            onClick: state === 'online' ? disconnect : connect,
          }, busy ? t('remote.working') : state === 'online' ? t('remote.disconnect') : t('remote.connect')),
        ),
      },
        error !== undefined ? h('p', { className: 'mydsh-error' }, error) : null,
        h(FieldRow, { label: t('remote.relayUrl'), hint: t('remote.relayHint') },
          h('input', {
            className: 'mydsh-input',
            style: { width: 320 },
            'aria-label': t('remote.relayUrl'),
            placeholder: t('remote.relayPlaceholder'),
            value: values.relayUrl ?? '',
            onChange: (event) => update('remote', { relayUrl: event.target.value }),
          }),
        ),
        h(FieldRow, { label: t('remote.deviceName'), hint: t('remote.deviceNameHint') },
          h('input', {
            className: 'mydsh-input',
            style: { width: 200 },
            'aria-label': t('remote.deviceName'),
            placeholder: t('remote.devicePlaceholder'),
            value: values.account ?? '',
            onChange: (event) => update('remote', { account: event.target.value }),
          }),
        ),
        h(FieldRow, { label: t('remote.autoReconnect'), hint: t('remote.autoReconnectHint') },
          h('button', {
            type: 'button',
            className: 'mydsh-switch',
            'data-on': values.autoReconnect === true ? 'true' : 'false',
            role: 'switch',
            'aria-checked': values.autoReconnect === true,
            'aria-label': t('remote.autoReconnect'),
            onClick: () => update('remote', { autoReconnect: values.autoReconnect !== true }),
          }),
        ),
        status.data?.origin !== null && status.data?.origin !== undefined
          ? h('p', { className: 'mydsh-hint' },
            h('span', { className: 'mydsh-mono' }, status.data.origin),
            ` ${t('remote.forwardedTo')}`,
          )
          : h('p', { className: 'mydsh-notice' }, t('remote.notListening')),
      ),

      h(Card, { title: t('remote.security') },
        h('p', { className: 'mydsh-hint' }, t('remote.securityLead')),
        h('ul', { className: 'mydsh-hint', style: { margin: 0, paddingLeft: 18, lineHeight: 1.7 } },
          h('li', null, t('remote.securityHttps')),
          h('li', null, t('remote.securitySecret')),
          h('li', null, t('remote.securityLimit')),
          h('li', null, t('remote.securitySignOut')),
        ),
        h('p', { className: 'mydsh-hint' }, t('remote.securityDocs')),
      ),

      h(Card, { title: t('remote.allSettings') },
        h(FieldForm, { section: 'remote' }),
      ),
    ) : null,
  );
}

// ── toolbox ────────────────────────────────────────────────────────────────

/**
 * Optional capabilities, each independently switchable.
 *
 * `key` is the module id the Host stores; labels and hints are localization keys,
 * so switching language never changes which module is enabled.
 */
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

export function ToolboxPanel() {
  const t = usePanelT();
  const { settings, update } = useSettings();
  const enabled = settings?.toolbox?.enabled === true;
  const modules = settings?.toolbox?.modules ?? {};

  const mcp = useAsync(() => api.toolboxMcp(), []);
  const plugins = useAsync(() => api.toolboxPlugins(), []);

  const toggleModule = (key) => {
    update('toolbox', { modules: { ...modules, [key]: modules[key] !== true } });
  };

  return h('div', { className: 'mydsh-stack', style: { gap: 'var(--mydsh-space-4)' } },
    h(ModuleToggle, {
      section: 'toolbox',
      titleKey: 'toolbox.title',
      descriptionKey: 'toolbox.description',
    }),

    enabled ? h(React.Fragment, null,
      h(Card, { title: t('toolbox.capabilities'), description: t('toolbox.capabilitiesHint') },
        TOOLBOX_MODULES.map((module) =>
          h(FieldRow, { key: module.key, label: t(module.labelKey), hint: t(module.hintKey) },
            h('button', {
              type: 'button',
              className: 'mydsh-switch',
              'data-on': modules[module.key] === true ? 'true' : 'false',
              role: 'switch',
              'aria-checked': modules[module.key] === true,
              'aria-label': t(module.labelKey),
              onClick: () => toggleModule(module.key),
            }),
          ),
        ),
      ),

      h(Card, { title: t('toolbox.mcpServers'), description: t('toolbox.mcpServersHint') },
        mcp.data?.available === false
          ? h(Empty, { title: t('toolbox.mcpUnavailable') })
          : (mcp.data?.servers ?? []).length === 0
            ? h(Empty, { title: t('toolbox.noMcpServers') })
            : h('div', { className: 'mydsh-table-wrap' },
              h('table', { className: 'mydsh-table' },
                h('thead', null,
                  h('tr', null,
                    h('th', null, t('toolbox.columnName')),
                    h('th', null, t('toolbox.columnStatus')),
                    h('th', null, t('toolbox.columnTransport')),
                  ),
                ),
                h('tbody', null,
                  (mcp.data?.servers ?? []).map((server, index) =>
                    h('tr', { key: server.name ?? index },
                      h('td', null, server.name ?? '—'),
                      h('td', null,
                        h(Badge, { tone: server.status === 'connected' ? 'success' : undefined },
                          server.status === 'connected'
                            ? t('toolbox.statusConnected')
                            : (server.status ?? t('toolbox.statusUnknown'))),
                      ),
                      h('td', { className: 'mydsh-hint' }, server.transport ?? server.kind ?? '—'),
                    ),
                  ),
                ),
              ),
            ),
      ),

      h(Card, { title: t('toolbox.bundles'), description: t('toolbox.bundlesHint') },
        plugins.data?.available === false
          ? h(Empty, { title: t('toolbox.bundlesUnavailable') })
          : (plugins.data?.plugins ?? []).length === 0
            ? h(Empty, { title: t('toolbox.noBundles') })
            : h('div', { className: 'mydsh-table-wrap' },
              h('table', { className: 'mydsh-table' },
                h('thead', null,
                  h('tr', null,
                    h('th', null, t('toolbox.columnBundle')),
                    h('th', null, t('toolbox.columnVersion')),
                    h('th', null, t('toolbox.columnEnabled')),
                  ),
                ),
                h('tbody', null,
                  (plugins.data?.plugins ?? []).map((plugin, index) =>
                    h('tr', { key: plugin.name ?? index },
                      h('td', null, plugin.name ?? '—'),
                      h('td', { className: 'mydsh-mono' }, plugin.version ?? '—'),
                      h('td', null,
                        h(Badge, { tone: plugin.enabled === false ? undefined : 'success' },
                          plugin.enabled === false ? t('common.off') : t('common.on')),
                      ),
                    ),
                  ),
                ),
              ),
            ),
      ),
    ) : null,
  );
}
