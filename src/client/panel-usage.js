/**
 * Usage and billing panel.
 *
 * Answers four questions in order of how often they are asked: how much did I
 * spend, where did it go, is the trend getting worse, and how full is my context
 * window. Every number comes from the Host aggregate so the panel stays a view.
 *
 * All user-facing text goes through `usePanelT`, so the panel follows whichever
 * language DSH resolved. Numbers, model ids, and units (`Token`, `ms`) stay as
 * they are: translating them would make the figures harder to compare, not easier.
 */
import React from 'react';
import { insightOpen } from './store.js';
import {
  AreaChart,
  BarList,
  Badge,
  Card,
  Empty,
  Heatmap,
  Meter,
  Segments,
  Sparkline,
  Stat,
  cx,
  formatBytes,
  formatMoney,
  formatNumber,
  formatRelative,
} from './ui.js';
import { api, useAsync } from './data.js';
import { ModuleToggle, FieldForm, useSettings } from './settings-page.js';
import { useT, useLocale, useFailureText } from './i18n-react.js';

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

/** Time ranges, matching the Host's preset names. */
const RANGES = [
  { value: 'today', labelKey: 'usage.today' },
  { value: '3d', labelKey: 'usage.3d' },
  { value: '7d', labelKey: 'usage.7d' },
  { value: '30d', labelKey: 'usage.30d' },
  { value: '90d', labelKey: 'usage.90d' },
  // The history here runs well past 90 days, so without this there was no way to see the
  // real total — the last preset still covered only a fraction of it.
  { value: 'all', labelKey: 'usage.all' },
];

/** Grouping dimensions offered by the Host aggregate. */
const DIMENSIONS = [
  { value: 'provider', labelKey: 'usage.byProvider' },
  { value: 'model', labelKey: 'usage.byModel' },
  { value: 'session', labelKey: 'usage.bySession' },
  { value: 'workspace', labelKey: 'usage.byWorkspace' },
];

const SERIES = [
  { key: 'input', labelKey: 'usage.input', color: 'var(--dsh-color-accent, #4d6bfe)' },
  { key: 'output', labelKey: 'usage.output', color: 'var(--dsh-color-success, #16a34a)' },
];

/** Budget scope choices, matching the Host's rule fields. */
const SCOPES = [
  { value: 'provider', labelKey: 'usage.scopeProvider' },
  { value: 'model', labelKey: 'usage.scopeModel' },
  { value: 'workspace', labelKey: 'usage.scopeWorkspace' },
  { value: 'session', labelKey: 'usage.scopeSession' },
];

/** Budget period choices, matching the Host's reset windows. */
const PERIODS = [
  { value: 'day', labelKey: 'usage.periodDay' },
  { value: 'week', labelKey: 'usage.periodWeek' },
  { value: 'month', labelKey: 'usage.periodMonth' },
  { value: 'total', labelKey: 'usage.periodTotal' },
];

