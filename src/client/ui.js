/**
 * Shared UI primitives for 我的DSH.
 *
 * The plugin may not import the shell's private component packages, so it brings
 * its own controls. These are small and dependency-free on purpose: every one is
 * a plain hook over React state, so a bundle of them stays cheap to load.
 */
import React from 'react';

// Formatters live in format.js so they stay testable without React; re-exported
// here because most callers reach for them alongside the components.
import { cx, formatNumber, formatBucketLabel } from './format.js';

export {
  cx,
  formatNumber,
  formatMoney,
  formatBucketLabel,
  formatBytes,
  formatRelative,
  formatDuration,
} from './format.js';

const h = React.createElement;
const { useState, useRef, useEffect, useCallback, useMemo } = React;

/** A labelled switch. */
export function Switch({ checked, onChange, disabled, label }) {
  return h('button', {
    type: 'button',
    className: 'mydsh-switch',
    'data-on': checked === true ? 'true' : 'false',
    role: 'switch',
    'aria-checked': checked === true,
    'aria-label': label,
    disabled: disabled === true,
    onClick: () => onChange?.(checked !== true),
  });
}

/** A row with a label, an optional hint, and a control on the right. */
export function Row({ label, hint, children, disabled }) {
  return h('div', { className: cx('mydsh-row', disabled === true && 'disabled') },
    h('div', { className: 'mydsh-row-text' },
      h('span', { className: 'mydsh-row-label' }, label),
      hint !== undefined && hint !== '' ? h('span', { className: 'mydsh-row-hint' }, hint) : null,
    ),
    children,
  );
}

/** Segmented picker; `options` is `[{ value, label }]`. */
export function Segments({ value, options, onChange, ariaLabel }) {
  return h('div', { className: 'mydsh-segments', role: 'group', 'aria-label': ariaLabel },
    options.map((option) =>
      h('button', {
        key: option.value,
        type: 'button',
        className: 'mydsh-segment',
        'data-active': option.value === value ? 'true' : 'false',
        onClick: () => onChange?.(option.value),
      }, option.label),
    ),
  );
}

/** A card with a title, description, and optional header actions. */
export function Card({ title, description, actions, children, wide }) {
  return h('section', { className: 'mydsh-card' },
    (title !== undefined || actions !== undefined)
      ? h('div', { className: 'mydsh-card-head' },
        h('div', null,
          title !== undefined ? h('h3', null, title) : null,
          description !== undefined ? h('p', null, description) : null,
        ),
        actions ?? null,
      )
      : null,
    children,
  );
}

/** A single metric tile. */
export function Stat({ label, value, unit, sub }) {
  return h('div', { className: 'mydsh-stat' },
    h('span', { className: 'mydsh-stat-label' }, label),
    h('span', { className: 'mydsh-stat-value' },
      value,
      unit !== undefined ? h('span', { className: 'mydsh-stat-unit' }, unit) : null,
    ),
    sub !== undefined ? h('span', { className: 'mydsh-stat-sub' }, sub) : null,
  );
}

/** Inline state badge. */
export function Badge({ tone, children }) {
  return h('span', { className: 'mydsh-badge', 'data-tone': tone }, children);
}

/** A text input bound to a value, committing on blur or Enter. */
export function TextField({ value, onCommit, placeholder, disabled, multiline, rows }) {
  const [draft, setDraft] = useState(value ?? '');
  const lastValue = useRef(value);

  // A remote change (another window, a reset) must win over a stale draft.
  useEffect(() => {
    if (value !== lastValue.current) {
      lastValue.current = value;
      setDraft(value ?? '');
    }
  }, [value]);

  const commit = useCallback(() => {
    if (draft !== lastValue.current) {
      lastValue.current = draft;
      onCommit?.(draft);
    }
  }, [draft, onCommit]);

  const common = {
    className: multiline === true ? 'mydsh-textarea' : 'mydsh-input',
    value: draft,
    placeholder,
    disabled: disabled === true,
    onChange: (event) => setDraft(event.target.value),
    onBlur: commit,
    onKeyDown: (event) => {
      if (multiline !== true && event.key === 'Enter') {
        event.currentTarget.blur();
      }
      if (event.key === 'Escape') {
        setDraft(value ?? '');
      }
    },
  };

  return multiline === true
    ? h('textarea', { ...common, rows: rows ?? 4 })
    : h('input', { ...common, type: 'text' });
}

/** A numeric field with clamped commit. */
export function NumberField({ value, onCommit, min, max, step, suffix, disabled }) {
  const [draft, setDraft] = useState(String(value ?? ''));
  const lastValue = useRef(value);

  useEffect(() => {
    if (value !== lastValue.current) {
      lastValue.current = value;
      setDraft(String(value ?? ''));
    }
  }, [value]);

  const commit = useCallback(() => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(lastValue.current ?? ''));
      return;
    }
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, parsed));
    setDraft(String(clamped));
    if (clamped !== lastValue.current) {
      lastValue.current = clamped;
      onCommit?.(clamped);
    }
  }, [draft, min, max, onCommit]);

  return h('div', { className: 'mydsh-inline' },
    h('input', {
      className: 'mydsh-input',
      type: 'number',
      style: { width: 96 },
      value: draft,
      min,
      max,
      step,
      disabled: disabled === true,
      onChange: (event) => setDraft(event.target.value),
      onBlur: commit,
      onKeyDown: (event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      },
    }),
    suffix !== undefined ? h('span', { className: 'mydsh-hint' }, suffix) : null,
  );
}

