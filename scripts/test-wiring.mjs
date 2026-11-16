/**
 * Check that every control the plugin draws actually does something.
 *
 * Two failures shipped that made the plugin look completely broken, and neither was caught
 * by the existing suites because both were "the code runs, it just doesn't work":
 *
 *  1. The sidebar entry called `layout.selectPanel('settings')`. That method takes a
 *     registered *main* panel key and throws for anything else; the surrounding try/catch —
 *     added to keep a click handler from throwing — swallowed the error, so the button
 *     looked dead. Clicking it must open something the plugin owns.
 *  2. `display.entry` offers four values but only `sidebar` was implemented, so `titlebar`
 *     and `settings` left the plugin with no entry anywhere at all.
 *
 * These assertions read the source because both bugs are present in the *shape* of the code
 * (a swallowed call, a missing branch) rather than in a value a unit test could observe.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const client = await readFile(join(ROOT, 'src/client/index.js'), 'utf8');
const host = await readFile(join(ROOT, 'lib/index.js'), 'utf8');
const settingsPage = await readFile(join(ROOT, 'src/client/settings-page.js'), 'utf8');
const store = await readFile(join(ROOT, 'src/client/store.js'), 'utf8');

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

check('entry: the sidebar button opens a surface the plugin owns', () => {
  // The old handler was `layout.selectPanel('settings')` inside a try/catch. `selectPanel`
  // rejects an unregistered main key, and the catch hid it, so nothing visible happened.
  // The explanatory comment above the replacement names that call, so strip comments first
  // and assert against code only.
  const codeOnly = client
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.doesNotMatch(
    codeOnly,
    /selectPanel\(\s*'settings'\s*\)/,
    'selectPanel takes a main panel key; "settings" is not one, so the call always threw',
  );
  assert.match(
    client,
    /const open = \(\) => usageOpen\.set\(true\)/,
    'the entry must open the plugin\'s own panel',
  );
  assert.match(store, /export const usageOpen = createStore\(false\)/, 'that panel needs its own open state');
  assert.match(
    client,
    /function UsageOverlay\(/,
    'and a component to render it',
  );
});

check('entry: a click handler never hides its own failure', () => {
  // The specific pattern that caused the dead button: a try/catch around the only statement,
  // with no reporting. A handler may guard, but a silent guard on the *only* effect turns a
  // bug into an invisible one.
  const handler = client.slice(client.indexOf('function PluginEntryButton'));
  const body = handler.slice(0, handler.indexOf('\n}'));
  assert.doesNotMatch(
    body,
    /catch\s*\{\s*(\/\/[^\n]*\n\s*)*\}/,
    'an empty catch around the click effect is how the dead button stayed undiagnosed',
  );
});

check('entry: every placement value has an implementation', () => {
  // `display.entry` accepts sidebar / settings / titlebar / hidden. `settings` needs no
  // entry of its own (the section is always registered), `hidden` means none, so the two
  // that must be built are sidebar and titlebar.
  assert.match(client, /display\.entry !== 'sidebar'/, 'the sidebar form must be gated on the placement');
  assert.match(client, /display\.entry !== 'titlebar'/, 'the titlebar form must be gated on the placement');
  assert.match(
    client,
    /h\(TitlebarEntry, \{ ctx \}\)/,
    'the titlebar form must actually be mounted, not merely defined',
  );
  assert.match(
    client,
    /id: IDS\.titlebarEntry/,
    'and mounted under its own id so it does not collide with the account chip',
  );
});

check('overlays: every panel opens over the shell rather than navigating away', () => {
  // `main` is keyed by sidebar entry id and carries the conversation; occupying it would
  // displace the native UI. `shell.overlay` is the additive layer.
  for (const id of ['IDS.usage', 'IDS.insight', 'IDS.fleet']) {
    assert.ok(client.includes(id), `${id} must be registered`);
  }
  const overlayMounts = client.match(/mount\(ctx, 'shell\.overlay'/g) ?? [];
  assert.equal(overlayMounts.length, 3, 'all three overlays belong to the floating layer');
});

check('settings: an unreachable configuration can be repaired from the page', () => {
  // With every module off there is no tab whose controls could switch them back on. The
  // page must not render an empty shell in that state.
  assert.match(
    settingsPage,
    /Panel === undefined[\s\S]{0,400}?RecoverDefaults/,
    'the no-tab state must offer a way back rather than rendering nothing',
  );
  assert.match(
    settingsPage,
    /const RESTORE_SECTIONS = \['display', 'interface', 'usage', 'toolbox'\]/,
    'recovery must cover exactly the sections that decide reachability',
  );
  // Recovery must not wipe unrelated configuration.
  assert.match(
    settingsPage,
    /for \(const key of \['entry', 'usagePlacement', 'fleetPlacement'\]\)/,
    'placement is what makes the entry visible, so it is restored too',
  );
});

check('health: the unreachable posture is reported, not left implicit', () => {
  assert.match(host, /async function posture\(\)/, 'the health route must be able to describe the posture');
  assert.match(
    host,
    /unreachable: anyEnabled === false && entryHidden === true/,
    'the state where nothing can be reached must have a name',
  );
  assert.match(host, /posture: await posture\(\)/, 'and be included in the health payload');
});

console.log(`\nwiring: ${6 - failures}/6 passed`);
process.exit(failures === 0 ? 0 : 1);
