/**
 * The dashboard: what the plugin shows when it is first opened.
 *
 * The plugin used to land on the "where things go" settings tab, which is a configuration
 * screen — nothing about it tells a user what their token spend is doing. This page answers
 * the questions worth a first look, in order of how often they are asked:
 *
 *  - how much have I spent, and on what
 *  - how much is going in versus coming out, and how much of the input is cached
 *  - am I working today, and how has the last quarter looked
 *  - which session and which model dominate the bill
 *  - how full is the current context window
 *
 * Every number comes from the same aggregate the usage panel reads, so the two never
 * disagree. Cards are independent: a failing endpoint blanks its own card rather than the
 * page, because a dashboard that disappears when one request fails is worse than a partial
 * one.
 */
import * as React from 'react';
import { Card, Stat, Badge, Empty, Meter, AreaChart, BarList, Icon, cx, formatBytes } from './ui.js';
import { api, useAsync } from './data.js';
import { formatNumber, formatMoney, formatRelative } from './format.js';
import { useT } from './i18n-react.js';
import { useSettings } from './settings-page.js';
import { insightOpen, usageOpen } from './store.js';

const h = React.createElement;

/** Ranges offered on the dashboard. A dashboard defaults to a week; history is one click away. */
const RANGES = [
  { value: 'today', labelKey: 'usage.today' },
  { value: '7d', labelKey: 'usage.7d' },
  { value: '30d', labelKey: 'usage.30d' },
  { value: '90d', labelKey: 'usage.90d' },
  { value: 'all', labelKey: 'usage.all' },
];

/**
 * Read the dashboard's data.
 *
 * The four reads are independent so one slow endpoint does not hold the page: the hero
 * numbers come from `/usage`, the calendar from a 90-day aggregate, the ranking from the
 * session list, and the balance from its own call.
 */
function useDashboard(range) {
  const usage = useAsync(({ signal }) => api.usage({ range, groupBy: 'provider', signal }), [range]);
  const calendar = useAsync(({ signal }) => api.usage({ range: '90d', bucket: 'day', signal }), []);
  const sessions = useAsync(({ signal }) => api.usageSessions(20), []);
  const balance = useAsync(() => api.usageBalance(), []);
  return { usage, calendar, sessions, balance };
}

export function Dashboard() {
  const t = useT();
  const { settings } = useSettings();
  const [range, setRange] = React.useState('7d');
  const { usage, calendar, sessions, balance } = useDashboard(range);

  const enabled = settings?.usage?.enabled === true;
  const totals = usage.data?.totals ?? {};
  const buckets = usage.data?.buckets ?? [];
  // The first paint has no payload yet. Rendering zeros there would be a false reading — the
  // dashboard would claim "you spent nothing" for as long as the request takes, and forever if
  // it failed. Wait for the number instead.
  const settling = usage.loading === true && usage.data === undefined;

  return h('div', { className: 'mydsh-stack mydsh-dashboard' },
    // The header carries the page's identity and the one control that changes every figure.
    h('div', { className: 'mydsh-dash-head' },
      h('div', null,
        h('h2', { className: 'mydsh-dash-title' }, t('dash.title')),
        h('p', { className: 'mydsh-dash-sub' }, t('dash.subtitle')),
      ),
      h('div', { className: 'mydsh-inline' },
        h('div', { className: 'mydsh-segments', role: 'group', 'aria-label': t('usage.range') },
          RANGES.map((entry) =>
            h('button', {
              key: entry.value,
              type: 'button',
              className: 'mydsh-segment',
              'data-active': entry.value === range ? 'true' : 'false',
              onClick: () => setRange(entry.value),
            }, t(entry.labelKey)),
          ),
        ),
        // The two deeper pages live here rather than in a menu: the dashboard is the place
        // from which a user decides they want more.
        h('button', {
          type: 'button',
          className: 'mydsh-btn mydsh-btn-sm',
          onClick: () => insightOpen.set(true),
        }, h(Icon, { name: 'chart', size: 13 }), t('insight.open')),
        h('button', {
          type: 'button',
          className: 'mydsh-btn mydsh-btn-sm',
          onClick: () => usageOpen.set(true),
        }, h(Icon, { name: 'layers', size: 13 }), t('dash.fullReport')),
      ),
    ),

    enabled !== true
      ? h(Card, null,
        h(Empty, {
          title: t('usage.trackingOff'),
          hint: t('dash.trackingOffHint'),
        }),
      )
      : settling
        ? h(Card, null, h(Empty, { title: t('common.loading') }))
        : usage.error !== undefined
          ? h(Card, null, h(Empty, { title: t('error.hostUnreachable'), hint: String(usage.error?.message ?? usage.error) }))
          : h(React.Fragment, null,
        h(HeroStats, { totals, t }),
        h(SpendCurve, { buckets, t }),
        h('div', { className: 'mydsh-dash-split' },
          h(ActivityCard, { data: calendar.data, t }),
          h(BreakdownCard, { groups: usage.data?.groups, totals, t }),
        ),
        h('div', { className: 'mydsh-dash-split' },
          h(TopSessionsCard, { data: sessions.data, t }),
          h(ContextCard, { t }),
        ),
        balance.data === undefined || balance.data?.available === false
          ? null
          : h(BalanceCard, { data: balance.data, t }),
      ),
  );
}

