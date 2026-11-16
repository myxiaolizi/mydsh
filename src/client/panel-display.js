/**
 * Placement panel.
 *
 * This is the control room for the plugin itself: where its entry appears, which
 * features exist at all, and where each feature's own surface goes. It is
 * deliberately the first tab and the one tab that cannot be switched off, because
 * every other tab's visibility is decided here — a module whose tab is hidden must
 * still be reachable to turn it back on.
 *
 * Two design rules:
 *
 *  - Every choice states its visible consequence. "Hidden" is only safe to offer
 *    when the user can see how to undo it, so each location option names the place
 *    it affects.
 *  - Nothing here is inferred. A setting that does nothing would be worse than no
 *    setting, so each row maps to behavior the client actually implements.
 */
import React from 'react';
import { Card, Badge, Segments, Switch } from './ui.js';
import { FieldRow, fieldLabel, fieldHint, useSettings } from './settings-page.js';
import { useT } from './i18n-react.js';

const h = React.createElement;

/**
 * Modules that can be switched off, in display order.
 *
 * `section` is the settings section whose `enabled` flag gates the tab; `labelKey`
 * and `hintKey` describe the capability in the user's terms. Listing them here
 * rather than deriving from the Host keeps the panel readable, and the host-side
 * test asserts every section appears in both places.
 */
export const MODULES = [
  { section: 'interface', labelKey: 'iface.title', hintKey: 'iface.description' },
  { section: 'usage', labelKey: 'usage.title', hintKey: 'usage.description' },
  { section: 'backup', labelKey: 'backup.title', hintKey: 'backup.description' },
  { section: 'retry', labelKey: 'retry.title', hintKey: 'retry.description' },
  { section: 'prompt', labelKey: 'prompt.title', hintKey: 'prompt.description' },
  { section: 'remote', labelKey: 'remote.title', hintKey: 'remote.description' },
  { section: 'toolbox', labelKey: 'toolbox.title', hintKey: 'toolbox.description' },
];

/** Where the plugin's own entry is offered. */
export const ENTRY_LOCATIONS = ['sidebar', 'settings', 'titlebar', 'hidden'];

/** Where a feature's own surface is offered. */
export const PANEL_LOCATIONS = ['panel', 'sidebar', 'titlebar', 'off'];

export function DisplayPanel() {
  const { settings, meta, update, saving } = useSettings();
  const t = useT();
  const display = settings?.display ?? {};

  const set = (patch) => update('display', patch);

  return h('div', { className: 'mydsh-stack mydsh-stack-lg' },
    h(Card, {
      title: t('display.entry'),
      description: t('display.entryHint'),
    },
      // The card already carries the label and explanation, so the row holds only
      // the control. Repeating both here read as a duplicated heading.
      h('div', { className: 'mydsh-row mydsh-row-plain' },
        h(Segments, {
          value: display.entry ?? 'sidebar',
          ariaLabel: t('display.entry'),
          options: [
            { value: 'sidebar', label: t('display.entrySidebar') },
            { value: 'settings', label: t('display.entrySettings') },
            { value: 'titlebar', label: t('display.entryTitlebar') },
            { value: 'hidden', label: t('display.entryHidden') },
          ],
          onChange: (entry) => set({ entry }),
        }),
      ),
      display.entry === 'sidebar'
        ? h(FieldRow, {
          label: t('display.sidebarBadge'),
          hint: t('display.sidebarBadgeHint'),
        },
          h(Switch, {
            checked: display.sidebarBadge === true,
            onChange: (sidebarBadge) => set({ sidebarBadge }),
          }),
        )
        : null,
    ),

    h(Card, {
      title: t('display.modules'),
      description: t('display.modulesHint'),
    },
      MODULES.map((module) =>
        h(FieldRow, {
          key: module.section,
          label: t(module.labelKey),
          hint: t(module.hintKey),
        },
          h('button', {
            type: 'button',
            className: 'mydsh-switch',
            'data-on': settings?.[module.section]?.enabled === true ? 'true' : 'false',
            role: 'switch',
            'aria-checked': settings?.[module.section]?.enabled === true,
            'aria-label': t(module.labelKey),
            disabled: saving === module.section,
            onClick: () => update(module.section, { enabled: settings?.[module.section]?.enabled !== true }),
          }),
        ),
      ),
    ),

    h(Card, {
      title: t('iface.sidebar'),
      description: t('iface.sidebarHint'),
    },
      h(FieldRow, {
        label: t('display.brandMark'),
        hint: t('display.brandMarkHint'),
      },
        h(Switch, {
          checked: display.brandMark === true,
          onChange: (brandMark) => set({ brandMark }),
        }),
      ),
      h(FieldRow, {
        label: t('display.brandName'),
        hint: t('display.brandNameHint'),
      },
        h(Switch, {
          checked: display.brandName === true,
          onChange: (brandName) => set({ brandName }),
        }),
      ),
      // Sidebar density, the titlebar account control, and the interface toggles live in
      // the Interface panel, which is their home. They used to be declared here as well,
      // so the same switch appeared on two pages and the two copies edited one stored
      // value behind each other's back.
      // Session-list grouping is deliberately absent. Arranging the conversations under
      // the workspace switcher means replacing `sidebar.workspaces`, which is a
      // shadows-shipped-ui slot — taking it over would hide the shell's own list rather
      // than extend it. The setting stays in the schema so an existing value survives,
      // but no control is offered while it cannot do anything.
    ),

    h(Card, {
      title: t('display.usagePanelIn'),
      description: t('display.usagePanelInHint'),
    },
      // As with the entry card, the heading above already says what this is, so the
      // row holds only the control.
      h('div', { className: 'mydsh-row mydsh-row-plain' },
        h(Segments, {
          value: display.usagePlacement ?? 'panel',
          ariaLabel: t('display.usagePanelIn'),
          options: [
            { value: 'panel', label: t('display.inPanel') },
            { value: 'sidebar', label: t('display.inSidebar') },
            { value: 'titlebar', label: t('display.inTitlebar') },
            { value: 'off', label: t('display.inOff') },
          ],
          onChange: (usagePlacement) => set({ usagePlacement }),
        }),
      ),
    ),

    h(Card, { title: t('display.currentEffect') },
      h('div', { className: 'mydsh-effect-list' },
        effectRow(t('display.newSessionButton'), display.hideNewSessionButton === true
          ? t('common.hidden') : t('common.visible'), display.hideNewSessionButton !== true),
        effectRow(t('display.logo'), display.brandMark === true
          ? t('nav.title') : display.hideBrandMark === true ? t('common.hidden') : t('common.visible'),
          display.hideBrandMark !== true),
        effectRow(t('display.productName'), display.brandName === true
          ? t('nav.title') : display.hideBrandName === true ? t('common.hidden') : t('common.visible'),
          display.hideBrandName !== true),
        effectRow(t('display.account'), display.accountMenuInTitlebar === true
          ? t('display.titlebar') : t('display.footer'), true),
      ),
    ),

    h(Card, { title: t('iface.allSettings') },
      h(DisplayAllFields),
    ),
  );

  /** One line of the effect summary: label, value, and whether it is live. */
  function effectRow(label, value, live) {
    return h('div', { className: 'mydsh-effect', key: label },
      h('span', { className: 'mydsh-effect-label' }, label),
      h(Badge, { tone: live ? 'success' : undefined }, value),
    );
  }
}

