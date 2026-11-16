/**
 * dsh-mydsh — Client half.
 *
 * This module is the browser entry. DSH loads it through the module loader, so it
 * must export `apply(ctx)` and declare which client services it needs. Everything
 * the user sees is mounted from here into named slots; nothing reaches into the
 * shell's internals.
 *
 * Three rules shape this file:
 *
 *  - Registration is defensive. A slot that a given DSH build does not publish must
 *    not prevent the rest from mounting, so every injection is guarded.
 *  - Nothing renders until settings have arrived. Half-configured UI that then jumps
 *    is worse than a brief blank, so a provider gates on the first load.
 *  - Every registration returns a disposer, and every disposer is collected, so
 *    unloading the plugin leaves no trace in the page.
 *
 * Seat choices that are deliberate and worth recording:
 *
 *  - `shell.leading` is a `single` slot already occupied by ui-sidebar's
 *    reopen/New Session controls. Registering there would shadow those controls and
 *    break the sidebar rail, so the account chip goes into
 *    `conversation.header.leading` instead: also the titlebar, also before the
 *    session title, but declared with `replaceRisk: none` and unoccupied.
 *  - `sidebar.brand.mark` and `sidebar.brand.name` are `single` slots whose
 *    documented purpose is to replace the shipped brand fallback, so occupying them
 *    is the intended use rather than a shadowing accident.
 *  - `sidebar.footer.action` is a `list` slot with `replaceRisk: none`, which is why
 *    the plugin entry lives there rather than replacing `sidebar.settings`: it sits
 *    beside Settings at the foot without displacing the shell's own trigger.
 */

import React from 'react';

import { installStyles } from './theme.js';
import { PATCH_STYLES, AccountChip, BrandMark, BrandName, useInterfacePatches } from './interface-patches.js';
import { SettingsPage, SettingsProvider, useSettings } from './settings-page.js';
import { I18nProvider, useT } from './i18n-react.js';
import { api } from './data.js';
import { formatNumber } from './format.js';
import { DisplayPanel } from './panel-display.js';
import { UsagePanel } from './panel-usage.js';
import { BackupPanel } from './panel-backup.js';
import { RetryPanel } from './panel-retry.js';
import { InterfacePanel } from './panel-interface.js';
import { PromptPanel, RemotePanel, ToolboxPanel } from './panel-misc.js';
import { InsightPage } from './panel-insight.js';
import { insightOpen, useValue } from './store.js';

const h = React.createElement;

/** Registration ids. The settings section id is also the icon slot's key. */
const IDS = {
  settings: 'mydsh',
  brandMark: 'mydsh-brand-mark',
  brandName: 'mydsh-brand-name',
  account: 'mydsh-account-chip',
  entry: 'mydsh-entry',
  entryIcon: 'mydsh-entry-icon',
  insight: 'mydsh-insight',
};

/** Which settings section panel renders for each tab. */
const PANELS = {
  display: DisplayPanel,
  interface: InterfacePanel,
  usage: UsagePanel,
  backup: BackupPanel,
  retry: RetryPanel,
  prompt: PromptPanel,
  remote: RemotePanel,
  toolbox: ToolboxPanel,
};

/** The context every settings surface needs, so one provider serves them all. */
function Providers({ ctx, children }) {
  return h(I18nProvider, { ctx }, h(SettingsProvider, null, children));
}

/**
 * The insight page's seat in `shell.overlay`.
 *
 * It renders nothing while closed. Escape closes it, matching every other overlay in the
 * shell, and the listener is only attached while open so a closed page costs no handlers.
 */
function InsightOverlay() {
  const open = useValue(insightOpen);

  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') insightOpen.set(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  return h(InsightPage, { onClose: () => insightOpen.set(false) });
}

/**
 * The settings page root.
 *
 * This is the one component that owns the settings document for every panel, so it
 * also owns the interface patches: a change made in a panel must take effect in the
 * same render, not on the next reload.
 */
function MyDshSettingsPage({ ctx }) {
  return h(Providers, { ctx }, h(SettingsGate, null));
}

function SettingsGate() {
  const t = useT();
  const { settings, loading, error } = useSettings();
  useInterfacePatches(settings);

  if (loading && settings === undefined) {
    return h('div', { className: 'mydsh mydsh-page' },
      h('div', { className: 'mydsh-hint' }, t('common.loading')),
    );
  }
  if (settings === undefined) {
    return h('div', { className: 'mydsh mydsh-page' },
      h('div', { className: 'mydsh-title' }, h('h2', null, t('nav.title'))),
      h('div', { className: 'mydsh-error' }, error ?? t('error.hostUnreachable')),
    );
  }
  return h(SettingsPage, { panels: PANELS });
}

/**
 * Brand mark occupant.
 *
 * The owner passes `size`, which must be honoured or the mark will not line up with
 * the rail. Visibility is CSS-driven so the switch can restore it without a reload.
 *
 * The plugin's own mark shows when `display.brandMark` is on; otherwise the shipped
 * mark is left alone unless the user hid it, in which case nothing renders.
 */
