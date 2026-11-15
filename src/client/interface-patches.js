/**
 * Interface patches applied to the shell itself.
 *
 * These are the features that change what the shell looks like, as opposed to the
 * settings panels that describe it. Each patch is independent: disabling one
 * removes only its own DOM effect, which is why they are separate components
 * registered into separate slots rather than one big observer.
 *
 * The shell exposes no API for "hide this button", so hiding works by marking a
 * stable ancestor with a data attribute and letting CSS in theme.js do the rest.
 * A CSS-only approach survives re-renders that a DOM-removal approach would fight.
 */
import React from 'react';

const h = React.createElement;

/**
 * Inject a rulesheet for the interface patches.
 *
 * This is a second sheet rather than part of theme.js because every rule is
 * conditional on a setting, and a setting can change while the page is open. The
 * rules key off a body-level attribute so toggling is one attribute write.
 *
 * The selectors target `data-slot`, which is what the slot runtime actually
 * emits: every outlet renders `<div data-slot="<key>">`. Hiding the outlet is
 * therefore a pure CSS change that survives re-renders, unlike removing a DOM
 * node the shell would recreate.
 *
 * `sidebar.brand.mark` and `sidebar.brand.name` need no rule here: they are
 * `single` slots whose occupant is this plugin, so returning null already removes
 * the content.
 */
export const PATCH_STYLES = `
/* Hiding the new-session action. The slot is an HOC wrapping the button, so its
   outlet is the element to collapse. */
body[data-mydsh-hide-new-session='true'] [data-slot='sidebar.session.action'] {
  display: none !important;
}

/* Compact sidebar: tighten the vertical rhythm of the session list without
   touching its internal spacing variables, which the shell also owns. */
body[data-mydsh-compact='true'] [data-slot='sidebar.workspaces'] [data-slot] {
  margin-top: 0;
  margin-bottom: 0;
}
body[data-mydsh-compact='true'] [data-slot='sidebar.workspaces'] {
  --dsh-sidebar-row-gap: 0px;
}

/* The account chip sits in the conversation header's leading seat, which the
   shell already lays out as a flex row; it only needs pointer events and a
   positioning context for its menu. */
[data-slot='conversation.header.leading'] {
  position: relative;
  -webkit-app-region: no-drag;
}
`;

/**
 * Apply the settings that are pure CSS to the document.
 *
 * Writing attributes (instead of rendering components) means the patch costs one
 * DOM write per change and nothing per frame.
 *
 * The values come from the `display` section, which is the single source of truth for
 * placement and appearance. Reading `interface` instead would leave every flag stuck:
 * the panels write `display`, so the attribute was never set no matter what the user
 * chose.
 */
export function applyInterfacePatches(settings) {
  const body = document.body;
  if (body === null) return;
  const display = settings?.display ?? {};
  const on = settings?.display?.enabled === true;

  const flag = (name, value) => {
    const attribute = `data-mydsh-${name}`;
    if (on && value === true) body.setAttribute(attribute, 'true');
    else body.removeAttribute(attribute);
  };

  // The brand mark and name are handled by their own slots, which return null when
  // hidden. No CSS flag is needed for them, and emitting an unused attribute would
  // suggest a mechanism that does not exist.
  flag('hide-new-session', display.hideNewSessionButton);
  flag('compact', display.compactSidebar);
}

/** Hook that applies patches whenever the settings snapshot changes. */
export function useInterfacePatches(settings) {
  React.useEffect(() => {
    applyInterfacePatches(settings);
    return () => {
      // Unloading must not leave the shell hidden.
      for (const name of ['hide-new-session', 'compact']) {
        document.body?.removeAttribute(`data-mydsh-${name}`);
      }
    };
  }, [settings]);
}

/**
 * Brand mark replacement.
 *
 * Registered into `sidebar.brand.mark` as a chain so it can replace the product
 * logo without removing the slot's other occupants.
 */
export function BrandMark({ size = 24, label }) {
  // The slot owner publishes the square edge it reserved; ignoring it would
  // misalign the mark in the collapsed rail.
  const edge = typeof size === 'number' && size > 0 ? size : 24;
  return h('span', {
    className: 'mydsh-brandmark',
    title: label ?? '我的DSH',
    style: { width: edge, height: edge, borderRadius: Math.max(4, Math.round(edge / 4)) },
  },
    h('svg', {
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2.1,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      style: { width: Math.round(edge * 0.62), height: Math.round(edge * 0.62) },
    }, h('path', { d: 'M4 17V9m5 8V5m5 12v-6m5 6V7' })),
  );
}

/** Product name replacement. */
export function BrandName({ label }) {
  return h('span', { className: 'mydsh-brandname' }, label ?? '我的DSH');
}

/**
 * Titlebar account chip.
 *
 * The requirement is that the account actions live where the application title
 * is, showing only an avatar until clicked. The shell's account state is not
 * exported, so this renders the actions as links into the settings page and the
 * account route rather than re-implementing sign-out.
 */
export function AccountChip({ ctx }) {
  const [open, setOpen] = React.useState(false);
  const wrapper = React.useRef(null);

  // Close on outside click: a menu that stays open over the conversation is in
  // the way, and there is no shell primitive to defer to.
  React.useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (wrapper.current !== null && !wrapper.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const go = (route) => {
    setOpen(false);
    try {
      // `layout` is the shell's navigation service; falling back to a hash keeps
      // the action harmless if the service shape differs.
      if (typeof ctx?.layout?.open === 'function') ctx.layout.open(route);
      else window.location.hash = `#${route}`;
    } catch {
      window.location.hash = `#${route}`;
    }
  };

  return h('div', { ref: wrapper, style: { position: 'relative' } },
    h('button', {
      type: 'button',
      className: 'mydsh-account-chip',
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      onClick: () => setOpen((value) => !value),
      title: 'Account',
    },
      h('span', { className: 'mydsh-avatar' }, h(AvatarGlyph, null)),
    ),
    open
      ? h('div', { className: 'mydsh-menu', role: 'menu' },
        h('button', { type: 'button', className: 'mydsh-menu-item', role: 'menuitem', onClick: () => go('settings') },
          h(Glyph, { d: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-3-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.3 8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.2V4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1z' }),
          'Settings',
        ),
        h('button', { type: 'button', className: 'mydsh-menu-item', role: 'menuitem', onClick: () => go('account') },
          h(Glyph, { d: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm7 8a7 7 0 0 0-14 0' }),
          'Account',
        ),
        h('div', { className: 'mydsh-menu-sep' }),
        h('button', {
          type: 'button',
          className: 'mydsh-menu-item',
          role: 'menuitem',
          onClick: () => go('settings'),
        },
          h(Glyph, { d: 'M21 12a8 8 0 0 1-8 8H7l-4 3v-6.5A8 8 0 0 1 13 4a8 8 0 0 1 8 8z' }),
          'Send feedback',
        ),
      )
      : null,
  );
}

function Glyph({ d }) {
  return h('svg', {
    width: 15,
    height: 15,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  }, h('path', { d }));
}

function AvatarGlyph() {
  return h(Glyph, { d: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm7 8a7 7 0 0 0-14 0' });
}