export function UsagePanel() {
  const { settings } = useSettings();
  const t = usePanelT();
  // Day labels follow the harness language rather than the OS locale, so a user who
  // runs DSH in Chinese does not get English month names from the date formatter.
  const locale = useLocale();
  const enabled = settings?.usage?.enabled === true;
  const [range, setRange] = React.useState('7d');
  const [dimension, setDimension] = React.useState('provider');

  const usage = useAsync(
    ({ signal }) => api.usage({ range, groupBy: dimension, signal }),
    [range, dimension],
    { immediate: enabled },
  );

  // The heatmap keeps its own window. It answers "which days did I work", which only
  // means anything over months; deriving it from the range selector made a 7-day choice
  // render one thin column in a wide card. Three months is the usual calendar view, and
  // `bucket: 'day'` asks for one cell per day: the automatic scaling would fold a quarter
  // into weekly buckets and the calendar would show thirteen cells instead of ninety.
  const activity = useAsync(
    ({ signal }) => api.usage({ range: '90d', bucket: 'day', signal }),
    [],
    { immediate: enabled },
  );

  const rangeOptions = React.useMemo(
    () => RANGES.map((entry) => ({ value: entry.value, label: t(entry.labelKey) })),
    [t],
  );
  const dimensionOptions = React.useMemo(
    () => DIMENSIONS.map((entry) => ({ value: entry.value, label: t(entry.labelKey) })),
    [t],
  );
  const series = React.useMemo(
    () => SERIES.map((entry) => ({ ...entry, label: t(entry.labelKey) })),
    [t],
  );

  return h('div', { className: 'mydsh-stack', style: { gap: 'var(--mydsh-space-4)' } },
    h(ModuleToggle, {
      section: 'usage',
      titleKey: 'usage.title',
      descriptionKey: 'usage.description',
    }),

    enabled ? h(React.Fragment, null,
      h(Card, {
        title: t('usage.overview'),
        description: t('usage.overviewHint'),
        actions: h(Segments, { value: range, options: rangeOptions, onChange: setRange, ariaLabel: t('usage.range') }),
      },
        usage.loading && usage.data === undefined ? h(Loading, null)
          : usage.error !== undefined ? h(InlineError, { error: usage.error, onRetry: usage.reload })
            : usage.data?.disabled === true ? h(Empty, { title: t('usage.trackingOff') })
              : h(React.Fragment, null,
                h(Overview, { data: usage.data }),
                h('div', { className: 'mydsh-chart-legend' },
                  series.map((entry) =>
                    h('span', { key: entry.key },
                      h('i', { style: { background: entry.color } }),
                      entry.label,
                    ),
                  ),
                ),
                h(AreaChart, {
                  buckets: (usage.data?.buckets ?? []).map((bucket) => ({
                    ...bucket,
                    input: bucket.input,
                    output: bucket.output,
                    start: bucket.start,
                  })),
                  series,
                }),
              ),
      ),

      // A calendar view of the same window. The area chart answers "how much, when";
      // this answers "which days did I actually work" at a glance, which the stacked
      // chart cannot show once the window is a month or more.
      usage.data?.disabled === true ? null : h(Card, {
        title: t('usage.activity'),
        description: t('usage.activityHint'),
      },
        activity.loading && activity.data === undefined ? h(Loading, null)
          : activity.data?.disabled === true ? h(Empty, { title: t('usage.trackingOff') })
            : h(Heatmap, {
              label: t('usage.activity'),
              days: (activity.data?.buckets ?? []).map((bucket) => ({
                start: bucket.start,
                value: bucket.total,
                calls: bucket.calls,
              })),
              formatValue: (value) => t('usage.activityValue', { count: formatNumber(value) }),
              formatDay: (start) => new Date(start).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US'),
            }),
      ),

      h('div', { className: 'mydsh-grid mydsh-grid-wide' },
        h(Card, {
          title: t('usage.topUsage'),
          actions: h(Segments, { value: dimension, options: dimensionOptions, onChange: setDimension, ariaLabel: t('usage.groupBy') }),
        },
          usage.data?.groups?.length > 0
            ? h(BarList, {
              rows: usage.data.groups.map((group) => ({
                key: group.key,
                label: prettyKey(group.key),
                value: group.total,
                tone: 'accent',
              })),
              formatValue: (value) => formatNumber(value),
            })
            : h(Empty, { title: t('usage.nothingRecorded') }),
        ),
          // `contextInsight` is the switch the settings page offers for this card; without the
          // guard the toggle existed but nothing read it.
          settings?.usage?.contextInsight === true ? h(ContextCard, null) : null,
      ),

      // The way into the cross-session page. It gets its own small card rather than a
      // link buried in one of the charts, because the page answers a different question
      // from everything above it.
      h(Card, {
        title: t('insight.title'),
        description: t('insight.entryHint'),
        actions: h('button', {
          type: 'button',
          className: 'mydsh-btn mydsh-btn-sm',
          onClick: () => insightOpen.set(true),
        }, t('insight.open')),
      }),

      h(BalanceCard, null),
      h(BudgetCard, null),
      h(SessionsCard, null),

      h(Card, { title: t('usage.display'), description: t('usage.displayHint') },
        h(FieldForm, { section: 'usage' }),
      ),
    ) : null,
  );
}

