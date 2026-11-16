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
import { formatNumber, formatMoney } from './format.js';
import { Icon } from './ui.js';
import { DisplayPanel } from './panel-display.js';
import { UsagePanel } from './panel-usage.js';
import { BackupPanel } from './panel-backup.js';
import { RetryPanel } from './panel-retry.js';
import { InterfacePanel } from './panel-interface.js';
import { PromptPanel, RemotePanel, ToolboxPanel } from './panel-misc.js';
import { InsightPage } from './panel-insight.js';
import { FleetPage } from './panel-fleet.js';
import { insightOpen, usageOpen, fleetState, openFleet, closeFleet, useValue } from './store.js';

const h = React.createElement;

/** Registration ids. The settings section id is also the icon slot's key. */
const IDS = {
  settings: 'mydsh',
  brandMark: 'mydsh-brand-mark',
  brandName: 'mydsh-brand-name',
  account: 'mydsh-account-chip',
  entry: 'mydsh-entry',
  titlebarEntry: 'mydsh-titlebar-entry',
  entryIcon: 'mydsh-entry-icon',
  insight: 'mydsh-insight',
  usage: 'mydsh-usage',
  patches: 'mydsh-patches',
  fleet: 'mydsh-fleet',
  fleetEntry: 'mydsh-fleet-entry',
  fleetSidebar: 'mydsh-fleet-sidebar',
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
 * The usage page as a floating panel, opened from the sidebar entry.
 *
 * The sidebar entry cannot reach the shell's settings modal: its open action is an owner
 * prop of `settings.launcher`, a `single` slot the shell already occupies, so nothing else
 * can read it. Rendering the same panel here means one click from the sidebar shows the
 * numbers without leaving the conversation, while the settings page keeps its own copy.
 *
 * `Providers` supplies the i18n and settings contexts the panel reads; without them every
 * field would render against `undefined`.
 */
/**
 * The rail icon for the plugin's own main panel.
 *
 * `sidebar.panellist` supplies the square edge it reserved and whether the panel is
 * selected, so the mark follows the column's geometry and highlight state instead of
 * guessing either from CSS.
 */
function PanelIcon({ size, active }) {
  const edge = typeof size === 'number' && size > 0 ? size : 20;
  return h('span', {
    className: 'mydsh-panel-icon',
    'data-active': active === true ? 'true' : 'false',
  }, h(BrandMark, { size: edge }));
}

/**
 * The page the rail icon selects, rendered in the central column.
 *
 * This is the plugin's primary surface: everything the plugin does lives here, addressed by
 * the tab bar inside it. It replaces the shell's conversation view only while selected,
 * because `main` is keyed and the conversation keeps its own key.
 */
function MyDshMainPanel({ ctx }) {
  return h(Providers, { ctx },
    h('div', { className: 'mydsh mydsh-main' },
      h(SettingsGate, null),
    ),
  );
}

/**
 * Token and cost at the sidebar foot.
 *
 * The user asked for the numbers only — the product name belongs on the rail icon, which is
 * the thing that identifies the plugin. In the collapsed rail there is no room for figures,
 * so it renders the icon alone rather than a truncated string.
 */
function SidebarUsageReadout({ wide }) {
  const { settings } = useSettings();
  const t = useT();
  const display = settings?.display ?? {};
  if (display.enabled !== true) return null;
  // `usagePlacement` decides where the numbers appear. It was declared with four options and
  // read nowhere, so choosing a position changed nothing. `sidebar` is the default seat; the
  // other three are handled by their own hosts (the titlebar chip and the main panel), and
  // `off` hides the readout entirely.
  if (display.usagePlacement === 'off') return null;
  if (display.usagePlacement === 'titlebar') return null;
  if (display.usagePlacement !== 'sidebar' && display.usagePlacement !== 'panel') return null;

  const show = display.sidebarBadge === true;
  const today = useTodayTokens(show);
  const collapsed = wide === false;

  return h('div', {
    className: 'mydsh-readout',
    'data-wide': collapsed ? 'false' : 'true',
    title: t('nav.title'),
  },
    collapsed
      ? h(BrandMark, { size: 16 })
      : h(React.Fragment, null,
        h('span', { className: 'mydsh-readout-tokens' },
          today === undefined ? '—' : formatNumber(today) + ' Token'),
        h('span', { className: 'mydsh-readout-label' }, t('nav.tokensToday')),
      ),
  );
}

/**
 * Applies the shell appearance patches and renders nothing.
 *
 * Seated in `shell.overlay` so it stays mounted for the whole plugin lifetime; see the
 * mount site for why the settings page was the wrong home for this effect.
 */
function ShellPatches() {
  const { settings } = useSettings();
  useInterfacePatches(settings);
  return null;
}

function UsageOverlay({ ctx }) {  const open = useValue(usageOpen);

  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') usageOpen.set(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  return h('div', {
    className: 'mydsh-usage-backdrop',
    // Clicking the dimmed area closes, matching every other modal in the shell. The panel
    // stops propagation so a click inside does not close it.
    onClick: () => usageOpen.set(false),
  },
    h('div', {
      className: 'mydsh-usage-panel',
      role: 'dialog',
      'aria-modal': 'true',
      onClick: (event) => event.stopPropagation(),
    },
      h(Providers, { ctx },
        h(UsagePanelShell, { onClose: () => usageOpen.set(false) }),
      ),
    ),
  );
}