function BrandMarkSlot({ size }) {
  const { settings } = useSettings();
  const display = settings?.display ?? {};
  const usable = typeof size === 'number' ? size : 24;

  if (display.hideBrandMark === true) return null;
  if (display.brandMark === true) return h(BrandMark, { size: usable });
  // Occupying the slot at all would hide the shipped mark, so hand it back by
  // rendering nothing only when the user explicitly asked for that; otherwise the
  // shell's own fallback is what should appear.
  return null;
}

function BrandNameSlot() {
  const { settings } = useSettings();
  const display = settings?.display ?? {};
  const t = useT();

  if (display.hideBrandName === true) return null;
  if (display.brandName === true) return h(BrandName, { label: t('nav.title') });
  return null;
}

/** The account chip, mounted only when the user asked for it. */
function AccountSlot({ ctx }) {
  const { settings } = useSettings();
  if (settings?.interface?.enabled !== true) return null;
  if (settings?.display?.accountMenuInTitlebar !== true) return null;
  return h(AccountChip, { ctx });
}

/**
 * Today's token count, shown beside the entry.
 *
 * The number comes from the same aggregate the dashboard uses, requested with the
 * `today` preset so the two can never disagree about what "today" means. It is fetched
 * once on mount rather than polled: the badge is a glance, and a timer here would cost
 * a request per minute for a number nobody watches that closely. A failure leaves the
 * badge empty rather than showing a stale or invented figure.
 */
function useTodayTokens(enabled) {
  const [total, setTotal] = React.useState(undefined);

  React.useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let timer;
    const read = () => {
      api.usage({ range: 'today' })
        .then((data) => {
          if (!cancelled && typeof data?.totals?.total === 'number') setTotal(data.totals.total);
        })
        .catch(() => {
          // A missing number is honest; a wrong one is not.
        })
        .finally(() => {
          // Refreshing slowly keeps the figure useful across a long session without
          // making the badge a source of steady load.
          if (!cancelled) timer = setTimeout(read, 5 * 60 * 1000);
        });
    };
    read();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [enabled]);

  return total;
}

/**
 * The plugin's sidebar entry.
 *
 * This is a button beside Settings rather than a replacement for it, which is what
 * makes the entry removable without losing access to the shell's own settings. It
 * renders nothing unless `display.entry` is `sidebar`.
 *
 * `wide` comes from the slot owner and says whether the column renders as a full row
 * or a 56px rail. The owner also drops the label in rail state, so the mark alone
 * carries identity there. Reading the prop is what keeps the two forms in step with
 * the sidebar rather than guessing from CSS.
 *
 * Selecting it asks the layout service to show the settings panel. That service is the
 * shell's own navigation contract, so the button moves the user to a real page instead
 * of drawing an overlay of its own.
 */
function SidebarEntry({ ctx, wide }) {
  const { settings } = useSettings();
  const t = useT();
  const display = settings?.display ?? {};
  const showBadge = display.entry === 'sidebar' && display.sidebarBadge === true;
  const today = useTodayTokens(showBadge);
  if (display.entry !== 'sidebar') return null;

  const openPlugin = () => {
    try {
      ctx?.get?.('layout')?.selectPanel?.('settings');
    } catch {
      // A build without the layout service leaves the button inert rather than
      // throwing inside a click handler.
    }
  };

  return h('button', {
    type: 'button',
    className: 'mydsh-entry',
    'data-wide': wide === false ? 'false' : 'true',
    title: t('nav.title'),
    'aria-label': t('nav.title'),
    onClick: openPlugin,
  },
    h(BrandMark, { size: wide === false ? 18 : 16, label: t('nav.title') }),
    wide === false ? null : h('span', { className: 'mydsh-entry-label' }, t('nav.title')),
    // The count is a secondary cue, so it only appears in the wide row where there is
    // room for it; the rail has none.
    wide === false || showBadge !== true || today === undefined
      ? null
      : h('span', { className: 'mydsh-entry-count' }, formatNumber(today)),
  );
}

/**
 * Registration helper.
 *
 * `ctx.slots.inject` defers until the slot exists, which makes ordering irrelevant.
 * The callback returns the disposer from `register`, so this wrapper passes it
 * through untouched.
 */
function mount(ctx, slotName, options, Component) {
  const injected = ctx.slots.inject(slotName, () => ctx.slots.register(options, Component));
  return typeof injected === 'function' ? injected : () => {};
}

export const name = 'dsh-mydsh';

export const inject = ['slots', 'locale', 'theme', 'uiWorkspace'];

/**
 * Stylesheets, injected at module scope.
 *
 * Every shipped DSH plugin does this exactly once, at the top of its factory body:
 * build a `<style>`, tag it with `data-plugin` / `data-plugin-css`, and append it to
 * `<head>`. The `styles` name in the module-loader environment is not a Client
 * service and there is no `ctx.styles`, so reaching for one silently produces an
 * unstyled page — which is precisely the failure this avoids.
 *
 * Injection happens here rather than inside `apply` because the stylesheets are
 * evaluated once per module materialization and the loader memoizes that; mounting
 * them in `apply` would also work but would re-register on every reload.
 */