/**
 * The four numbers worth seeing before scrolling.
 *
 * Kept to four on purpose: past that they stop reading as a summary and become a table with
 * worse alignment. The usage panel carries the full eight.
 */
function HeroStats({ totals, t }) {
  const calls = totals.calls ?? 0;
  const inputTotal = (totals.input ?? 0) + (totals.cacheRead ?? 0);
  const cacheHit = inputTotal > 0 ? (totals.cacheRead ?? 0) / inputTotal : 0;

  return h('div', { className: 'mydsh-grid' },
    h(Stat, {
      label: t('dash.spent'),
      value: formatMoney(totals.cost ?? 0),
      sub: t('dash.perCall', { v: formatMoney(calls > 0 ? (totals.cost ?? 0) / calls : 0) }),
    }),
    h(Stat, {
      label: t('usage.totalTokens'),
      value: formatNumber(totals.total ?? 0),
      sub: t('usage.callsCount', { n: formatNumber(calls) }),
    }),
    h(Stat, {
      label: t('dash.io'),
      value: formatNumber(totals.output ?? 0),
      sub: t('dash.ioHint', { n: formatNumber(totals.input ?? 0) }),
    }),
    h(Stat, {
      label: t('usage.cacheRead'),
      value: formatNumber(totals.cacheRead ?? 0),
      sub: t('usage.cacheHitRate', { p: (cacheHit * 100).toFixed(1) }),
    }),
  );
}

/** Token spend over the selected range, split into input and output. */
function SpendCurve({ buckets, t }) {
  if (buckets.length === 0) {
    return h(Card, { title: t('dash.trend') }, h(Empty, { title: t('usage.nothingRecorded') }));
  }
  const totals = buckets.map((bucket) => bucket.total ?? 0);
  const peak = Math.max(...totals, 1);

  return h(Card, {
    title: t('dash.trend'),
    description: t('dash.trendHint'),
    actions: h(Badge, { tone: 'muted' }, t('dash.peak', { n: formatNumber(peak) })),
  },
    // AreaChart takes the bucket rows plus one accessor per series; it draws the axes and the
    // hover readout, so the caller only names the fields.
    h(AreaChart, {
      buckets,
      height: 150,
      series: [
        { key: 'input', label: t('usage.input'), color: 'var(--dsw-color-accent, #4d6bfe)' },
        { key: 'output', label: t('usage.output'), color: 'var(--dsw-color-success, #16a34a)' },
      ],
    }),
  );
}

/** The 90-day calendar plus a compact summary of how much of it was active. */
function ActivityCard({ data, t }) {
  const buckets = data?.buckets ?? [];
  if (buckets.length === 0) {
    return h(Card, { title: t('usage.activity') }, h(Empty, { title: t('usage.nothingRecorded') }));
  }
  const active = buckets.filter((bucket) => (bucket.calls ?? 0) > 0);
  const busiest = buckets.reduce(
    (best, bucket) => ((bucket.total ?? 0) > (best.total ?? 0) ? bucket : best),
    buckets[0] ?? {},
  );

  return h(Card, {
    title: t('usage.activity'),
    description: t('dash.activityHint'),
  },
    h('div', { className: 'mydsh-dash-mini' },
      h('span', null, h('strong', null, formatNumber(active.length)), ' ', t('dash.activeDays')),
      h('span', null, h('strong', null, formatNumber(busiest.total ?? 0)), ' ', t('dash.busiestDay')),
    ),
  );
}

/** Which provider and model carry the bill, with the share drawn. */
function BreakdownCard({ groups, totals, t }) {
  const rows = (groups ?? [])
    .filter((group) => (group.total ?? 0) > 0)
    .slice(0, 6)
    .map((group) => ({
      key: group.key,
      label: group.key,
      value: group.cost ?? 0,
      tone: 'accent',
    }));

  if (rows.length === 0) {
    return h(Card, { title: t('usage.byProvider') }, h(Empty, { title: t('usage.nothingRecorded') }));
  }

  return h(Card, {
    title: t('dash.byProvider'),
    description: t('dash.byProviderHint'),
    actions: h(Badge, { tone: 'info' }, formatMoney(totals.cost ?? 0)),
  },
    h(BarList, { rows, formatValue: (value) => formatMoney(value), maxRows: 6 }),
  );
}