function Overview({ data }) {
  const t = usePanelT();
  const totals = data?.totals ?? {};
  // Every figure the aggregate carries gets a card. The panel previously showed four and
  // left cache, reasoning, and the derived averages unstated, which made a 16-billion-token
  // history read as one number with no breakdown.
  const calls = totals.calls ?? 0;
  const average = calls > 0 ? (totals.total ?? 0) / calls : 0;
  const averageCost = calls > 0 ? (totals.cost ?? 0) / calls : 0;
  const inputTotal = (totals.input ?? 0) + (totals.cacheRead ?? 0);
  const cacheHit = inputTotal > 0 ? (totals.cacheRead ?? 0) / inputTotal : 0;

  return h('div', { className: 'mydsh-grid mydsh-grid-wide' },
    h(Stat, {
      label: t('usage.totalTokens'),
      value: formatNumber(totals.total ?? 0),
      sub: t('usage.callsCount', { n: formatNumber(calls) }),
    }),
    h(Stat, {
      label: t('usage.cost'),
      value: formatMoney(totals.cost ?? 0),
      sub: t('usage.fromPriceTable'),
    }),
    h(Stat, {
      label: t('usage.input'),
      value: formatNumber(totals.input ?? 0),
      sub: t('usage.averagePerCall', { n: formatNumber(average) }),
    }),
    h(Stat, {
      label: t('usage.output'),
      value: formatNumber(totals.output ?? 0),
      sub: totals.reasoning > 0 ? t('usage.reasoningCount', { n: formatNumber(totals.reasoning) }) : undefined,
    }),
    h(Stat, {
      label: t('usage.cacheRead'),
      value: formatNumber(totals.cacheRead ?? 0),
      sub: t('usage.cacheHitRate', { p: (cacheHit * 100).toFixed(1) }),
    }),
    h(Stat, {
      label: t('usage.cacheWrite'),
      value: formatNumber(totals.cacheWrite ?? 0),
      sub: totals.cacheWrite > 0 ? t('usage.cacheWriteHint') : t('usage.cacheWriteNone'),
    }),
    h(Stat, {
      label: t('usage.calls'),
      value: formatNumber(calls),
      sub: t('usage.averageCostPerCall', { v: formatMoney(averageCost) }),
    }),
    h(Stat, {
      label: t('usage.bucketCount'),
      value: formatNumber(data?.buckets?.length ?? 0),
      sub: t('usage.bucketHint'),
    }),
  );
}