/** A select bound to a value. */
export function SelectField({ value, options, onChange, disabled }) {
  return h('select', {
    className: 'mydsh-select',
    value: value ?? '',
    disabled: disabled === true,
    onChange: (event) => onChange?.(event.target.value),
  }, options.map((option) =>
    h('option', { key: option.value, value: option.value }, option.label),
  ));
}

/** An empty-state panel. */
export function Empty({ title, hint, action }) {
  return h('div', { className: 'mydsh-empty' },
    h(Icon, { name: 'inbox', size: 28 }),
    h('span', null, title),
    hint !== undefined ? h('span', { className: 'mydsh-hint' }, hint) : null,
    action ?? null,
  );
}

/** Progress meter with a tone driven by how full it is. */
export function Meter({ ratio, tone }) {
  const pct = Math.max(0, Math.min(1, ratio ?? 0)) * 100;
  const derived = tone ?? (pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'success');
  return h('div', { className: 'mydsh-meter', 'data-tone': derived },
    h('div', { className: 'mydsh-meter-fill', style: { width: `${pct.toFixed(1)}%` } }),
  );
}

/**
 * A stacked area chart drawn as inline SVG.
 *
 * No chart library: the shapes needed here (stacked areas plus a hover column)
 * are a few dozen lines of path arithmetic, and shipping a library would cost far
 * more bundle than it saves. The component is also theme-aware for free because
 * it paints with `currentColor` and CSS variables.
 */
