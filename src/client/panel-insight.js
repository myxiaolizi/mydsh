/**
 * The cross-session insight page.
 *
 * Every other usage view answers "how much did I use" in aggregate. This one answers
 * "which sessions cost me the most, and do any still stand out" — it ranks all sessions by
 * cost, tokens, calls, or recency, and lets a search narrow them down.
 *
 * It renders in `shell.overlay`, a `replaceRisk: none` list that floats above every
 * column. A `main` panel would need its own sidebar row (that slot is keyed by entry id)
 * and would sit where the conversation goes; the overlay adds the page without shadowing
 * any shipped UI.
 */
import * as React from 'react';
import { useT, useLocale } from './i18n-react.js';
import { useAsync, api } from './data.js';
import { formatMoney, formatNumber, formatRelative } from './format.js';
import { Card, Empty, Segments, Sparkline, Stat } from './ui.js';

const h = React.createElement;

/** Sort keys offered by the page, in display order. */
const SORTS = [
  { value: 'cost', labelKey: 'insight.sortCost' },
  { value: 'total', labelKey: 'insight.sortTokens' },
  { value: 'calls', labelKey: 'insight.sortCalls' },
  { value: 'recent', labelKey: 'insight.sortRecent' },
];

/** How many rows the list draws before summarising the rest. */
const VISIBLE_ROWS = 50;

/** Compare two session rows for the chosen sort, biggest or newest first. */
function compare(sort, left, right) {
  if (sort === 'recent') return (right.lastTime ?? 0) - (left.lastTime ?? 0);
  const key = sort === 'calls' ? 'calls' : sort === 'total' ? 'total' : 'cost';
  return (right[key] ?? 0) - (left[key] ?? 0);
}

/**
 * Rank the sessions and report what the ranking covers.
 *
 * The totals sum the rows the Host returned, not every session on disk. The page says so
 * in a footnote, because a truncated list would otherwise read as a full-corpus total.
 */
function summarise(rows, sort, query) {
  const needle = query.trim().toLowerCase();
  const filtered = needle === ''
    ? rows
    : rows.filter((row) => {
      const title = typeof row.title === 'string' ? row.title : '';
      return title.toLowerCase().includes(needle) || String(row.sessionId).toLowerCase().includes(needle);
    });

  const ranked = [...filtered].sort((left, right) => compare(sort, left, right));
  const totals = ranked.reduce((sum, row) => ({
    total: sum.total + (row.total ?? 0),
    cost: sum.cost + (row.cost ?? 0),
    calls: sum.calls + (row.calls ?? 0),
  }), { total: 0, cost: 0, calls: 0 });

  // The bar measures whatever the ranking is sorted by, so its length always explains the
  // order. Drawing it from token count while sorting by cost made the two disagree: a
  // ¥2486 session drew a shorter bar than a ¥2410 one, because the first used fewer tokens.
  const measure = sort === 'recent'
    ? () => 0
    : (row) => (sort === 'calls' ? row.calls : sort === 'total' ? row.total : row.cost) ?? 0;
  const peak = ranked.length === 0 ? 0 : Math.max(...ranked.map(measure));

  return { rows: ranked, totals, matched: filtered.length, considered: rows.length, measure, peak };
}

/** One session row: title, share of the leader, and its spend. */
function SessionRow({ row, share }) {
  const t = useT();
  const locale = useLocale();
  const title = typeof row.title === 'string' && row.title !== ''
    ? row.title
    : `${row.sessionId.slice(0, 8)}…`;
  const when = row.lastTime > 0
    ? formatRelative(row.lastTime, Date.now(), t)
    : new Date(0).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US');

  return h('div', { className: 'mydsh-insight-row' },
    h('div', { className: 'mydsh-insight-main' },
      h('div', { className: 'mydsh-insight-title', title: row.sessionId }, title),
      h('div', { className: 'mydsh-insight-bar' },
        h('div', {
          className: 'mydsh-insight-bar-fill',
          style: { width: `${(share * 100).toFixed(1)}%` },
        }),
      ),
      h('div', { className: 'mydsh-insight-meta' },
        h('span', null, t('insight.tokens', { count: formatNumber(row.total ?? 0) })),
        h('span', null, t('insight.calls', { count: formatNumber(row.calls ?? 0) })),
        h('span', null, when),
      ),
    ),
    h('div', { className: 'mydsh-insight-cost' }, formatMoney(row.cost ?? 0)),
  );
}

