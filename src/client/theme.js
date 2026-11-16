/**
 * Design tokens for 我的DSH.
 *
 * The DSH shell exposes a small set of `--dsw-alias-*` custom properties and
 * nothing more, so this plugin must supply the rest of a design system itself.
 * Every value below is derived from those aliases where an equivalent exists,
 * which is what makes light and dark mode work without a second theme: the shell
 * already flipped the base colors, and these tokens inherit that flip.
 *
 * Colors are expressed as `color-mix` against tokens rather than literals so a
 * host theme change propagates instead of drifting.
 */

/** Root class every rule is scoped under, so the plugin never styles the shell. */
export const ROOT = 'mydsh';

/** Names of the semantic tokens this plugin defines. */
export const TOKENS = Object.freeze([
  'surface',
  'surface-raised',
  'surface-sunken',
  'border',
  'border-strong',
  'text',
  'text-muted',
  'text-faint',
  'accent',
  'accent-soft',
  'accent-text',
  'success',
  'success-soft',
  'warn',
  'warn-soft',
  'danger',
  'danger-soft',
  'idle',
  'shadow',
  'radius-sm',
  'radius-md',
  'radius-lg',
  'space-1',
  'space-2',
  'space-3',
  'space-4',
  'space-5',
  'space-6',
  'font-xs',
  'font-sm',
  'font-md',
  'font-lg',
  'font-xl',
  'motion',
]);

/**
 * The stylesheet.
 *
 * Two rules govern everything here:
 *  - No bare hex colors: a shell theme swap must not leave a stranded palette.
 *  - No `!important` except where the plugin deliberately overrides a shell
 *    element it was invited to replace, which is noted at each site.
 */
