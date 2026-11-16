/**
 * The agent family page.
 *
 * `dsh-context` ships this as a Fleet tab: the current agent, its parents, and every
 * subagent as one card each. The Host walks the live subagent catalogs for us
 * (`subagents.listDescendants`), so this module only has to lay the result out.
 *
 * The family is read on demand and never cached: children start and finish while the page
 * is open, so a cached tree would be wrong within seconds.
 */
import * as React from 'react';
import { useT } from './i18n-react.js';
import { Card, Stat, Badge, Empty } from './ui.js';
import { api, useAsync } from './data.js';

const h = React.createElement;

/** Depth-first, preserving the Host's pre-order so the tree reads top to bottom. */
function order(members) {
  const childrenOf = new Map();
  for (const member of members) {
    const key = member.parentId ?? null;
    const list = childrenOf.get(key) ?? [];
    list.push(member);
    childrenOf.set(key, list);
  }
  const out = [];
  const walk = (parentId, depth) => {
    for (const member of childrenOf.get(parentId) ?? []) {
      out.push({ ...member, depth });
      walk(member.id, depth + 1);
    }
  };
  // The root has no parent; anything else is an orphan and is shown at the top level so a
  // corrupt branch is visible rather than silently dropped.
  walk(null, 0);
  const seen = new Set(out.map((member) => member.id));
  for (const member of members) {
    if (!seen.has(member.id)) out.push({ ...member, depth: 0, orphan: true });
  }
  return out;
}

/** One member card: who it is, what it is doing, and how deep it sits. */
function MemberCard({ member }) {
  const t = useT();
  const isRoot = member.kind === 'root';
  const isDiagnostic = member.kind === 'diagnostic';
  const running = member.activity === 'running';

  // A diagnostic row has no name of its own, so it is labelled by what went wrong rather
  // than by a truncated id — the id is still in the tooltip.
  const label = member.label
    ?? member.name
    ?? (isRoot
      ? t('fleet.root')
      : isDiagnostic
        ? t('fleet.diagnosticLabel')
        : `${String(member.id).slice(0, 8)}…`);

  // The root's activity is not reported by the Host, so "idle" would be a guess about the
  // one member we know is running this page.
  const state = isDiagnostic
    ? t(`fleet.reason.${member.reason ?? 'unavailable'}`)
    : running
      ? t('fleet.running')
      : isRoot
        ? t('fleet.rootNote')
        : t('fleet.idle');

  return h('div', {
    className: 'mydsh-fleet-member',
    'data-depth': Math.min(member.depth, 6),
    'data-state': isDiagnostic ? 'diagnostic' : running ? 'running' : 'idle',
  },
    h('div', { className: 'mydsh-fleet-line' },
      h('span', { className: 'mydsh-fleet-dot', 'data-running': running ? 'yes' : 'no' }),
      h('span', { className: 'mydsh-fleet-name', title: String(member.id) }, label),
      isRoot ? h(Badge, { tone: 'info' }, t('fleet.badgeRoot')) : null,
      isDiagnostic ? h(Badge, { tone: 'warn' }, t('fleet.badgeUnreadable')) : null,
      member.mode === 'continuable' ? h(Badge, { tone: 'muted' }, t('fleet.badgeContinuable')) : null,
    ),
    h('div', { className: 'mydsh-fleet-meta' },
      h('span', null, state),
      h('span', null, t('fleet.depth', { count: member.depth })),
      member.hasChildren ? h('span', null, t('fleet.hasChildren')) : null,
      member.path !== null && member.path !== undefined
        ? h('span', { title: member.path }, member.path)
        : null,
    ),
  );
}

/**
 * The page body.
 *
 * `sessionId` comes from the slot that opened it, because the Host has no notion of
 * "the current session": a request always names its subject.
 */
export function FleetPage({ sessionId, onClose }) {
  const t = useT();
  // An empty id means "whichever live agent is newest"; the Host resolves that, so the
  // request is still made. Only a click with no id at all would leave nothing to show.
  const family = useAsync(
    ({ signal }) => api.agentsTree(sessionId ?? ''),
    [sessionId],
    { immediate: true },
  );

  // Escape closes, matching the insight page and every other overlay in the plugin.
  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const data = family.data;
  const members = data?.members ?? [];
  const rows = order(members);
  const running = rows.filter((member) => member.activity === 'running').length;
  const deepest = rows.reduce((max, member) => Math.max(max, member.depth), 0);

  const body = (() => {
    if (family.loading === true && data === undefined) {
      return h('div', { className: 'mydsh-fleet-loading' }, t('fleet.loading'));
    }
    if (family.error !== undefined && family.error !== null) {
      return h(Empty, { title: t('fleet.failed'), hint: String(family.error.message ?? family.error) });
    }
    if (data !== undefined && data.available === false) {
      // `no-live-session` means nothing is running, which is a state rather than an error
      // and deserves the "open a session" hint rather than a failure banner.
      if (data.reason === 'no-live-session') {
        return h(Empty, { title: t('fleet.needsSession'), hint: t('fleet.needsSessionHint') });
      }
      return h(Empty, {
        title: t('fleet.unavailable'),
        hint: data.reason === 'no-subagent-service'
          ? t('fleet.noService')
          : t('fleet.unavailableHint'),
      });
    }
    if (rows.length === 0) {
      return h(Empty, { title: t('fleet.empty'), hint: t('fleet.emptyHint') });
    }
    return h('div', { className: 'mydsh-fleet-list' },
      rows.map((member) => h(MemberCard, { key: member.id, member })),
    );
  })();

  return h('div', { className: 'mydsh-insight-backdrop', onClick: onClose },
    h('div', {
      className: 'mydsh-insight-page',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': t('fleet.title'),
      onClick: (event) => event.stopPropagation(),
    },
      h('div', { className: 'mydsh-insight-header' },
        h('div', null,
          h('h2', { className: 'mydsh-insight-heading' }, t('fleet.title')),
          h('p', { className: 'mydsh-insight-sub' }, t('fleet.subtitle')),
        ),
        h('button', {
          type: 'button',
          className: 'mydsh-btn',
          onClick: onClose,
        }, t('fleet.close')),
      ),

      h('div', { className: 'mydsh-insight-stats' },
        h(Stat, { label: t('fleet.statMembers'), value: rows.length }),
        h(Stat, { label: t('fleet.statRunning'), value: running }),
        h(Stat, { label: t('fleet.statDepth'), value: deepest }),
      ),

      h(Card, { title: t('fleet.tree') }, body),

      h('p', { className: 'mydsh-hint' }, t('fleet.footnote')),
    ),
  );
}
