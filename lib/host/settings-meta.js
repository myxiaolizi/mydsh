/**
 * Settings metadata for the client half.
 *
 * The UI needs more than values: every field has a type, a range, and a localized
 * label. Keeping that description in one table means the interface can render a
 * complete form without a hand-written control per field, and a new setting shows
 * up by adding one row here.
 *
 * Field descriptors are data, deliberately: the client renders them generically,
 * so this file must stay free of behavior.
 */

/** How a field is edited. */
export const FIELD_KINDS = Object.freeze(['toggle', 'select', 'number', 'text', 'textarea', 'list', 'secret']);

/** One editable field. */
const field = (key, kind, label, extra = {}) => ({ key, kind, label, ...extra });

/**
 * Which fields appear in which section, in order.
 *
 * `gate` names a boolean sibling: the field is only meaningful when that sibling
 * is on, and the UI greys it out rather than hiding it so the dependency is
 * discoverable.
 */
export const collection = Object.freeze({
  /**
   * Placement. Always first and always enabled: this section decides which other
   * sections exist, so it cannot be gated behind one of them.
   */
  display: {
    title: 'display.title',
    description: 'display.description',
    fields: [
      field('enabled', 'toggle', 'display.enabled'),
      field('entry', 'select', 'display.entry', {
        options: [
          { value: 'sidebar', label: 'display.entrySidebar' },
          { value: 'settings', label: 'display.entrySettings' },
          { value: 'titlebar', label: 'display.entryTitlebar' },
          { value: 'hidden', label: 'display.entryHidden' },
        ],
      }),
      field('sidebarBadge', 'toggle', 'display.sidebarBadge', { gate: 'enabled' }),
      field('usagePlacement', 'select', 'display.usagePanelIn', {
        options: [
          { value: 'panel', label: 'display.inPanel' },
          { value: 'sidebar', label: 'display.inSidebar' },
          { value: 'titlebar', label: 'display.inTitlebar' },
          { value: 'off', label: 'display.inOff' },
        ],
      }),
      field('fleetPlacement', 'select', 'display.fleetPanelIn', {
        options: [
          { value: 'header', label: 'display.fleetInHeader' },
          { value: 'sidebar', label: 'display.fleetInSidebar' },
          { value: 'off', label: 'display.inOff' },
        ],
      }),
    ],
  },
  /**
   * Appearance. This section owns every switch that changes how the shell looks; `display`
   * owns placement only. The keys were once declared in both sections while only `display`
   * was read, which made this whole page a set of switches that changed nothing.
   */
  interface: {
    title: 'iface.title',
    description: 'iface.description',
    fields: [
      field('enabled', 'toggle', 'common.enabled'),
      field('brandMark', 'toggle', 'display.brandMark', { gate: 'enabled' }),
      field('brandName', 'toggle', 'display.brandName', { gate: 'enabled' }),
      field('hideNewSessionButton', 'toggle', 'iface.hideNewSession', { gate: 'enabled' }),
      field('hideBrandMark', 'toggle', 'iface.hideBrandMark', { gate: 'enabled' }),
      field('hideBrandName', 'toggle', 'iface.hideBrandName', { gate: 'enabled' }),
      field('compactSidebar', 'toggle', 'display.compactSidebar', { gate: 'enabled' }),
      field('accountMenuInTitlebar', 'toggle', 'display.titlebarAccount', { gate: 'enabled' }),
      field('avatarOnly', 'toggle', 'display.avatarOnly', { gate: 'enabled' }),
    ],
  },
  usage: {
    title: 'usage.title',
    description: 'usage.description',
    fields: [
      field('enabled', 'toggle', 'common.enabled'),
      field('showBalance', 'toggle', 'usage.showBalance', { gate: 'enabled' }),
      field('contextInsight', 'toggle', 'usage.contextInsight', { gate: 'enabled' }),
      field('currency', 'select', 'usage.currency', {
        gate: 'enabled',
        options: [
          { value: 'CNY', label: 'usage.currencyCny' },
          { value: 'USD', label: 'usage.currencyUsd' },
        ],
      }),
      field('usdToCny', 'number', 'usage.usdToCny', { gate: 'enabled', min: 1, max: 20, step: 0.1 }),
      field('refreshIntervalMs', 'number', 'usage.refresh', {
        gate: 'enabled', min: 5000, max: 600000, step: 5000,
      }),
    ],
  },
  budget: {
    title: 'budget.title',
    description: 'budget.description',
    fields: [
      field('enabled', 'toggle', 'common.enabled'),
      field('action', 'select', 'usage.whenExceeded', {
        gate: 'enabled',
        options: [
          { value: 'notify', label: 'usage.notify' },
          { value: 'pause', label: 'usage.pause' },
        ],
      }),
      field('rules', 'list', 'usage.budgets', { gate: 'enabled' }),
    ],
  },
  backup: {
    title: 'backup.title',
    description: 'backup.description',
    fields: [
      field('enabled', 'toggle', 'common.enabled'),
      field('items', 'list', 'backup.items', { gate: 'enabled' }),
      field('destinations', 'list', 'backup.destinations', { gate: 'enabled' }),
      field('triggers', 'list', 'backup.triggers', { gate: 'enabled' }),
      field('archive', 'list', 'backup.archive', { gate: 'enabled' }),
      field('retentionDays', 'number', 'backup.retention', { gate: 'enabled', min: 1, max: 3650, step: 1 }),
    ],
  },
  retry: {
    title: 'retry.title',
    description: 'retry.description',
    fields: [
      field('enabled', 'toggle', 'common.enabled'),
      field('maxAttempts', 'number', 'retry.maxAttempts', { gate: 'enabled', min: 1, max: 10, step: 1 }),
      field('initialDelayMs', 'number', 'retry.initialDelay', { gate: 'enabled', min: 0, max: 60000, step: 100 }),
      field('maxDelayMs', 'number', 'retry.maxDelay', { gate: 'enabled', min: 1000, max: 300000, step: 1000 }),
      // Whole-turn continuation. Gated on `enabled` too: the module switch is the master
      // switch for everything under it, so a sub-feature cannot outlive the section.
      field('autoContinue', 'toggle', 'retry.autoContinue', { gate: 'enabled' }),
      field('maxConsecutive', 'number', 'retry.maxConsecutive', { gate: 'enabled', min: 0, max: 20, step: 1 }),
      field('cooldownMs', 'number', 'retry.cooldown', { gate: 'enabled', min: 0, max: 600000, step: 1000 }),
      field('maxCooldownMs', 'number', 'retry.maxCooldown', { gate: 'enabled', min: 1000, max: 900000, step: 1000 }),
      field('backoffFactor', 'number', 'retry.backoffFactor', { gate: 'enabled', min: 1, max: 10, step: 0.5 }),
      field('resumeCompletedTurns', 'toggle', 'retry.resumeCompleted', { gate: 'enabled' }),
      field('resumeSubagents', 'toggle', 'retry.resumeSubagents', { gate: 'enabled' }),
      field('policies', 'list', 'retry.policies', { gate: 'enabled' }),
      field('alternatives', 'list', 'retry.alternatives', { gate: 'enabled' }),
    ],
  },
  prompt: {
    title: 'prompt.title',
    description: 'prompt.description',
    fields: [
      field('enabled', 'toggle', 'common.enabled'),
      field('prefix', 'textarea', 'prompt.prefix', { gate: 'enabled', rows: 6 }),
      field('suffix', 'textarea', 'prompt.suffix', { gate: 'enabled', rows: 6 }),
    ],
  },
  remote: {
    title: 'remote.title',
    description: 'remote.description',
    fields: [
      field('enabled', 'toggle', 'common.enabled'),
      field('relayUrl', 'text', 'remote.relayUrl', { gate: 'enabled', placeholder: 'wss://mydsh.zhengl.vip/tunnel' }),
      field('account', 'text', 'remote.account', { gate: 'enabled' }),
      field('autoReconnect', 'toggle', 'remote.autoReconnect', { gate: 'enabled' }),
    ],
  },
  toolbox: {
    title: 'toolbox.title',
    description: 'toolbox.description',
    fields: [
      field('enabled', 'toggle', 'common.enabled'),
      field('modules', 'list', 'toolbox.title', { gate: 'enabled' }),
    ],
  },
});