/** The sessions that cost the most, because that is the actionable list. */
function TopSessionsCard({ data, t }) {
  const rows = data?.rows ?? [];
  if (rows.length === 0) {
    return h(Card, { title: t('usage.sessions') }, h(Empty, { title: t('usage.noSessions') }));
  }
  const ranked = [...rows].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0)).slice(0, 6);
  const peak = Math.max(...ranked.map((row) => row.cost ?? 0), 1);

  return h(Card, {
    title: t('dash.topSessions'),
    description: t('dash.topSessionsHint'),
    actions: h('button', {
      type: 'button',
      className: 'mydsh-btn mydsh-btn-sm',
      onClick: () => insightOpen.set(true),
    }, t('insight.open')),
  },
    h('div', { className: 'mydsh-dash-list' },
      ranked.map((row) => {
        const title = typeof row.title === 'string' && row.title !== ''
          ? row.title
          : String(row.sessionId).slice(0, 8) + '…';
        const share = peak > 0 ? (row.cost ?? 0) / peak : 0;
        return h('div', { key: row.sessionId, className: 'mydsh-dash-row' },
          h('div', { className: 'mydsh-dash-row-main' },
            h('div', { className: 'mydsh-dash-row-title', title }, title),
            h('div', { className: 'mydsh-dash-row-bar' },
              h('div', { className: 'mydsh-dash-row-fill', style: { width: `${(share * 100).toFixed(1)}%` } }),
            ),
            h('div', { className: 'mydsh-dash-row-meta' },
              h('span', null, formatNumber(row.total ?? 0), ' Token'),
              h('span', null, t('usage.callsCount', { n: formatNumber(row.calls ?? 0) })),
              row.lastTime > 0 ? h('span', null, formatRelative(row.lastTime, Date.now(), t)) : null,
            ),
          ),
          h('div', { className: 'mydsh-dash-row-cost' }, formatMoney(row.cost ?? 0)),
        );
      }),
    ),
  );
}

/** Context-window pressure for the newest session that has usage. */
function ContextCard({ t }) {
  const sessions = useAsync(() => api.usageSessions(1), []);
  const sessionId = sessions.data?.rows?.[0]?.sessionId;
  const context = useAsync(
    ({ signal }) => api.usageContext(sessionId),
    [sessionId],
    { immediate: typeof sessionId === 'string' },
  );
  const data = context.data;

  if (data === undefined) {
    return h(Card, { title: t('usage.context') }, h(Empty, { title: t('dash.noContext') }));
  }
  if (data.available === false) {
    return h(Card, { title: t('usage.context') }, h(Empty, { title: t('usage.contextNeedsSession') }));
  }

  const ratio = typeof data.ratio === 'number' ? data.ratio : 0;
  const tone = ratio > 0.85 ? 'danger' : ratio > 0.6 ? 'warn' : 'accent';

  return h(Card, {
    title: t('usage.context'),
    description: t('usage.contextHint'),
    actions: h(Badge, { tone }, `${(ratio * 100).toFixed(1)}%`),
  },
    h('div', { className: 'mydsh-dash-context' },
      h('div', { className: 'mydsh-dash-context-value' },
        formatNumber(data.promptTokens ?? 0),
        data.contextWindow === null
          ? null
          : h('span', { className: 'mydsh-stat-unit' }, ' / ', formatNumber(data.contextWindow)),
      ),
      h(Meter, { ratio, tone }),
      h('p', { className: 'mydsh-hint' },
        t('dash.contextFooter', {
          turn: formatNumber(data.turn ?? 0),
          peak: formatNumber(data.peakPrompt ?? 0),
        }),
      ),
    ),
  );
}

/** DeepSeek account balance, when one is configured. */
function BalanceCard({ data, t }) {
  const wallets = Array.isArray(data?.wallets) ? data.wallets : [];
  if (wallets.length === 0) return null;
  return h(Card, { title: t('usage.balance') },
    h('div', { className: 'mydsh-dash-wallets' },
      wallets.map((wallet) =>
        h('div', { key: wallet.currency ?? wallet.amount, className: 'mydsh-dash-wallet' },
          h('span', { className: 'mydsh-dash-wallet-value' }, formatMoney(wallet.amount ?? 0, wallet.currency)),
          h('span', { className: 'mydsh-hint' }, wallet.currency ?? ''),
        ),
      ),
    ),
  );
}
