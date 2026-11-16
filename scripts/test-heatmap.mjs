/**
 * Render the Heatmap component and check its shape.
 *
 * This exists because the full-page screenshot renderer is synchronous: a panel that
 * fetches its data renders in its loading state, so the heatmap never appeared in those
 * images and a broken heatmap would have gone unnoticed. Rendering the component with
 * fixed input catches the failures that matter — a cell count that does not match the
 * days given, an idle day rendered as "a little activity", or a missing accessible name.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = new URL('../src/client', import.meta.url).pathname.replace(/^\//, '');
const OUT = join(tmpdir(), `mydsh-heatmap-${Date.now()}`);
await mkdir(OUT, { recursive: true });

// A minimal React shim: the component only needs createElement, hooks, and useMemo.
const SHIM = `
export const Fragment = Symbol('Fragment');
let hooks = [];
let hookIndex = 0;
export function resetHooks() { hooks = []; hookIndex = 0; }
export function createElement(type, props, ...children) {
  const flat = [];
  const push = (child) => {
    if (child === null || child === undefined || child === false || child === true) return;
    if (Array.isArray(child)) { child.forEach(push); return; }
    flat.push(child);
  };
  if (props && props.children !== undefined) push(props.children);
  children.forEach(push);
  return { type, props: props || {}, children: flat };
}
export function useState(initial) {
  const index = hookIndex++;
  if (hooks.length <= index) hooks[index] = initial;
  return [hooks[index], (next) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; }];
}
export function useMemo(factory) { hookIndex++; return factory(); }
export function useCallback(fn) { hookIndex++; return fn; }
export function useRef(initial) { const index = hookIndex++; if (hooks.length <= index) hooks[index] = { current: initial }; return hooks[index]; }
export function useEffect() { hookIndex++; }
export function useLayoutEffect() { hookIndex++; }
export default { createElement, Fragment, useState, useMemo, useCallback, useRef, useEffect, useLayoutEffect };
`;
await writeFile(join(OUT, 'react.mjs'), SHIM, 'utf8');

const esbuild = await import(
  'file:///C:/Data/DSH/myDSH/APP/code/mydsh/node_modules/esbuild/lib/main.js'
);

const entry = `
import React from 'react';
import { createElement as h, resetHooks } from 'react';
import { Heatmap, Sparkline } from '${SRC.replace(/\\/g, '/')}/ui.js';

const DAY = 86400000;
const today = Date.UTC(2026, 10, 16);
const days = [];
for (let index = 13; index >= 0; index -= 1) {
  const start = today - index * DAY;
  // index 5 is a genuine zero: nothing ran that day.
  const value = index === 5 ? 0 : (index + 1) * 1000;
  days.push({ start, value, calls: 0 });
}

resetHooks();
globalThis.__TREE__ = h(Heatmap, {
  days,
  label: 'Activity heatmap',
  formatValue: (value) => value + ' tokens',
  formatDay: (start) => new Date(start).toISOString().slice(0, 10),
});
globalThis.__EMPTY__ = (() => { resetHooks(); return h(Heatmap, { days: [] }); })();

// A rising series, to prove the line is drawn.
resetHooks();
globalThis.__SPARK__ = h(Sparkline, { values: [10, 40, 30, 80, 120], label: 'Context growth' });
// One sample cannot describe a trend, so it must render nothing.
globalThis.__SPARK_ONE__ = (() => { resetHooks(); return h(Sparkline, { values: [42] }); })();
// A flat series must not divide by zero.
globalThis.__SPARK_FLAT__ = (() => { resetHooks(); return h(Sparkline, { values: [7, 7, 7, 7] }); })();
// A missing series must not throw.
globalThis.__SPARK_NONE__ = (() => { resetHooks(); return h(Sparkline, {}); })();
`;
await writeFile(join(OUT, 'entry.mjs'), entry, 'utf8');

await esbuild.build({
  entryPoints: [join(OUT, 'entry.mjs')],
  outfile: join(OUT, 'bundle.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: { react: join(OUT, 'react.mjs') },
  logLevel: 'silent',
});

await import(`file:///${join(OUT, 'bundle.mjs').replace(/\\/g, '/')}`);

function toHtml(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(toHtml).join('');
  if (typeof node !== 'object') return '';
  const props = node.props ?? {};
  const kids = node.children ?? (props.children === undefined ? [] : [].concat(props.children));
  if (typeof node.type === 'function') return toHtml(node.type({ ...props, children: kids }));
  const attrs = [];
  for (const [name, value] of Object.entries(props)) {
    if (name === 'children' || value === undefined || value === null) continue;
    const attribute = name === 'className' ? 'class' : name;
    if (typeof value === 'boolean') { if (value) attrs.push(attribute); continue; }
    attrs.push(`${attribute}="${String(value).replace(/"/g, '&quot;')}"`);
  }
  return `<${node.type}${attrs.length ? ' ' + attrs.join(' ') : ''}>${kids.map(toHtml).join('')}</${node.type}>`;
}

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}\n        ${error.message}`);
  }
};

const html = toHtml(globalThis.__TREE__);

check('heatmap: every day becomes exactly one cell, plus leading calendar blanks', () => {
  const cells = (html.match(/heatmap-cell/g) ?? []).length;
  // Weeks are drawn Monday-first, so a range that does not start on Monday gets blank
  // cells to push the first day onto its real weekday. Those blanks are `empty` and
  // carry no title; every real day must still appear exactly once.
  const blanks = (html.match(/data-level="empty"/g) ?? []).length;
  assert.equal(cells, 14 + blanks, `expected ${14 + blanks} cells (14 days + ${blanks} blanks), rendered ${cells}`);
  const titled = (html.match(/title="/g) ?? []).length;
  assert.equal(titled, 14, `each of the 14 days needs one title, found ${titled}`);
});

check('heatmap: an idle day is marked empty, not "a little activity"', () => {
  assert.ok(html.includes('data-level="0"'), 'the zero-value day should render at level 0');
  // Level 0 must be the only "no work" state; level 1 is reserved for actual activity.
  const level1 = (html.match(/data-level="1"/g) ?? []).length;
  assert.ok(level1 > 0, 'the smallest non-zero day should render at level 1');
});

check('heatmap: the busiest day reaches the top level', () => {
  assert.ok(html.includes('data-level="4"'), 'the busiest day should render at level 4');
});

check('heatmap: each real day carries its date and value as a title', () => {
  const titles = (html.match(/title="/g) ?? []).length;
  assert.equal(titles, 14, `expected 14 titles, found ${titles}`);
  assert.ok(html.includes('tokens'), 'the title should include the formatted value');
});

check('heatmap: the graphic has an accessible name', () => {
  assert.ok(html.includes('aria-label="Activity heatmap"'), 'aria-label should be the label passed in');
  assert.ok(!html.includes('Invalid Date'), 'a date must never render as "Invalid Date"');
});

check('heatmap: no days renders nothing at all', () => {
  assert.equal(toHtml(globalThis.__EMPTY__), '', 'an empty range should render no wrapper');
});

const spark = toHtml(globalThis.__SPARK__);

check('sparkline: a rising series draws a line and a fill', () => {
  assert.equal((spark.match(/<path/g) ?? []).length, 2, 'one path for the fill, one for the line');
  assert.ok(spark.includes('mydsh-spark-line'), 'the line needs its own class for the stroke colour');
  assert.ok(spark.includes('mydsh-spark-area'), 'the fill needs its own class');
});

check('sparkline: every coordinate is a finite number', () => {
  assert.ok(!spark.includes('NaN'), 'a NaN in a path silently blanks the chart');
  assert.ok(/d="M[\d.]/.test(spark), 'the path should start with a move command and a number');
});

check('sparkline: a single sample renders nothing', () => {
  // One point has no direction; drawing it produced a degenerate sliver that read as a
  // rendering bug. The component now declines on its own.
  assert.equal(toHtml(globalThis.__SPARK_ONE__), '', 'one value is not a trend');
});

check('sparkline: a flat series stays finite instead of dividing by zero', () => {
  const flat = toHtml(globalThis.__SPARK_FLAT__);
  assert.ok(flat.length > 0, 'a flat but valid series should still draw');
  assert.ok(!flat.includes('NaN'), 'the zero span must be handled');
});

check('sparkline: a missing series is tolerated', () => {
  assert.equal(toHtml(globalThis.__SPARK_NONE__), '', 'no values means nothing to draw');
});

await rm(OUT, { recursive: true, force: true });

console.log(`\nheatmap: ${12 - failures}/12 passed`);
process.exit(failures === 0 ? 0 : 1);