export function AreaChart({ buckets, series, height = 140 }) {
  const [hover, setHover] = useState(undefined);
  const wrapRef = useRef(null);
  const width = 640;

  const totals = useMemo(() => {
    return buckets.map((bucket) => series.reduce((sum, entry) => sum + (bucket[entry.key] ?? 0), 0));
  }, [buckets, series]);

  const max = Math.max(1, ...totals);
  const padding = { top: 8, right: 4, bottom: 16, left: 4 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const stepX = buckets.length > 1 ? plotWidth / (buckets.length - 1) : plotWidth;

  // Cumulative stacking: each series sits on the previous one's top edge.
  const stacks = useMemo(() => {
    const running = new Array(buckets.length).fill(0);
    return series.map((entry) => {
      const lower = [...running];
      const upper = buckets.map((bucket, index) => {
        const next = running[index] + (bucket[entry.key] ?? 0);
        running[index] = next;
        return next;
      });
      return { entry, lower, upper };
    });
  }, [buckets, series]);

  const toPath = (values) => values.map((value, index) => {
    const x = padding.left + index * stepX;
    const y = padding.top + plotHeight - (value / max) * plotHeight;
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const areaPath = (lower, upper) => {
    const top = toPath(upper);
    const bottom = toPath(lower).reverse();
    return `${top.join(' ')} L${padding.left + (buckets.length - 1) * stepX},${padding.top + plotHeight} L${padding.left},${padding.top + plotHeight} Z`;
  };

  const onMove = (event) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    const scaled = ratio * width;
    const index = Math.round((scaled - padding.left) / stepX);
    if (index >= 0 && index < buckets.length) setHover(index);
    else setHover(undefined);
  };

  if (buckets.length === 0) return h(Empty, { title: 'No data in this range' });

  return h('div', {
    className: 'mydsh-chart',
    ref: wrapRef,
    onMouseMove: onMove,
    onMouseLeave: () => setHover(undefined),
  },
    h('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'usage trend' },
      h('defs', null,
        stacks.map((stack, index) =>
          h('linearGradient', { key: stack.entry.key, id: `mydsh-grad-${index}`, x1: 0, y1: 0, x2: 0, y2: 1 },
            h('stop', { offset: '0%', stopColor: stack.entry.color, stopOpacity: 0.34 }),
            h('stop', { offset: '100%', stopColor: stack.entry.color, stopOpacity: 0.04 }),
          ),
        ),
      ),
      // One horizontal guide at the maximum keeps the scale readable without
      // adding axes that would compete with the data.
      h('line', {
        x1: padding.left, y1: padding.top, x2: width - padding.right, y2: padding.top,
        stroke: 'var(--mydsh-border)', strokeWidth: 1, strokeDasharray: '3 4',
      }),
      stacks.map((stack, index) =>
        h('path', {
          key: stack.entry.key,
          d: areaPath(stack.lower, stack.upper),
          fill: `url(#mydsh-grad-${index})`,
          stroke: stack.entry.color,
          strokeWidth: 1.5,
          strokeLinejoin: 'round',
        }),
      ),
      hover !== undefined
        ? h('line', {
          x1: padding.left + hover * stepX,
          y1: padding.top,
          x2: padding.left + hover * stepX,
          y2: padding.top + plotHeight,
          stroke: 'var(--mydsh-border-strong)',
          strokeWidth: 1,
        })
        : null,
    ),
    hover !== undefined
      ? h('div', {
        className: 'mydsh-tooltip',
        style: {
          left: `${((padding.left + hover * stepX) / width) * 100}%`,
          top: 4,
        },
      },
        h('div', { className: 'mydsh-mono' }, formatBucketLabel(buckets[hover].start)),
        series.map((entry) =>
          h('div', { key: entry.key, className: 'mydsh-inline' },
            h('i', { style: { width: 8, height: 8, borderRadius: 2, background: entry.color, display: 'inline-block' } }),
            h('span', null, `${entry.label}: ${formatNumber(buckets[hover][entry.key] ?? 0)}`),
          ),
        ),
      )
      : null,
  );
}

/** A horizontal bar list, used for every grouped breakdown. */
export function BarList({ rows, formatValue, maxRows = 8 }) {
  const visible = rows.slice(0, maxRows);
  const max = Math.max(1, ...visible.map((row) => row.value));
  return h('div', { className: 'mydsh-stack' },
    visible.map((row) =>
      h('div', { key: row.key, className: 'mydsh-stack', style: { gap: 3 } },
        h('div', { className: 'mydsh-inline', style: { justifyContent: 'space-between' } },
          h('span', { style: { fontSize: 'var(--mydsh-font-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.label),
          h('span', { className: 'mydsh-mono' }, formatValue(row.value)),
        ),
        h('div', { className: 'mydsh-meter', 'data-tone': row.tone ?? 'accent' },
          h('div', { className: 'mydsh-meter-fill', style: { width: `${(row.value / max) * 100}%` } }),
        ),
      ),
    ),
  );
}

/**
 * Inline icon set.
 *
 * A single stroked path collection keeps the bundle small and inherits
 * `currentColor`, so every icon adapts to both themes without a variant.
 */
const ICONS = {
  inbox: 'M3 12h4l2 3h6l2-3h4M5 5h14l2 7v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z',
  chart: 'M4 19V5m0 14h16M8 15V9m4 6V7m4 8v-4',
  database: 'M12 3c4 0 7 1.1 7 2.5S16 8 12 8 5 6.9 5 5.5 8 3 12 3zM5 5.5v13C5 19.9 8 21 12 21s7-1.1 7-2.5v-13',
  refresh: 'M21 12a9 9 0 1 1-3-6.7M21 4v5h-5',
  shield: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z',
  prompt: 'M4 5h16M4 12h10M4 19h13',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 0c2.5 2.5 2.5 15.5 0 18m0-18c-2.5 2.5-2.5 15.5 0 18M3.5 9h17M3.5 15h17',
  toolbox: 'M4 8h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM9 8V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2',
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-3-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.3 8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.2V4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14l5-5-5-5m5 5H9',
  feedback: 'M21 12a8 8 0 0 1-8 8H7l-4 3v-6.5A8 8 0 0 1 13 4a8 8 0 0 1 8 8z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm7 8a7 7 0 0 0-14 0',
  check: 'M4 12.5l5 5L20 6.5',
  close: 'M6 6l12 12M18 6L6 18',
  chevron: 'M9 6l6 6-6 6',
  download: 'M12 4v11m0 0l-4-4m4 4l4-4M5 20h14',
  upload: 'M12 20V9m0 0l-4 4m4-4l4 4M5 4h14',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-13v5l3.5 2',
  alert: 'M12 9v4m0 4h.01M10.3 3.9L2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  spark: 'M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z',
  layers: 'M12 3l9 5-9 5-9-5zm9 9l-9 5-9-5m18 5l-9 5-9-5',
  palette: 'M12 3a9 9 0 1 0 0 18h1.5a2 2 0 0 0 0-4H13a1.5 1.5 0 0 1 0-3h4a4 4 0 0 0 0-8zM7.5 9.5h.01M10 6.5h.01M6 13h.01M9.5 16h.01',
};

export function Icon({ name, size = 16 }) {
  const path = ICONS[name] ?? ICONS.spark;
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    style: { flex: 'none' },
  }, h('path', { d: path }));
}

/** A small dismissible error banner. */
export function ErrorBanner({ message, onDismiss, dismissLabel = 'Dismiss' }) {
  if (message === undefined || message === null || message === '') return null;
  return h('div', { className: 'mydsh-error mydsh-inline', style: { justifyContent: 'space-between' } },
    h('span', null, String(message)),
    onDismiss !== undefined
      ? h('button', { type: 'button', className: 'mydsh-btn mydsh-btn-sm mydsh-btn-ghost', onClick: onDismiss }, dismissLabel)
      : null,
  );
}
