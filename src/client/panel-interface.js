/**
 * Interface panel.
 *
 * Every control here changes how the shell looks, so each one states what it hides.
 * A user must be able to tell that turning a switch on removes something they can
 * currently see, and how to get it back.
 *
 * These switches are the only home for the appearance flags: `display` decides placement
 * and `interface` decides looks. They used to be declared in both sections while only
 * `display` was read, which made every control here a switch that changed a value nothing
 * consumed.
 */
import React from 'react';
import { Card } from './ui.js';
import { FieldRow, ModuleToggle, useSettings } from './settings-page.js';
import { useT } from './i18n-react.js';

const h = React.createElement;

/** Toggles with an explicit description of the visible effect. */
const TOGGLES = [
  { key: 'hideNewSessionButton', labelKey: 'iface.hideNewSession', hintKey: 'iface.hideNewSessionHint' },
  { key: 'hideBrandMark', labelKey: 'iface.hideBrandMark', hintKey: 'iface.hideBrandMarkHint' },
  { key: 'hideBrandName', labelKey: 'iface.hideBrandName', hintKey: 'iface.hideBrandNameHint' },
  { key: 'compactSidebar', labelKey: 'display.compactSidebar', hintKey: 'display.compactSidebarHint' },
];

export function InterfacePanel() {
  const { settings, update, saving } = useSettings();
  const t = useT();
  const look = settings?.interface ?? {};

  /** One switch bound to an interface key. */
  const switchRow = (key, labelKey, hintKey, disabled = false) =>
    h(FieldRow, { key, label: t(labelKey), hint: t(hintKey), disabled },
      h('button', {
        type: 'button',
        className: 'mydsh-switch',
        'data-on': look[key] === true ? 'true' : 'false',
        role: 'switch',
        'aria-checked': look[key] === true,
        'aria-label': t(labelKey),
        disabled: disabled || saving === 'interface',
        onClick: () => update('interface', { [key]: look[key] !== true }),
      }),
    );

  return h('div', { className: 'mydsh-stack mydsh-stack-lg' },
    h(ModuleToggle, {
      section: 'interface',
      titleKey: 'iface.title',
      descriptionKey: 'iface.description',
    }),

    h(Card, { title: t('iface.sidebar'), description: t('iface.sidebarHint') },
      // Session grouping is not offered: arranging the conversation list would mean
      // replacing a shadows-shipped-ui slot and hiding the shell's own list. See the
      // same note in the display panel.
      TOGGLES.map((toggle) => switchRow(toggle.key, toggle.labelKey, toggle.hintKey)),
    ),

    h(Card, { title: t('iface.account'), description: t('iface.accountHint') },
      switchRow('accountMenuInTitlebar', 'display.titlebarAccount', 'display.titlebarAccountHint'),
      switchRow(
        'avatarOnly',
        'display.avatarOnly',
        'display.avatarOnlyHint',
        look.accountMenuInTitlebar !== true,
      ),
      h('p', { className: 'mydsh-hint' },
        look.accountMenuInTitlebar !== true ? t('iface.titlebarOff') : t('iface.titlebarOn')),
    ),
  );
}