/**
 * Heading row plus the shared usage panel.
 *
 * The heading is a sibling of the scrolling body, not inside it: when the whole panel
 * scrolled, the close button drifted up with the content and could be scrolled out of reach.
 * The frame now stays put and only `.mydsh-usage-body` scrolls.
 */
function UsagePanelShell({ onClose }) {
  const t = useT();
  return h(React.Fragment, null,
    h('div', { className: 'mydsh-usage-head' },
      h('h2', { className: 'mydsh-usage-title' }, t('nav.title')),
      h('button', {
        type: 'button',
        className: 'mydsh-btn mydsh-btn-sm',
        onClick: onClose,
        'aria-label': t('common.close'),
      }, t('common.close')),
    ),
    h('div', { className: 'mydsh-usage-body' }, h(UsagePanel, null)),
  );
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
 * The agent-family page, in the same floating layer as the insight page.
 *
 * It is a second overlay rather than a second tab of the first because the two answer
 * different questions and are opened from different places: insight from the usage panel,
 * family from a session's own header.
 *
 * The family's Escape handler lives in the page itself, which is why this wrapper does not
 * duplicate it; only the visibility check belongs here.
 */
function FleetOverlay() {
  const state = useValue(fleetState);
  if (!state.open) return null;
  return h(FleetPage, { sessionId: state.sessionId, onClose: closeFleet });
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
 * The way into the agent-family page.
 *
 * It lives in `conversation.session.header.actions`, which is a `list` slot with
 * `replaceRisk: none` scoped to one session — so it appears only where a family exists,
 * and it arrives with the `sessionId` the page needs.
 *
 * A control with no session renders nothing rather than an inert button: a family page
 * with no subject has nothing to show.
 */
function FleetEntry({ sessionId }) {
  const t = useT();
  const { settings } = useSettings();
  // Placement is a display setting, so the entry follows it: header (the only seat that
  // hands over a session id), the sidebar foot, or nowhere.
  const placement = settings?.display?.fleetPlacement ?? 'header';
  if (placement !== 'header') return null;
  if (settings?.display?.enabled === false) return null;
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  return h('button', {
    type: 'button',
    className: 'mydsh-btn mydsh-btn-ghost mydsh-fleet-entry',
    title: t('fleet.entryHint'),
    'aria-label': t('fleet.open'),
    onClick: () => openFleet(sessionId),
  },
    h(Icon, { name: 'layers', size: 15 }),
    h('span', null, t('fleet.open')),
  );
}

/**
 * The agent-family entry when it is placed at the sidebar foot.
 *
 * This seat carries no session id, so it asks the Host for the most recently active live
 * agent: a family always belongs to some session, and the entry point is not scoped to
 * one. That is why `header` is the default placement and this is the alternative.
 */
function SidebarFleetEntry({ wide }) {
  const { settings } = useSettings();
  const t = useT();
  const display = settings?.display ?? {};
  if (display.fleetPlacement !== 'sidebar' || display.enabled === false) return null;

  const label = t('fleet.open');
  return h('button', {
    type: 'button',
    className: 'mydsh-btn mydsh-btn-ghost mydsh-fleet-entry',
    title: t('fleet.entryHint'),
    'aria-label': label,
    onClick: () => openFleet(''),
  },
    h(Icon, { name: 'layers', size: 15 }),
    wide === false ? null : h('span', null, label),
  );
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

  return h(PluginEntryButton, { wide, today, showBadge });
}

/**
 * The plugin entry as a titlebar control.
 *
 * `display.entry` offers `sidebar`, `settings`, `titlebar`, and `hidden`, but only the
 * sidebar seat was implemented: choosing any other value left the plugin with no entry at
 * all, which reads as "the plugin is broken" rather than "the entry is elsewhere". This is
 * the titlebar form, seated in `conversation.header.leading` — the same row the sidebar
 * header renders, so it appears beside the conversation title.
 */
function TitlebarEntry({ ctx }) {
  const { settings } = useSettings();
  const display = settings?.display ?? {};
  if (display.entry !== 'titlebar') return null;
  return h(PluginEntryButton, { wide: false, today: undefined, showBadge: false, compact: true });
}

/**
 * The button itself, shared by every seat so the icon, label and action cannot drift apart.
 *
 * Clicking opens the plugin's own floating usage panel. It used to call
 * `layout.selectPanel('settings')`, which silently did nothing: `selectPanel` takes a
 * registered *main* panel key and throws for anything else, and the try/catch that was
 * meant to keep the handler safe also swallowed the failure — so the button looked dead.
 */
function PluginEntryButton({ wide, today, showBadge, compact }) {
  const t = useT();
  const open = () => usageOpen.set(true);

  return h('button', {
    type: 'button',
    className: compact === true ? 'mydsh-entry mydsh-entry-compact' : 'mydsh-entry',
    'data-wide': wide === false ? 'false' : 'true',
    title: t('nav.title'),
    'aria-label': t('nav.title'),
    onClick: open,
  },
    h(BrandMark, { size: compact === true ? 16 : (wide === false ? 18 : 16), label: t('nav.title') }),
    compact === true || wide === false ? null : h('span', { className: 'mydsh-entry-label' }, t('nav.title')),
    // The count is a secondary cue, so it only appears where there is room for it.
    compact === true || wide === false || showBadge !== true || today === undefined
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

  // The way in.
  //
  // Two registrations are needed and both are load-bearing: `sidebar.panellist` draws the
  // icon in the left rail, and `main` supplies the page it selects. The slot catalog states
  // the contract — "Each list id addresses the matching main panel" — so an icon without a
  // matching main key is a dead button, which is exactly what the first version shipped.
  //
  // `dsh-context` is the working precedent in this profile; it registers both under one id
  // and gates them together.
  guard('main', () =>
    mount(ctx, 'main', {
      name: 'main',
      key: IDS.settings,
    }, () => h(Providers, { ctx }, h(MyDshMainPanel, { ctx }))),
  );

  guard('sidebar.panellist', () =>
    mount(ctx, 'sidebar.panellist', {
      name: 'sidebar.panellist',
      id: IDS.settings,
      order: 30,
      label: () => navLabel(ctx),
    }, () => h(PanelIcon)),
  );

  // The sidebar foot keeps only the token/price readout — no product name. It is a readout,
  // not a second way in, so it does not compete with the rail icon for the click.
  guard('sidebar.footer.action', () =>
    mount(ctx, 'sidebar.footer.action', {
      name: 'sidebar.footer.action',
      id: IDS.entry,
      order: 10,
      label: () => navLabel(ctx),
    }, (props) => h(Providers, { ctx }, h(SidebarUsageReadout, { wide: props?.wide }))),
  );

  // The agent-family entry when the user places it at the sidebar foot. It shares the
  // seat with the plugin entry, ordered after it so Settings stays first.
  guard('sidebar.footer.action', () =>
    mount(ctx, 'sidebar.footer.action', {
      name: 'sidebar.footer.action',
      id: IDS.fleetSidebar,
      order: 20,
    }, (props) => h(Providers, { ctx }, h(SidebarFleetEntry, { wide: props?.wide }))),
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

  // Titlebar account chip.
  //
  // `conversation.header.leading` is a `single` slot: whoever registers takes the seat
  // outright, whether or not it renders anything. Claiming it unconditionally blocked the
  // titlebar entry from sitting beside it and held the seat even with the feature switched
  // off, so the chip goes to the header's `utilities` list instead — the seat built for
  // more than one occupant. `AccountSlot` still decides for itself whether to draw.
  guard('conversation.session.header.utilities', () =>
    mount(ctx, 'conversation.session.header.utilities', {
      name: 'conversation.session.header.utilities',
      id: IDS.account,
      // Ahead of the titlebar entry so the chip keeps its usual leading position.
      order: 70,
    }, () => h(Providers, { ctx }, h(AccountSlot, { ctx }))),
  );

  // The plugin entry when the user places it in the titlebar.
  //
  // `conversation.header.leading` is a `single` slot, so registering here would *replace*
  // the account chip rather than sit beside it; `conversation.session.header.utilities` is
  // a `list`, which is the seat that allows more than one occupant.
  guard('conversation.session.header.utilities', () =>
    mount(ctx, 'conversation.session.header.utilities', {
      name: 'conversation.session.header.utilities',
      id: IDS.titlebarEntry,
      order: 80,
    }, () => h(Providers, { ctx }, h(TitlebarEntry, { ctx }))),
  );

  // Applying the shell patches.
  //
  // This lives in `shell.overlay` — not in the settings page — because it must run for as
  // long as the plugin is loaded. When it lived inside the settings page, closing that page
  // ran the effect cleanup, which stripped the body attributes and undid every appearance
  // patch: "hide the new-session button" looked like it worked and then reverted. It renders
  // nothing; the entry exists only to own the effect.
  guard('shell.overlay', () =>
    mount(ctx, 'shell.overlay', {
      name: 'shell.overlay',
      id: IDS.patches,
      order: 10,
    }, () => h(Providers, { ctx }, h(ShellPatches, null))),
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

  guard('shell.overlay', () =>
    mount(ctx, 'shell.overlay', {
      name: 'shell.overlay',
      id: IDS.usage,
      // The lowest order of the three: the usage panel is what the sidebar entry opens, so
      // it can end up underneath the insight or family page rather than over them.
      order: 30,
    }, () => h(UsageOverlay, { ctx })),
  );

  // The agent-family page shares the floating layer, ordered after the insight page so
  // that opening one and then the other leaves the newer arrival on top.
  guard('shell.overlay', () =>
    mount(ctx, 'shell.overlay', {
      name: 'shell.overlay',
      id: IDS.fleet,
      order: 50,
    }, () => h(Providers, { ctx }, h(FleetOverlay, null))),
  );

  // The way in: one control in the session header, beside the title. This slot is
  // session-scoped and hands its occupants `sessionId`, which is exactly what a family
  // needs — the Host has no notion of "the current session", so the opener must supply it.
  guard('conversation.session.header.actions', () =>
    mount(ctx, 'conversation.session.header.actions', {
      name: 'conversation.session.header.actions',
      id: IDS.fleetEntry,
      order: 20,
      label: () => textFor(ctx, 'fleet.open', '代理家族'),
    }, (props) => h(Providers, { ctx }, h(FleetEntry, { sessionId: props?.sessionId }))),
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
 * Read one dictionary entry through the app's own locale service.
 *
 * The slot contract allows `label` to be a thunk, which the shell re-reads on every
 * projection — so resolving the text here makes the seat follow the app's language
 * without re-registering the slot. `fallback` covers the window before the locale
 * service is reachable, which is also what a missing key would otherwise print.
 */
function textFor(ctx, key, fallback) {
  try {
    const bound = ctx?.get?.('locale')?.bind?.('mydsh');
    const text = bound?.(key);
    if (typeof text === 'string' && text !== key) return text;
  } catch {
    // A locale service that throws must not cost the caller its label.
  }
  return fallback;
}

/**
 * The localized nav label.
 */
function navLabel(ctx) {
  const active = (() => {
    try {
      return ctx?.get?.('locale')?.getLocale?.()?.active;
    } catch {
      return undefined;
    }
  })();
  const fallback = active === 'zh' ? '我的DSH' : 'My DSH';
  return textFor(ctx, 'nav.title', fallback);
}

/** Exported for tests and diagnostics. */
export const internals = { PANELS, IDS };