/**
 * The page itself.
 *
 * `onClose` is supplied by the owner: the page reports the intent and never decides
 * whether it is visible.
 */
export function InsightPage({ onClose }) {
  const t = useT();
  const locale = useLocale();
  const [sort, setSort] = React.useState('cost');
  const [query, setQuery] = React.useState('');
  const [limit] = React.useState(200);

  const sessions = useAsync(() => api.usageSessions(limit), [limit]);

  const sortOptions = React.useMemo(
    () => SORTS.map((entry) => ({ value: entry.value, label: t(entry.labelKey) })),
    [t],
  );

  const rows = sessions.data?.rows ?? [];
  const summary = React.useMemo(() => summarise(rows, sort, query), [rows, sort, query]);

  // The shape of the ranking: the leaders' weights, so a single runaway session shows.
  const trend = React.useMemo(
    () => summary.rows.slice(0, 40).map((row) => summary.measure(row)),
    [summary],
  );

  return h('div', {
    className: 'mydsh-insight-backdrop',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': t('insight.title'),
  },
  h('div', { className: 'mydsh-insight-page' },
    h('header', { className: 'mydsh-insight-header' },
      h('div', null,
        h('h2', { className: 'mydsh-insight-heading' }, t('insight.title')),
        h('p', { className: 'mydsh-insight-sub' }, t('insight.description')),
      ),
      h('button', {
        type: 'button',
        className: 'mydsh-btn mydsh-btn-sm',
        onClick: onClose,
      }, t('common.close')),
    ),

    sessions.error === undefined ? null
      : h('p', { className: 'mydsh-hint' }, t('insight.loadFailed')),

    sessions.loading && sessions.data === undefined ? h('p', { className: 'mydsh-hint' }, t('common.loading'))
      : rows.length === 0 ? h(Empty, { title: t('usage.noSessions') })
        : h(React.Fragment, null,
          h('div', { className: 'mydsh-insight-stats' },
            h(Stat, { label: t('insight.sessionsShown'), value: formatNumber(summary.matched) }),
            h(Stat, { label: t('insight.totalTokens'), value: formatNumber(summary.totals.total) }),
            h(Stat, { label: t('usage.cost'), value: formatMoney(summary.totals.cost) }),
            h(Stat, { label: t('insight.totalCalls'), value: formatNumber(summary.totals.calls) }),
          ),

          h('div', { className: 'mydsh-insight-controls' },
            h(Segments, {
              value: sort,
              onChange: setSort,
              options: sortOptions,
              ariaLabel: t('insight.sortBy'),
            }),
            h('input', {
              type: 'search',
              className: 'mydsh-input',
              value: query,
              placeholder: t('insight.searchPlaceholder'),
              'aria-label': t('insight.searchPlaceholder'),
              onChange: (event) => setQuery(event.target.value),
            }),
          ),

          trend.length < 2 ? null : h(Card, { title: t('insight.distribution') },
            h(Sparkline, { values: trend, label: t('insight.distribution') }),
            h('p', { className: 'mydsh-hint' }, t('insight.distributionHint')),
          ),
          h(Card, { title: t('insight.ranking') },
            summary.rows.length === 0
              ? h('p', { className: 'mydsh-hint' }, t('insight.noMatch'))
              : h('div', { className: 'mydsh-insight-list' },
                summary.rows.slice(0, VISIBLE_ROWS).map((row) => h(SessionRow, {
                  key: row.sessionId,
                  row,
                  share: summary.peak > 0 ? summary.measure(row) / summary.peak : 0,
                })),
              ),
            summary.matched > VISIBLE_ROWS
              ? h('p', { className: 'mydsh-hint' },
                t('insight.truncated', { count: formatNumber(summary.matched - VISIBLE_ROWS) }))
              : null,
            // State the scope: these totals cover the rows fetched, not the whole corpus.
            h('p', { className: 'mydsh-hint' },
              t('insight.scopeNote', { count: formatNumber(summary.considered) })),
          ),
        ),
  ));
}