/** Context-window pressure for the most recent session with usage. */
function ContextCard() {
  const t = usePanelT();
  const sessions = useAsync(() => api.usageSessions(1), []);
  const sessionId = sessions.data?.rows?.[0]?.sessionId;
  const context = useAsync(
    ({ signal }) => api.usageContext(sessionId),
    [sessionId],
    { immediate: typeof sessionId === 'string' },
  );

  const data = context.data;
  return h(Card, { title: t('usage.context'), description: t('usage.contextHint') },
    data?.available === false ? h('p', { className: 'mydsh-hint' }, t('usage.contextNeedsSession'))
      : data === undefined ? h('p', { className: 'mydsh-hint' }, t('usage.noRecentSession'))
        : h('div', { className: 'mydsh-stack' },
          h('div', { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
            h('span', { style: { fontSize: 'var(--mydsh-font-lg)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' } },
              formatNumber(data.promptTokens ?? 0),
              // `tokens` is a unit, kept untranslated on purpose.
              h('span', { className: 'mydsh-stat-unit' },
                data.contextWindow === null ? ' tokens' : ` / ${formatNumber(data.contextWindow)}`,
              ),
            ),
            data.ratio === null ? null : h(Badge, {
              tone: data.ratio >= 0.9 ? 'danger' : data.ratio >= 0.7 ? 'warn' : 'success',
            }, `${Math.round(data.ratio * 100)}%`),
          ),
          data.ratio === null ? null : h(Meter, { ratio: data.ratio }),
          // The growth curve. One number says how full the window is; the curve says
          // whether it is filling up or has already been compacted back down, which is
          // what explains a sudden slowdown in a long session.
          (data.points ?? []).length < 2 ? null : h(React.Fragment, null,
            h(Sparkline, {
              values: (data.points ?? []).map((point) => point.prompt),
              tone: data.ratio === null ? 'accent' : data.ratio >= 0.9 ? 'danger' : data.ratio >= 0.7 ? 'warn' : 'accent',
              label: t('usage.contextTrend'),
            }),
            h('div', { className: 'mydsh-inline', style: { justifyContent: 'space-between', fontSize: 'var(--mydsh-font-xs)', color: 'var(--mydsh-text-muted)' } },
              h('span', null, t('usage.contextTrendTurns', { count: formatNumber((data.points ?? []).length) })),
              h('span', null, t('usage.contextPeak', { count: formatNumber(data.peakPrompt ?? 0) })),
            ),
          ),
          h('p', { className: 'mydsh-hint' },
            data.lastTime > 0
              ? t('usage.lastRequestAt', { when: formatRelative(data.lastTime, Date.now(), t) })
              : t('usage.noRequestYet'),
          ),
        ),
  );
}

/** DeepSeek account balance. Other providers are estimated from the price table. */
function BalanceCard() {
  const t = usePanelT();
  const balance = useAsync(() => api.usageBalance(), []);
  const data = balance.data;

  return h(Card, {
    title: t('usage.balance'),
    description: t('usage.balanceHint'),
    actions: h('button', {
      type: 'button',
      className: 'mydsh-btn mydsh-btn-sm mydsh-btn-ghost',
      onClick: () => balance.reload(),
    }, t('usage.refreshBalance')),
  },
    balance.loading && data === undefined ? h(Loading, null)
      : data?.available === false
        ? h('p', { className: 'mydsh-hint' },
          data.reason === 'no-account-service'
            ? t('usage.noAccountService')
            : t('usage.balanceUnavailableDetail', { detail: data.detail ?? data.reason }))
        : data?.balance === null || data?.balance === undefined
          ? h('p', { className: 'mydsh-hint' }, t('usage.signInForBalance'))
          : renderWallets(data.balance, t),
  );
}

/**
 * Render the account wallets.
 *
 * The service answers with an envelope: `{ status: 'ready', value: AccountWallet[],
 * bonusWallets: AccountWallet[] }` or `{ status: 'failed' }`. A failed envelope is
 * a normal state (signed out), not an error to shout about.
 */
function renderWallets(balance, t) {
  if (balance?.status !== 'ready') {
    return h('p', { className: 'mydsh-hint' }, t('usage.balanceReadFailed'));
  }
  const paid = Array.isArray(balance.value) ? balance.value : [];
  const bonus = Array.isArray(balance.bonusWallets) ? balance.bonusWallets : [];
  const wallets = [...paid.map((wallet) => ({ ...wallet, kind: 'balance' })),
    ...bonus.map((wallet) => ({ ...wallet, kind: 'bonus' }))];

  if (wallets.length === 0) {
    return h('p', { className: 'mydsh-hint' }, t('usage.noWallets'));
  }
  return h('div', { className: 'mydsh-grid' },
    wallets.map((wallet, index) =>
      h(Stat, {
        key: index,
        label: wallet.kind === 'bonus'
          ? t('usage.bonusLabel', { currency: wallet.currency })
          : wallet.currency,
        value: wallet.balance,
        sub: wallet.kind === 'bonus' ? t('usage.promotional') : undefined,
      }),
    ),
  );
}

/**
 * Per-dimension budgets.
 *
 * A budget is a number plus a scope. Exceeding it either notifies or pauses the
 * work, which is the only place this plugin can be destructive, so the action is
 * shown explicitly rather than implied.
 */
function BudgetCard() {
  const { settings, update } = useSettings();
  const t = usePanelT();
  const budget = settings?.budget ?? { enabled: false, action: 'notify', rules: [] };
  const rules = Array.isArray(budget.rules) ? budget.rules : [];

  const addRule = () => {
    update('budget', {
      rules: [...rules, { id: `rule_${Date.now()}`, scope: 'workspace', target: '', limit: 10, period: 'month', enabled: true }],
    });
  };

  const patchRule = (index, patch) => {
    const next = rules.map((rule, position) => (position === index ? { ...rule, ...patch } : rule));
    update('budget', { rules: next });
  };

  const removeRule = (index) => {
    update('budget', { rules: rules.filter((_, position) => position !== index) });
  };

  const actionOptions = React.useMemo(() => ([
    { value: 'notify', label: t('usage.notify') },
    { value: 'pause', label: t('usage.pause') },
  ]), [t]);

  return h(Card, {
    title: t('usage.budgets'),
    description: t('usage.budgetsHint'),
    actions: budget.enabled === true
      ? h('button', { type: 'button', className: 'mydsh-btn mydsh-btn-sm', onClick: addRule }, t('usage.addBudget'))
      : null,
  },
    budget.enabled !== true
      ? h('p', { className: 'mydsh-hint' }, t('usage.budgetsOff'))
      : h(React.Fragment, null,
        h('div', { className: 'mydsh-row' },
          h('div', { className: 'mydsh-row-text' },
            h('span', { className: 'mydsh-row-label' }, t('usage.whenExceeded')),
            h('span', { className: 'mydsh-row-hint' }, t('usage.whenExceededHint')),
          ),
          h(Segments, {
            value: budget.action ?? 'notify',
            options: actionOptions,
            onChange: (action) => update('budget', { action }),
          }),
        ),
        rules.length === 0
          ? h('p', { className: 'mydsh-hint' }, t('usage.noBudgets'))
          : h('div', { className: 'mydsh-table-wrap' },
            h('table', { className: 'mydsh-table' },
              h('thead', null,
                h('tr', null,
                  h('th', null, t('usage.scope')),
                  h('th', null, t('usage.target')),
                  h('th', { className: 'num' }, t('usage.limit')),
                  h('th', null, t('usage.period')),
                  h('th', null, ''),
                ),
              ),
              h('tbody', null,
                rules.map((rule, index) =>
                  h('tr', { key: rule.id ?? index },
                    h('td', null,
                      h('select', {
                        className: 'mydsh-select',
                        style: { width: 'auto' },
                        value: rule.scope ?? 'workspace',
                        onChange: (event) => patchRule(index, { scope: event.target.value }),
                      },
                      SCOPES.map((scope) =>
                        h('option', { key: scope.value, value: scope.value }, t(scope.labelKey)),
                      )),
                    ),
                    h('td', null,
                      h('input', {
                        className: 'mydsh-input',
                        style: { width: 120 },
                        value: rule.target ?? '',
                        placeholder: t('usage.anyTarget'),
                        onChange: (event) => patchRule(index, { target: event.target.value }),
                      }),
                    ),
                    h('td', { className: 'num' },
                      h('input', {
                        className: 'mydsh-input',
                        type: 'number',
                        style: { width: 90 },
                        value: rule.limit ?? 0,
                        min: 0,
                        step: 1,
                        onChange: (event) => patchRule(index, { limit: Number(event.target.value) }),
                      }),
                    ),
                    h('td', null,
                      h('select', {
                        className: 'mydsh-select',
                        style: { width: 'auto' },
                        value: rule.period ?? 'month',
                        onChange: (event) => patchRule(index, { period: event.target.value }),
                      },
                      PERIODS.map((period) =>
                        h('option', { key: period.value, value: period.value }, t(period.labelKey)),
                      )),
                    ),
                    h('td', null,
                      h('button', {
                        type: 'button',
                        className: 'mydsh-btn mydsh-btn-sm mydsh-btn-danger',
                        onClick: () => removeRule(index),
                      }, t('common.remove')),
                    ),
                  ),
                ),
              ),
            ),
          ),
        h('div', { className: 'mydsh-row' },
          h('div', { className: 'mydsh-row-text' },
            h('span', { className: 'mydsh-row-label' }, t('usage.enableBudgets')),
          ),
          h('button', {
            type: 'button',
            className: 'mydsh-switch',
            'data-on': budget.enabled === true ? 'true' : 'false',
            role: 'switch',
            'aria-checked': budget.enabled === true,
            'aria-label': t('usage.enableBudgets'),
            onClick: () => update('budget', { enabled: budget.enabled !== true }),
          }),
        ),
      ),
  );
}

/** Top sessions by token spend. */
function SessionsCard() {
  const t = usePanelT();
  const sessions = useAsync(() => api.usageSessions(20), []);
  const rows = sessions.data?.rows ?? [];

  return h(Card, { title: t('usage.sessions'), description: t('usage.sessionsHint') },
    sessions.loading && rows.length === 0 ? h(Loading, null)
      : rows.length === 0 ? h(Empty, { title: t('usage.noSessions') })
        : h('div', { className: 'mydsh-table-wrap' },
          h('table', { className: 'mydsh-table' },
            h('thead', null,
              h('tr', null,
                h('th', null, t('usage.sessionColumn')),
                h('th', { className: 'num' }, t('usage.tokens')),
                h('th', { className: 'num' }, t('usage.calls')),
                h('th', { className: 'num' }, t('usage.cost')),
                h('th', null, t('usage.last')),
              ),
            ),
            h('tbody', null,
              rows.map((row) =>
                h('tr', { key: row.sessionId },
                  h('td', { style: { maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    row.title ?? row.sessionId.slice(0, 12),
                  ),
                  h('td', { className: 'num' }, formatNumber(row.total)),
                  h('td', { className: 'num' }, formatNumber(row.calls)),
                  h('td', { className: 'num' }, formatMoney(row.cost)),
                  h('td', { className: 'mydsh-hint' }, formatRelative(row.lastTime, Date.now(), t)),
                ),
              ),
            ),
          ),
        ),
  );
}

function Loading() {
  const t = usePanelT();
  return h('div', { className: 'mydsh-hint' }, t('common.loading'));
}

function InlineError({ error, onRetry }) {
  const t = usePanelT();
  const describe = useFailureText();
  return h('div', { className: 'mydsh-error mydsh-inline', style: { justifyContent: 'space-between' } },
    h('span', null, describe(error)),
    h('button', { type: 'button', className: 'mydsh-btn mydsh-btn-sm', onClick: onRetry }, t('common.reload')),
  );
}

/** A raw aggregate key is an id; shorten it without losing identity. */
function prettyKey(key) {
  if (typeof key !== 'string') return String(key);
  if (key.length <= 28) return key;
  return `${key.slice(0, 26)}…`;
}