installStyles(insertCss);
insertCss(PATCH_STYLES);

/**
 * Insert a stylesheet once, keyed by a stable tag id.
 *
 * Duplicate detection matches the shipped pattern so a hot reload of this module
 * does not stack identical sheets in the document.
 */
function insertCss(css, tagId = 'dsh-mydsh/app.css') {
  if (typeof document === 'undefined') return undefined;
  const selector = `style[data-plugin-css=${JSON.stringify(tagId)}]`;
  if (document.querySelector(selector) !== null) return undefined;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-mydsh';
  tag.dataset.pluginCss = tagId;
  tag.textContent = css;
  document.head.appendChild(tag);
  return () => {
    tag.remove();
  };
}

/**
 * Activation.
 *
 * Every mount is wrapped so a missing slot or a render-time throw in one surface
 * cannot stop the others.
 */
export function apply(ctx) {
  const disposers = [];
  const guard = (label, fn) => {
    try {
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
    } catch (error) {
      ctx.logger?.warn?.(`dsh-mydsh: cannot mount ${label}: ${error?.message ?? error}`);
    }
  };

  // The settings page: one tab per capability. `label` is re-read on every
  // projection, so a locale change repaints the nav entry without re-registering.
  guard('settings.section', () =>
    mount(ctx, 'settings.section', {
      name: 'settings.section',
      id: IDS.settings,
      order: 40,
      label: () => navLabel(ctx),
    }, () => h(MyDshSettingsPage, { ctx })),
  );

  // Nav icon for that section. The id must match the section id or it never renders.
  guard('settings.section.icon', () =>
    mount(ctx, 'settings.section.icon', {
      name: 'settings.section.icon',
      id: IDS.settings,
      order: 40,
    }, () => h(BrandMark, { size: 16 })),
  );

  // The plugin's own entry at the sidebar foot, beside Settings. The owner passes
  // `wide`, which this forwards so the row and rail forms stay in step with the
  // column instead of being guessed from CSS.
  guard('sidebar.footer.action', () =>
    mount(ctx, 'sidebar.footer.action', {
      name: 'sidebar.footer.action',
      id: IDS.entry,
      order: 10,
      label: () => navLabel(ctx),
    }, (props) => h(Providers, { ctx }, h(SidebarEntry, { ctx, wide: props?.wide }))),
  );

  // Brand replacements, each gated inside its own component.
  guard('sidebar.brand.mark', () =>
    mount(ctx, 'sidebar.brand.mark', {
      name: 'sidebar.brand.mark',
      id: IDS.brandMark,
      order: 10,
    }, (props) => h(Providers, { ctx }, h(BrandMarkSlot, { size: props?.size }))),
  );

  guard('sidebar.brand.name', () =>
    mount(ctx, 'sidebar.brand.name', {
      name: 'sidebar.brand.name',
      id: IDS.brandName,
      order: 10,
    }, () => h(Providers, { ctx }, h(BrandNameSlot, null))),
  );

  // Titlebar account chip. `conversation.header.leading` is unoccupied and carries
  // no shadowing risk, unlike `shell.leading`.
  guard('conversation.header.leading', () =>
    mount(ctx, 'conversation.header.leading', {
      name: 'conversation.header.leading',
      id: IDS.account,
      order: 10,
    }, () => h(Providers, { ctx }, h(AccountSlot, { ctx }))),
  );

  // The cross-session insight page. `shell.overlay` is a list slot with
  // `replaceRisk: none` that floats above every column, so the page can be added without
  // occupying `main` (keyed by sidebar entry id, and where the conversation renders).
  // Nothing is drawn while closed, so the closed state costs one empty component.
  guard('shell.overlay', () =>
    mount(ctx, 'shell.overlay', {
      name: 'shell.overlay',
      id: IDS.insight,
      order: 40,
    }, () => h(Providers, { ctx }, h(InsightOverlay, null))),
  );

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        // A disposer that throws must not stop the remaining ones.
      }
    }
  };
}

/**
 * The localized nav label.
 *
 * The slot contract allows `label` to be a thunk, which the shell re-reads on every
 * projection — so reading the translator here makes the tab follow the app's
 * language without re-registering the slot.
 */
function navLabel(ctx) {
  try {
    const bound = ctx?.get?.('locale')?.bind?.('mydsh');
    const text = bound?.('nav.title');
    if (typeof text === 'string' && text !== 'nav.title') return text;
    const active = ctx?.get?.('locale')?.getLocale?.()?.active;
    return active === 'zh' ? '我的DSH' : 'My DSH';
  } catch {
    return '我的DSH';
  }
}

/** Exported for tests and diagnostics. */
export const internals = { PANELS, IDS };