export const STYLES = `
/**
 * Tokens live on :root, not on .mydsh, because the plugin also renders into slots
 * outside its own subtree (the sidebar brand row, the conversation header). Those
 * occupants cannot inherit from .mydsh, and every name is prefixed so the wider
 * scope cannot collide with the shell or another plugin.
 *
 * The values are aliases of the shell's own tokens, so a light/dark switch flips
 * this entire palette without a second theme definition.
 */
:root {
  /* Surfaces derive from the shell's layered backgrounds. */
  --mydsh-surface: var(--dsw-alias-bg-layer-1, #fff);
  --mydsh-surface-raised: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2, #fff));
  --mydsh-surface-sunken: var(--dsw-alias-bg-base, #f5f6f8);
  --mydsh-border: var(--dsw-alias-border-l1, rgba(0, 0, 0, .08));
  --mydsh-border-strong: var(--dsw-alias-border-l2, rgba(0, 0, 0, .16));

  --mydsh-text: var(--dsw-alias-label-primary, #1a1a1e);
  --mydsh-text-muted: var(--dsw-alias-label-secondary, #5c5f66);

  --mydsh-accent: var(--dsw-alias-brand-primary, #4d6bfe);
  --mydsh-success: var(--dsw-alias-state-success, #16a34a);
  --mydsh-warn: var(--dsw-alias-state-warn, #d97706);
  --mydsh-danger: var(--dsw-alias-state-error, #dc2626);
  --mydsh-idle: var(--dsw-alias-state-idle-primary, #94a3b8);

  --mydsh-radius-sm: 6px;
  --mydsh-radius-md: 10px;
  --mydsh-radius-lg: 16px;
  --mydsh-space-1: 4px;
  --mydsh-space-2: 8px;
  --mydsh-space-3: 12px;
  --mydsh-space-4: 16px;
  --mydsh-space-5: 24px;
  --mydsh-space-6: 32px;
  --mydsh-font-xs: 11px;
  --mydsh-font-sm: 12px;
  --mydsh-font-md: 13px;
  --mydsh-font-lg: 15px;
  --mydsh-font-xl: 20px;
  --mydsh-motion: 140ms cubic-bezier(.4, 0, .2, 1);
}

/* Derived tints. color-mix keeps them tied to the live accent and state colors,
   so a theme swap recolors the whole plugin rather than half of it. */
:root {
  --mydsh-text-faint: color-mix(in srgb, var(--mydsh-text-muted) 62%, transparent);
  /* Row hover. Mixed from the label color rather than a fixed grey so it stays
     visible in both themes without a second definition. */
  --mydsh-hover: color-mix(in srgb, var(--mydsh-text) 7%, transparent);
  --mydsh-accent-soft: color-mix(in srgb, var(--mydsh-accent) 12%, transparent);
  --mydsh-accent-text: color-mix(in srgb, var(--mydsh-accent) 88%, var(--mydsh-text));
  --mydsh-success-soft: color-mix(in srgb, var(--mydsh-success) 12%, transparent);
  --mydsh-warn-soft: color-mix(in srgb, var(--mydsh-warn) 14%, transparent);
  --mydsh-danger-soft: color-mix(in srgb, var(--mydsh-danger) 12%, transparent);
  --mydsh-shadow: 0 1px 2px rgba(0, 0, 0, .05), 0 8px 24px -12px rgba(0, 0, 0, .18);
}

.${ROOT} {
  color: var(--mydsh-text);
  font-size: var(--mydsh-font-md);
  line-height: 1.55;
}

/* ── layout ──────────────────────────────────────────────────────────────── */

.${ROOT}-page {
  display: flex;
  flex-direction: column;
  gap: var(--mydsh-space-4);
  padding: var(--mydsh-space-4) 0 var(--mydsh-space-6);
  min-width: 0;
}

.${ROOT}-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--mydsh-space-4);
  flex-wrap: wrap;
}

.${ROOT}-title {
  display: flex;
  flex-direction: column;
  gap: var(--mydsh-space-1);
  min-width: 0;
}

.${ROOT}-title h2 {
  margin: 0;
  font-size: var(--mydsh-font-lg);
  font-weight: 600;
  letter-spacing: -0.01em;
}

.${ROOT}-title p {
  margin: 0;
  color: var(--mydsh-text-muted);
  font-size: var(--mydsh-font-sm);
  max-width: 62ch;
}

/* ── cards ───────────────────────────────────────────────────────────────── */

.${ROOT}-card {
  background: var(--mydsh-surface);
  border: 1px solid var(--mydsh-border);
  border-radius: var(--mydsh-radius-md);
  padding: var(--mydsh-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--mydsh-space-3);
  min-width: 0;
}

.${ROOT}-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--mydsh-space-3);
  flex-wrap: wrap;
}

.${ROOT}-card-head h3 {
  margin: 0;
  font-size: var(--mydsh-font-md);
  font-weight: 600;
}

.${ROOT}-card-head p {
  margin: 2px 0 0;
  font-size: var(--mydsh-font-xs);
  color: var(--mydsh-text-muted);
}

.${ROOT}-grid {
  display: grid;
  gap: var(--mydsh-space-3);
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
}

.${ROOT}-grid-wide {
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}

/* ── stat tiles ──────────────────────────────────────────────────────────── */

.${ROOT}-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--mydsh-space-3);
  border-radius: var(--mydsh-radius-sm);
  background: var(--mydsh-surface-sunken);
  border: 1px solid transparent;
  transition: border-color var(--mydsh-motion), background var(--mydsh-motion);
  min-width: 0;
}

.${ROOT}-stat:hover {
  border-color: var(--mydsh-border-strong);
}

.${ROOT}-stat-label {
  font-size: var(--mydsh-font-xs);
  color: var(--mydsh-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.${ROOT}-stat-value {
  font-size: var(--mydsh-font-xl);
  font-weight: 600;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

.${ROOT}-stat-unit {
  font-size: var(--mydsh-font-xs);
  font-weight: 500;
  color: var(--mydsh-text-muted);
  margin-left: 3px;
}

.${ROOT}-stat-sub {
  font-size: var(--mydsh-font-xs);
  color: var(--mydsh-text-faint);
  font-variant-numeric: tabular-nums;
}

/* ── controls ────────────────────────────────────────────────────────────── */

.${ROOT}-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--mydsh-space-3);
  padding: var(--mydsh-space-3) 0;
  border-bottom: 1px solid var(--mydsh-border);
  min-width: 0;
}

.${ROOT}-row:last-child {
  border-bottom: none;
}

.${ROOT}-row-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}

.${ROOT}-row-label {
  font-size: var(--mydsh-font-md);
  color: var(--mydsh-text);
}

.${ROOT}-row-hint {
  font-size: var(--mydsh-font-xs);
  color: var(--mydsh-text-muted);
}

.${ROOT}-row.disabled {
  opacity: .5;
  pointer-events: none;
}

/* Switch. Built from tokens so it inherits the shell's accent in both themes. */
.${ROOT}-switch {
  position: relative;
  flex: none;
  width: 38px;
  height: 22px;
  border-radius: 999px;
  border: 1px solid var(--mydsh-border-strong);
  background: var(--mydsh-surface-sunken);
  cursor: pointer;
  transition: background var(--mydsh-motion), border-color var(--mydsh-motion);
  padding: 0;
  appearance: none;
}

.${ROOT}-switch[data-on='true'] {
  background: var(--mydsh-accent);
  border-color: var(--mydsh-accent);
}

.${ROOT}-switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .25);
  transition: transform var(--mydsh-motion);
}

.${ROOT}-switch[data-on='true']::after {
  transform: translateX(16px);
}

.${ROOT}-switch:focus-visible {
  outline: 2px solid var(--mydsh-accent);
  outline-offset: 2px;
}

.${ROOT}-switch:disabled {
  opacity: .45;
  cursor: not-allowed;
}

/* Segmented control, used for every range and dimension picker. */
.${ROOT}-segments {
  display: inline-flex;
  padding: 2px;
  gap: 2px;
  background: var(--mydsh-surface-sunken);
  border: 1px solid var(--mydsh-border);
  border-radius: var(--mydsh-radius-sm);
  flex-wrap: wrap;
}

.${ROOT}-segment {
  border: none;
  background: transparent;
  color: var(--mydsh-text-muted);
  font-size: var(--mydsh-font-xs);
  padding: 5px 10px;
  border-radius: 4px;
  cursor: pointer;
  transition: background var(--mydsh-motion), color var(--mydsh-motion);
  font-family: inherit;
  white-space: nowrap;
}

.${ROOT}-segment:hover {
  color: var(--mydsh-text);
}

.${ROOT}-segment[data-active='true'] {
  background: var(--mydsh-surface);
  color: var(--mydsh-text);
  box-shadow: 0 1px 2px rgba(0, 0, 0, .08);
  font-weight: 600;
}

.${ROOT}-segment:focus-visible {
  outline: 2px solid var(--mydsh-accent);
  outline-offset: -1px;
}

/* Text inputs. */
.${ROOT}-input,
.${ROOT}-textarea,
.${ROOT}-select {
  width: 100%;
  min-width: 0;
  font-family: inherit;
  font-size: var(--mydsh-font-md);
  color: var(--mydsh-text);
  background: var(--mydsh-surface-sunken);
  border: 1px solid var(--mydsh-border);
  border-radius: var(--mydsh-radius-sm);
  padding: 7px 10px;
  transition: border-color var(--mydsh-motion), background var(--mydsh-motion);
}

.${ROOT}-textarea {
  resize: vertical;
  min-height: 72px;
  line-height: 1.5;
}

.${ROOT}-input:focus,
.${ROOT}-textarea:focus,
.${ROOT}-select:focus {
  outline: none;
  border-color: var(--mydsh-accent);
  background: var(--mydsh-surface);
}

.${ROOT}-input::placeholder,
.${ROOT}-textarea::placeholder {
  color: var(--mydsh-text-faint);
}

.${ROOT}-select {
  cursor: pointer;
  appearance: none;
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: calc(100% - 15px) 50%, calc(100% - 10px) 50%;
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
  padding-right: 28px;
}

/* Buttons. */
.${ROOT}-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-family: inherit;
  font-size: var(--mydsh-font-sm);
  font-weight: 500;
  padding: 6px 12px;
  border-radius: var(--mydsh-radius-sm);
  border: 1px solid var(--mydsh-border-strong);
  background: var(--mydsh-surface);
  color: var(--mydsh-text);
  cursor: pointer;
  transition: background var(--mydsh-motion), border-color var(--mydsh-motion), opacity var(--mydsh-motion);
  white-space: nowrap;
}

.${ROOT}-btn:hover:not(:disabled) {
  background: var(--mydsh-surface-sunken);
}

.${ROOT}-btn:focus-visible {
  outline: 2px solid var(--mydsh-accent);
  outline-offset: 1px;
}

.${ROOT}-btn:disabled {
  opacity: .5;
  cursor: not-allowed;
}

.${ROOT}-btn-primary {
  background: var(--mydsh-accent);
  border-color: var(--mydsh-accent);
  color: #fff;
}

.${ROOT}-btn-primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--mydsh-accent) 88%, #000);
}

.${ROOT}-btn-danger {
  color: var(--mydsh-danger);
  border-color: color-mix(in srgb, var(--mydsh-danger) 40%, transparent);
}

.${ROOT}-btn-danger:hover:not(:disabled) {
  background: var(--mydsh-danger-soft);
}

.${ROOT}-btn-ghost {
  border-color: transparent;
  background: transparent;
  color: var(--mydsh-text-muted);
}

.${ROOT}-btn-ghost:hover:not(:disabled) {
  background: var(--mydsh-surface-sunken);
  color: var(--mydsh-text);
}

.${ROOT}-btn-sm {
  font-size: var(--mydsh-font-xs);
  padding: 4px 8px;
}

/* ── badges ──────────────────────────────────────────────────────────────── */

.${ROOT}-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--mydsh-font-xs);
  font-weight: 500;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--mydsh-surface-sunken);
  color: var(--mydsh-text-muted);
  white-space: nowrap;
}

.${ROOT}-badge[data-tone='accent'] {
  background: var(--mydsh-accent-soft);
  color: var(--mydsh-accent-text);
}

.${ROOT}-badge[data-tone='success'] {
  background: var(--mydsh-success-soft);
  color: var(--mydsh-success);
}

.${ROOT}-badge[data-tone='warn'] {
  background: var(--mydsh-warn-soft);
  color: var(--mydsh-warn);
}

.${ROOT}-badge[data-tone='danger'] {
  background: var(--mydsh-danger-soft);
  color: var(--mydsh-danger);
}

.${ROOT}-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
}

/* ── chart ───────────────────────────────────────────────────────────────── */

.${ROOT}-chart {
  position: relative;
  width: 100%;
  min-height: 120px;
}

.${ROOT}-chart svg {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}

.${ROOT}-chart-legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mydsh-space-3);
  font-size: var(--mydsh-font-xs);
  color: var(--mydsh-text-muted);
}

.${ROOT}-chart-legend span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.${ROOT}-chart-legend i {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  display: inline-block;
}

/* ── activity heatmap ─────────────────────────────────────────────────────
   Five steps from "nothing" to "busiest", all mixed from the accent colour so
   the ramp follows the theme instead of hard-coding a green. Level 0 is a well,
   not the palest tint, so an idle day never looks like a quiet one. */
.${ROOT}-heatmap-wrap {
  display: flex;
  flex-direction: column;
  gap: var(--mydsh-space-3);
}

.${ROOT}-heatmap {
  display: flex;
  gap: 3px;
  overflow-x: auto;
  padding-bottom: 2px;
}

.${ROOT}-heatmap-week {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.${ROOT}-heatmap-cell {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  background: var(--mydsh-surface-sunken);
  box-shadow: inset 0 0 0 1px var(--mydsh-border);
  transition: transform 90ms ease, box-shadow 90ms ease;
}

.${ROOT}-heatmap-cell[data-level='1'] {
  background: color-mix(in srgb, var(--mydsh-accent) 18%, var(--mydsh-surface-sunken));
}

.${ROOT}-heatmap-cell[data-level='2'] {
  background: color-mix(in srgb, var(--mydsh-accent) 36%, var(--mydsh-surface-sunken));
}

.${ROOT}-heatmap-cell[data-level='3'] {
  background: color-mix(in srgb, var(--mydsh-accent) 58%, var(--mydsh-surface-sunken));
}

.${ROOT}-heatmap-cell[data-level='4'] {
  background: color-mix(in srgb, var(--mydsh-accent) 82%, var(--mydsh-surface-sunken));
}

.${ROOT}-heatmap-cell[data-level='empty'] {
  background: transparent;
  box-shadow: none;
}

.${ROOT}-heatmap-cell[data-hover='true'] {
  transform: scale(1.25);
  box-shadow: 0 0 0 1px var(--mydsh-accent);
}

.${ROOT}-heatmap-readout {
  display: flex;
  justify-content: space-between;
  gap: var(--mydsh-space-3);
  font-size: var(--mydsh-font-xs);
  color: var(--mydsh-text-muted);
  min-height: 1.4em;
}

/* ── sparkline ────────────────────────────────────────────────────────────
   A line plus a faint fill. The stroke uses the accent colour by default and
   switches to the warning and danger tones as the ratio climbs, so the same
   component reads as "fine" or "nearly full" without a separate variant. */
.${ROOT}-spark svg {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}

.${ROOT}-spark-line {
  stroke: var(--mydsh-accent);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

.${ROOT}-spark-area {
  fill: color-mix(in srgb, var(--mydsh-accent) 16%, transparent);
}

.${ROOT}-spark[data-tone='warn'] .${ROOT}-spark-line {
  stroke: var(--mydsh-warn);
}

.${ROOT}-spark[data-tone='warn'] .${ROOT}-spark-area {
  fill: color-mix(in srgb, var(--mydsh-warn) 16%, transparent);
}

.${ROOT}-spark[data-tone='danger'] .${ROOT}-spark-line {
  stroke: var(--mydsh-danger);
}

.${ROOT}-spark[data-tone='danger'] .${ROOT}-spark-area {
  fill: color-mix(in srgb, var(--mydsh-danger) 16%, transparent);
}

.${ROOT}-tooltip {
  position: absolute;
  pointer-events: none;
  background: var(--mydsh-surface-raised);
  border: 1px solid var(--mydsh-border-strong);
  border-radius: var(--mydsh-radius-sm);
  box-shadow: var(--mydsh-shadow);
  padding: 6px 9px;
  font-size: var(--mydsh-font-xs);
  line-height: 1.45;
  z-index: 30;
  white-space: nowrap;
  transform: translate(-50%, -100%);
}

/* ── table ───────────────────────────────────────────────────────────────── */

.${ROOT}-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--mydsh-font-sm);
}

.${ROOT}-table th {
  text-align: left;
  font-weight: 500;
  color: var(--mydsh-text-muted);
  font-size: var(--mydsh-font-xs);
  padding: 6px 8px;
  border-bottom: 1px solid var(--mydsh-border);
  white-space: nowrap;
  position: sticky;
  top: 0;
  background: var(--mydsh-surface);
}

.${ROOT}-table td {
  padding: 7px 8px;
  border-bottom: 1px solid var(--mydsh-border);
  vertical-align: middle;
}

.${ROOT}-table tr:last-child td {
  border-bottom: none;
}

.${ROOT}-table tbody tr:hover {
  background: var(--mydsh-surface-sunken);
}

.${ROOT}-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.${ROOT}-table-wrap {
  max-height: 340px;
  overflow: auto;
  border-radius: var(--mydsh-radius-sm);
}

/* ── misc ────────────────────────────────────────────────────────────────── */

.${ROOT}-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--mydsh-space-2);
  padding: var(--mydsh-space-5) var(--mydsh-space-3);
  color: var(--mydsh-text-muted);
  font-size: var(--mydsh-font-sm);
  text-align: center;
}

.${ROOT}-empty svg {
  opacity: .5;
}

.${ROOT}-hint {
  font-size: var(--mydsh-font-xs);
  color: var(--mydsh-text-muted);
  line-height: 1.5;
}

.${ROOT}-error {
  font-size: var(--mydsh-font-sm);
  color: var(--mydsh-danger);
  background: var(--mydsh-danger-soft);
  border-radius: var(--mydsh-radius-sm);
  padding: var(--mydsh-space-2) var(--mydsh-space-3);
}

/* A warning strip. The text mixes the warning colour toward the *foreground* label
   token, not toward a hardcoded black: in dark mode that keeps it bright against the
   tinted background, where mixing toward the body colour would sink it into the fill.
   A left border carries the same signal without relying on colour alone. */
.${ROOT}-notice {
  font-size: var(--mydsh-font-sm);
  background: var(--mydsh-warn-soft);
  color: color-mix(in srgb, var(--mydsh-warn) 62%, var(--mydsh-text));
  border-left: 2px solid color-mix(in srgb, var(--mydsh-warn) 70%, transparent);
  border-radius: var(--mydsh-radius-sm);
  padding: var(--mydsh-space-2) var(--mydsh-space-3);
}

.${ROOT}-divider {
  height: 1px;
  background: var(--mydsh-border);
  margin: var(--mydsh-space-1) 0;
}

.${ROOT}-spacer {
  flex: 1;
}

.${ROOT}-stack {
  display: flex;
  flex-direction: column;
  gap: var(--mydsh-space-2);
  min-width: 0;
}

/* Breathing room between top-level cards. Kept separate from the plain stack so
   a field list inside a card stays compact while the cards themselves read as
   distinct blocks. */
.${ROOT}-stack-lg {
  gap: var(--mydsh-space-5);
}

/* ── tab bar ─────────────────────────────────────────────────────────────────
   The tab bar is a horizontal strip that scrolls rather than wraps: eight tabs
   would otherwise push the panel below the fold on a narrow window. The radius
   and border live on the strip so the tabs read as one control. */

.${ROOT}-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--mydsh-border);
  border-radius: var(--mydsh-radius-md);
  background: var(--mydsh-surface-sunken);
  overflow-x: auto;
  scrollbar-width: none;
  min-width: 0;
}

.${ROOT}-tabs::-webkit-scrollbar {
  display: none;
}

.${ROOT}-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 6px 11px;
  border: none;
  border-radius: calc(var(--mydsh-radius-md) - 3px);
  background: transparent;
  color: var(--mydsh-text-muted);
  font: inherit;
  font-size: var(--mydsh-font-sm);
  line-height: 1.35;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--mydsh-motion), color var(--mydsh-motion);
}

.${ROOT}-tab:hover {
  background: var(--mydsh-hover);
  color: var(--mydsh-text);
}

.${ROOT}-tab[data-active='true'] {
  background: var(--mydsh-surface);
  color: var(--mydsh-text);
  font-weight: 600;
  box-shadow: 0 1px 2px rgb(0 0 0 / .07);
}

.${ROOT}-tab:focus-visible {
  outline: 2px solid var(--mydsh-accent);
  outline-offset: -2px;
}

/* ── module header ───────────────────────────────────────────────────────────
   The master switch for a panel sits above that panel's own controls, so the
   enabled state reads before the settings it governs. */

.${ROOT}-module-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--mydsh-space-4);
  flex-wrap: wrap;
  padding: var(--mydsh-space-4);
  border: 1px solid var(--mydsh-border);
  border-radius: var(--mydsh-radius-md);
  background: var(--mydsh-surface);
}

.${ROOT}-module-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.${ROOT}-module-text h3 {
  margin: 0;
  font-size: var(--mydsh-font-md);
  font-weight: 600;
}

.${ROOT}-module-text p {
  margin: 0;
  color: var(--mydsh-text-muted);
  font-size: var(--mydsh-font-xs);
  max-width: 62ch;
}

/* The control column of a row must not shrink, or a switch gets clipped by a
   long label next to it. */
/* A row whose card heading already carries the label and explanation: the control
   sits alone, right-aligned, with no second copy of the wording above it. */
.${ROOT}-row-plain {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  min-height: 34px;
}

.${ROOT}-row-control {
  display: flex;
  align-items: center;
  gap: var(--mydsh-space-2);
  flex: none;
  min-width: 0;
}

/* ── effect summary ──────────────────────────────────────────────────────────
   A two-column list rather than inline badges: the label and its value belong on
   one line, and stacking them keeps a narrow panel readable. */

.${ROOT}-effect-list {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--mydsh-space-2) var(--mydsh-space-4);
  align-items: center;
}

.${ROOT}-effect {
  display: contents;
}

.${ROOT}-effect-label {
  font-size: var(--mydsh-font-sm);
  color: var(--mydsh-text-muted);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── sidebar entry ───────────────────────────────────────────────────────────
   Sits beside the shell's Settings trigger at the foot of the sidebar. It borrows
   the trigger's own metrics so the two rows line up rather than looking like two
   different kinds of control. */

.${ROOT}-entry {
  display: flex;
  align-items: center;
  gap: var(--mydsh-space-2);
  width: 100%;
  min-width: 0;
  padding: 6px 8px;
  border: none;
  border-radius: var(--mydsh-radius-sm);
  background: transparent;
  color: var(--mydsh-text-muted);
  font: inherit;
  font-size: var(--mydsh-font-sm);
  text-align: left;
  cursor: pointer;
  transition: background var(--mydsh-motion), color var(--mydsh-motion);
}

.${ROOT}-entry:hover {
  background: var(--mydsh-hover);
  color: var(--mydsh-text);
}

.${ROOT}-entry:focus-visible {
  outline: 2px solid var(--mydsh-accent);
  outline-offset: -2px;
}

.${ROOT}-entry-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Today's token count beside the entry label. Muted and tabular so it reads as a
   footnote to the label rather than competing with it, and never wraps. */
.${ROOT}-entry-count {
  margin-left: auto;
  font-size: var(--mydsh-font-xs);
  font-variant-numeric: tabular-nums;
  color: var(--mydsh-text-muted);
  white-space: nowrap;
}

/* Rail form: the sidebar is 56px wide and hides labels, so the button becomes a
   centred square holding only the mark. The data-wide attribute comes from the slot
   owner, which is the authority on the column state. */
.${ROOT}-entry[data-wide='false'] {
  justify-content: center;
  padding: 6px;
}

/* Titlebar form. The header row is tight, so this is an icon-only square that matches the
   icon buttons beside it rather than the sidebar's full-width row. */
.${ROOT}-entry-compact {
  justify-content: center;
  padding: 5px;
  gap: 0;
  background: transparent;
  border-color: transparent;
}

.${ROOT}-entry-compact:hover {
  background: var(--mydsh-accent-soft);
  border-color: var(--mydsh-border);
}

.${ROOT}-inline {
  display: flex;
  align-items: center;
  gap: var(--mydsh-space-2);
  flex-wrap: wrap;
  min-width: 0;
}

.${ROOT}-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: var(--mydsh-font-xs);
}

/* Meter used by budget and context fill. */
.${ROOT}-meter {
  height: 6px;
  border-radius: 999px;
  background: var(--mydsh-surface-sunken);
  overflow: hidden;
  position: relative;
}

.${ROOT}-meter-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--mydsh-accent);
  transition: width var(--mydsh-motion), background var(--mydsh-motion);
}

.${ROOT}-meter[data-tone='warn'] .${ROOT}-meter-fill { background: var(--mydsh-warn); }
.${ROOT}-meter[data-tone='danger'] .${ROOT}-meter-fill { background: var(--mydsh-danger); }
.${ROOT}-meter[data-tone='success'] .${ROOT}-meter-fill { background: var(--mydsh-success); }

/* Sidebar brand replacement: inherits placement, owns appearance. */
.${ROOT}-brandmark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--mydsh-radius-sm);
  background: linear-gradient(135deg, var(--mydsh-accent), color-mix(in srgb, var(--mydsh-accent) 55%, #7c3aed));
  color: #fff;
  flex: none;
}

.${ROOT}-brandmark svg {
  width: 15px;
  height: 15px;
}

.${ROOT}-brandname {
  font-size: var(--mydsh-font-sm);
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--mydsh-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Titlebar account chip: avatar only until opened. */
.${ROOT}-account-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px 3px 3px;
  border-radius: 999px;
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  color: var(--mydsh-text);
  font-family: inherit;
  font-size: var(--mydsh-font-sm);
  transition: background var(--mydsh-motion), border-color var(--mydsh-motion);
  max-width: 180px;
}

.${ROOT}-account-chip:hover {
  background: var(--mydsh-surface-sunken);
  border-color: var(--mydsh-border);
}

.${ROOT}-avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--mydsh-accent-soft);
  color: var(--mydsh-accent-text);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--mydsh-font-xs);
  font-weight: 600;
  flex: none;
  overflow: hidden;
}

.${ROOT}-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.${ROOT}-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  min-width: 190px;
  background: var(--mydsh-surface-raised);
  border: 1px solid var(--mydsh-border-strong);
  border-radius: var(--mydsh-radius-md);
  box-shadow: var(--mydsh-shadow);
  padding: var(--mydsh-space-1);
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.${ROOT}-menu-item {
  display: flex;
  align-items: center;
  gap: var(--mydsh-space-2);
  padding: 7px 9px;
  border: none;
  background: transparent;
  border-radius: var(--mydsh-radius-sm);
  font-family: inherit;
  font-size: var(--mydsh-font-sm);
  color: var(--mydsh-text);
  cursor: pointer;
  text-align: left;
  width: 100%;
}

.${ROOT}-menu-item:hover {
  background: var(--mydsh-surface-sunken);
}

.${ROOT}-menu-item svg {
  flex: none;
  opacity: .7;
}

.${ROOT}-menu-sep {
  height: 1px;
  background: var(--mydsh-border);
  margin: 3px 4px;
}

/* ── cross-session insight page ───────────────────────────────────────────
   Rendered in shell.overlay, so it floats above the columns. The backdrop dims
   the frame and the page scrolls independently, which keeps a long ranking from
   stretching the frame. */
.${ROOT}-insight-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 24px;
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 62%, transparent);
  backdrop-filter: blur(2px);
}

.${ROOT}-insight-page {
  width: min(880px, 100%);
  max-height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--mydsh-space-4);
  padding: 22px 24px 26px;
  border-radius: 14px;
  border: 1px solid var(--mydsh-border);
  background: var(--mydsh-surface-raised);
  box-shadow: 0 18px 48px rgb(0 0 0 / 22%);
}

/* The usage page as a floating panel, opened from the sidebar entry. It reuses the insight
   backdrop geometry so the two overlays behave identically; only the frame width differs,
   because this one holds a settings-style panel rather than a single ranking column. */
.${ROOT}-usage-backdrop {
  position: fixed;
  inset: 0;
  z-index: 38;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 24px;
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 62%, transparent);
  backdrop-filter: blur(2px);
}

.${ROOT}-usage-panel {
  width: min(760px, 100%);
  max-height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--mydsh-space-3);
  padding: 20px 22px 24px;
  border-radius: 14px;
  border: 1px solid var(--mydsh-border);
  background: var(--mydsh-surface-raised);
  box-shadow: 0 18px 48px rgb(0 0 0 / 22%);
}

.${ROOT}-usage-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--mydsh-space-3);
}

.${ROOT}-usage-title {
  margin: 0;
  font-size: var(--mydsh-font-lg);
  font-weight: 600;
  color: var(--mydsh-text);
}

.${ROOT}-insight-header {
  display: flex;  align-items: flex-start;
  justify-content: space-between;
  gap: var(--mydsh-space-4);
}

.${ROOT}-insight-heading {
  margin: 0;
  font-size: var(--mydsh-font-lg);
  font-weight: 600;
  color: var(--mydsh-text);
}

.${ROOT}-insight-sub {
  margin: 4px 0 0;
  font-size: var(--mydsh-font-sm);
  color: var(--mydsh-text-muted);
  max-width: 62ch;
}

.${ROOT}-insight-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: var(--mydsh-space-3);
}

.${ROOT}-insight-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--mydsh-space-3);
}

.${ROOT}-insight-controls .${ROOT}-input {
  flex: 1 1 200px;
  min-width: 160px;
}

.${ROOT}-insight-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.${ROOT}-insight-row {
  display: flex;
  align-items: center;
  gap: var(--mydsh-space-3);
  padding: 9px 2px;
  border-bottom: 1px solid var(--mydsh-border);
}

.${ROOT}-insight-row:last-child {
  border-bottom: none;
}

.${ROOT}-insight-main {
  flex: 1 1 auto;
  min-width: 0;
}

.${ROOT}-insight-title {
  font-size: var(--mydsh-font-sm);
  color: var(--mydsh-text);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.${ROOT}-insight-bar {
  height: 4px;
  margin: 6px 0 5px;
  border-radius: 999px;
  background: var(--mydsh-surface-sunken);
  overflow: hidden;
}

.${ROOT}-insight-bar-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--mydsh-accent);
  min-width: 2px;
}

.${ROOT}-insight-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mydsh-space-3);
  font-size: var(--mydsh-font-xs);
  color: var(--mydsh-text-muted);
  font-variant-numeric: tabular-nums;
}

.${ROOT}-insight-cost {
  flex: 0 0 auto;
  font-size: var(--mydsh-font-sm);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--mydsh-text);
}

/* ── agent family page ────────────────────────────────────────────────────
   Same floating layer as the insight page, so it reuses that backdrop and page
   shell and only adds the tree itself. Depth is shown with a left inset rather
   than drawn connector lines: an indent survives narrow widths and wrapping
   labels, where SVG connectors would need re-measuring on every resize. */
.${ROOT}-fleet-entry {
  gap: 6px;
}

.${ROOT}-fleet-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.${ROOT}-fleet-member {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 9px 12px;
  border-radius: 9px;
  border: 1px solid var(--mydsh-border);
  background: var(--mydsh-surface);
  /* Indent per level, capped at 6 so a deep tree stays readable. */
  margin-left: calc(min(var(--fleet-depth, 0), 6) * 14px);
}

.${ROOT}-fleet-member[data-depth="1"] { --fleet-depth: 1; }
.${ROOT}-fleet-member[data-depth="2"] { --fleet-depth: 2; }
.${ROOT}-fleet-member[data-depth="3"] { --fleet-depth: 3; }
.${ROOT}-fleet-member[data-depth="4"] { --fleet-depth: 4; }
.${ROOT}-fleet-member[data-depth="5"] { --fleet-depth: 5; }
.${ROOT}-fleet-member[data-depth="6"] { --fleet-depth: 6; }

.${ROOT}-fleet-member[data-state="running"] {
  border-color: color-mix(in srgb, var(--mydsh-accent) 42%, var(--mydsh-border));
  background: var(--mydsh-accent-soft);
}

.${ROOT}-fleet-member[data-state="diagnostic"] {
  border-color: color-mix(in srgb, var(--mydsh-warn) 45%, var(--mydsh-border));
  background: var(--mydsh-warn-soft);
}

.${ROOT}-fleet-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.${ROOT}-fleet-dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--mydsh-text-muted);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--mydsh-text-muted) 18%, transparent);
}

.${ROOT}-fleet-dot[data-running="yes"] {
  background: var(--mydsh-success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--mydsh-success) 22%, transparent);
  animation: mydsh-fleet-pulse 1.8s ease-in-out infinite;
}

@keyframes mydsh-fleet-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

.${ROOT}-fleet-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--mydsh-font-sm);
  font-weight: 600;
  color: var(--mydsh-text);
}

.${ROOT}-fleet-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mydsh-space-3);
  padding-left: 15px;
  font-size: var(--mydsh-font-xs);
  color: var(--mydsh-text-muted);
  font-variant-numeric: tabular-nums;
}

.${ROOT}-fleet-meta span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 42ch;
}

.${ROOT}-fleet-loading {
  padding: 22px 0;
  text-align: center;
  font-size: var(--mydsh-font-sm);
  color: var(--mydsh-text-muted);
}

/* Reduced motion: the plugin animates state changes, so honour the preference. */
@media (prefers-reduced-motion: reduce) {
  .${ROOT} * {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
  }
}
`;

/**
 * Install the stylesheet once into the page.
 *
 * `insert` is supplied by the Client entry, which owns the `<style>` tag handling.
 * Injection is a one-shot because the loader memoizes this module: re-running it
 * would duplicate every rule.
 */
let installed = false;
export function installStyles(insert) {
  if (installed) return undefined;
  installed = true;
  return insert(STYLES, 'dsh-mydsh/theme.css');
}
