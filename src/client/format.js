/**
 * Formatting helpers.
 *
 * These live apart from `ui.js` for a reason that is only visible from a test:
 * they are pure functions with project-specific rules — notably the 万 threshold —
 * and a test should be able to check them without pulling in React. Keeping them
 * here also means the chart, the tables, and the panels all format numbers the
 * same way instead of each rounding slightly differently.
 */

/**
 * Format a count, compressing past 万 per the project's number rule.
 *
 * The rule compresses once; a value past 亿 would otherwise render as `1520785.1万`,
 * which is correct but unreadable. Those switch unit to 亿 so the magnitude stays legible.
 */
export function formatNumber(value, digits = 1) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) >= 100_000_000) return `${(n / 100_000_000).toFixed(digits)}亿`;
  if (Math.abs(n) >= 10_000) return `${(n / 10_000).toFixed(digits)}万`;
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US');
  return String(Math.round(n * 10) / 10);
}

/** Format an amount of money in the configured currency. */
export function formatMoney(value, currency = 'CNY') {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '—';
  const symbol = currency === 'USD' ? '$' : '¥';
  if (n === 0) return `${symbol}0`;
  if (n < 0.01) return `${symbol}${n.toFixed(4)}`;
  if (n < 1) return `${symbol}${n.toFixed(3)}`;
  return `${symbol}${n.toFixed(2)}`;
}

/** Format a bucket boundary for a chart tooltip. */
export function formatBucketLabel(time) {
  const date = new Date(time);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  return hours === 0 ? `${month}/${day}` : `${month}/${day} ${String(hours).padStart(2, '0')}:00`;
}

/** Format a byte count using binary units. */
export function formatBytes(bytes) {
  const n = Number(bytes ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/**
 * Format a relative time such as "3h ago".
 *
 * `translate` is the panel's `t`. Passing it in keeps this module React-free (the tests
 * import it directly) while still letting the wording follow the active language: the
 * unit suffixes and the "just now" case are user-visible text, so hard-coding them here
 * would put English into a Chinese UI.
 *
 * Every caller passes `t`; when it is omitted the output is the bare, unit-only form
 * (`3h`), which stays language-neutral.
 */
export function formatRelative(time, now = Date.now(), translate = undefined) {
  if (typeof time !== 'number' || time <= 0) return '—';
  const say = typeof translate === 'function'
    ? (key, count) => translate(key, { count })
    : (key, count) => ({ 'time.justNow': '', 'time.minutes': `${count}m`, 'time.hours': `${count}h`, 'time.days': `${count}d` }[key] ?? '');
  const delta = Math.max(0, now - time);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return say('time.justNow');
  if (delta < hour) return say('time.minutes', Math.floor(delta / minute));
  if (delta < day) return say('time.hours', Math.floor(delta / hour));
  if (delta < 30 * day) return say('time.days', Math.floor(delta / day));
  return new Date(time).toLocaleDateString();
}

/** Format a duration in milliseconds as a short human string. */
export function formatDuration(ms) {
  const n = Number(ms ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.floor(n / 60_000)}m ${Math.round((n % 60_000) / 1000)}s`;
}

/** Join class names, dropping falsy entries. */
export function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}