/**
 * The remaining scalar fields the Host describes for this section.
 *
 * Rendering them generically means a field added on the Host side appears here
 * without a client change; the rows above cover the ones that deserve a purpose-
 * built control.
 */
function DisplayAllFields() {
  const { settings, meta, update, saving } = useSettings();
  const t = useT();
  const sectionMeta = meta?.display;
  const values = settings?.display;
  if (sectionMeta === undefined || values === undefined) return null;

  // Keys already rendered above with a richer control.
  const handled = new Set([
    'entry', 'sidebarBadge', 'brandMark', 'brandName', 'compactSidebar',
    'usagePlacement',
    // `sessionGrouping` has no control above *and* must not be offered here: arranging
    // the conversation list would mean replacing a shadows-shipped-ui slot. Without
    // this exclusion the catch-all card would quietly render the switch again.
    'sessionGrouping',
  ]);

  const rows = (sectionMeta.fields ?? []).filter((field) => !handled.has(field.key) && field.kind !== 'list');
  if (rows.length === 0) return h('p', { className: 'mydsh-hint' }, t('common.none'));

  return h('div', { className: 'mydsh-stack' },
    rows.map((field) => {
      const gated = field.gate !== undefined && values[field.gate] !== true;
      const value = values[field.key];
      const disabled = gated || saving === 'display';
      const onChange = (next) => update('display', { [field.key]: next });

      let control;
      if (field.kind === 'toggle') {
        control = h(Switch, { checked: value === true, disabled, onChange });
      } else if (field.kind === 'select') {
        control = h('select', {
          className: 'mydsh-select',
          value: value ?? '',
          disabled,
          onChange: (event) => onChange(event.target.value),
        }, (field.options ?? []).map((option) => {
          const text = t(option.label ?? option.value);
          return h('option', { key: option.value, value: option.value }, text);
        }));
      } else if (field.kind === 'number') {
        control = h('input', {
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
      } else {
        control = h('input', {
          className: 'mydsh-input',
          type: 'text',
          value: value ?? '',
          placeholder: field.placeholder,
          disabled,
          onChange: (event) => onChange(event.target.value),
        });
      }

      return h(FieldRow, {
        key: field.key,
        label: fieldLabel(field, t),
        hint: fieldHint(field, t),
        disabled: gated,
      }, control);
    }),
  );
}
