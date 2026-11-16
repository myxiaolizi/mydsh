/**
 * Check that every control the plugin draws actually does something.
 *
 * The failures this guards all looked identical from the outside — "the plugin is broken" —
 * and none was caught by a unit test because the code ran fine and simply had no effect:
 *
 *  1. The sidebar entry called `layout.selectPanel('settings')`. That method takes a
 *     registered *main* panel key and throws for anything else; the try/catch added to keep a
 *     click handler safe swallowed the error, so the button looked dead.
 *  2. `display.entry` offers four values but only `sidebar` was implemented.
 *  3. `conversation.header.leading` is a `single` slot, so an optional control claiming it
 *     displaced anything else that wanted the seat.
 *  4. The shell appearance patches were applied from inside the settings page, so closing the
 *     page ran the effect cleanup and silently reverted every one of them.
 *  5. `contextInsight` shipped as a setting with a label and no consumer.
 *  6. The rail icon and its `main` panel are two registrations that must share one id.
 *
 * These read the source because each bug lives in the *shape* of the code — a swallowed
 * call, a missing branch, a wrong slot kind — rather than in a value a unit test could
 * observe at runtime.
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
const patches = await readFile(join(ROOT, 'src/client/interface-patches.js'), 'utf8');
const usagePanel = await readFile(join(ROOT, 'src/client/panel-usage.js'), 'utf8');
const theme = await readFile(join(ROOT, 'src/client/theme.js'), 'utf8');
const dashboard = await readFile(join(ROOT, 'src/client/panel-dashboard.js'), 'utf8');
const settingsPanel = await readFile(join(ROOT, 'src/client/panel-settings.js'), 'utf8');
const featurePanels = await Promise.all(['panel-usage.js', 'panel-backup.js', 'panel-retry.js', 'panel-misc.js', 'panel-dashboard.js']
  .map((name) => readFile(join(ROOT, 'src/client', name), 'utf8')));

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

/** Strip comments so an assertion about code cannot match the prose that explains it. */
const code = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

check('entry: the sidebar button opens a surface the plugin owns', () => {
  // `selectPanel` rejects an unregistered main key, and the catch hid it.
  assert.doesNotMatch(
    code(client),
    /selectPanel\(\s*'settings'\s*\)/,
    'selectPanel takes a main panel key; "settings" is not one, so the call always threw',
  );
  assert.match(client, /usageOpen\.set\(true\)/, "the entry must open the plugin's own panel");
  assert.match(store, /export const usageOpen = createStore\(false\)/, 'that panel needs its own open state');
  assert.match(client, /function UsageOverlay\(/, 'and a component to render it');
});

check('entry: a click handler never hides its own failure', () => {
  const handler = client.slice(client.indexOf('function PluginEntryButton'));
  const body = handler.slice(0, handler.indexOf('\n}'));
  assert.doesNotMatch(
    body,
    /catch\s*\{\s*(\/\/[^\n]*\n\s*)*\}/,
    'an empty catch around the click effect is how the dead button stayed undiagnosed',
  );
});

check('entry: every placement value has an implementation', () => {
  assert.match(client, /display\.entry !== 'sidebar'/, 'the sidebar form must be gated on the placement');
  assert.match(client, /display\.entry !== 'titlebar'/, 'the titlebar form must be gated on the placement');
  assert.match(client, /h\(TitlebarEntry, \{ ctx \}\)/, 'the titlebar form must be mounted, not merely defined');
  assert.match(client, /id: IDS\.titlebarEntry/, 'and mounted under its own id');
});

check('entry: the rail icon and its panel are registered together', () => {
  // `sidebar.panellist` draws the icon and `main` supplies the page it selects; the catalog
  // contract is "each list id addresses the matching main panel". An icon without a matching
  // main key is a dead button.
  assert.match(client, /mount\(ctx, 'main'/, 'the main panel must be registered');
  assert.match(client, /mount\(ctx, 'sidebar\.panellist'/, 'and the rail icon beside it');

  const mainKey = client.match(/mount\(ctx, 'main', \{[\s\S]{0,200}?key: (IDS\.[a-zA-Z]+)/);
  const iconId = client.match(/mount\(ctx, 'sidebar\.panellist', \{[\s\S]{0,200}?id: (IDS\.[a-zA-Z]+)/);
  assert.ok(mainKey, 'the main registration needs a key');
  assert.ok(iconId, 'the icon registration needs an id');
  assert.equal(mainKey[1], iconId[1], 'the icon id and the main key must be the same identifier');
});

check('entry: the sidebar foot is a readout, not a second way in', () => {
  // The product name belongs on the rail icon; the foot shows figures only.
  assert.match(client, /function SidebarUsageReadout\(/, 'the readout must exist');
  const readout = client.slice(client.indexOf('function SidebarUsageReadout'));
  const body = readout.slice(0, readout.indexOf('\n}\n'));
  assert.match(body, /mydsh-readout-tokens/, 'the token figure must be rendered');
  assert.ok(!body.includes('mydsh-entry-label'), 'the foot row must not print the product name');
});

check('overlays: every panel opens over the shell rather than navigating away', () => {
  // `main` is keyed by sidebar entry id and carries the conversation; `shell.overlay` is the
  // additive floating layer that never displaces native UI.
  for (const id of ['IDS.usage', 'IDS.insight', 'IDS.fleet', 'IDS.patches']) {
    assert.ok(client.includes(id), `${id} must be registered`);
  }
  const overlayMounts = client.match(/mount\(ctx, 'shell\.overlay'/g) ?? [];
  assert.equal(overlayMounts.length, 4, 'the three panels plus the headless patch applier');
});

check('overlays: the close control does not scroll with the content', () => {
  // The heading sat inside the scrolling frame, so the close button drifted away with the
  // content and could be scrolled out of reach.
  assert.match(client, /className: 'mydsh-usage-body'/, 'the body must be its own scroll region');
  const marker = `.${'${ROOT}'}-usage-panel {`;
  const panel = theme.slice(theme.indexOf(marker));
  assert.ok(panel.length > 0, 'the panel rule must exist');
  const panelBody = panel.slice(0, panel.indexOf('\n}'));
  assert.match(panelBody, /overflow: hidden/, 'the frame must not scroll');
  assert.match(panelBody, /flex-direction: column/, 'the frame is a column: heading then body');
});

check('slots: a single seat is never claimed by a feature that may not draw', () => {
  // `conversation.header.leading` is `single`: registering takes the seat outright, even if
  // the component returns null. Both the account chip and the titlebar entry tried to use it,
  // so one displaced the other and the seat was held while the feature was switched off.
  assert.doesNotMatch(
    code(client),
    /mount\(ctx, 'conversation\.header\.leading'/,
    'a single slot must not be claimed by an optional control',
  );
  const utilities = client.match(/mount\(ctx, 'conversation\.session\.header\.utilities'/g) ?? [];
  assert.equal(utilities.length, 2, 'the account chip and the titlebar entry share the list seat');

  const orders = [...client.matchAll(/id: IDS\.(account|titlebarEntry),[\s\S]{0,120}?order: (\d+)/g)];
  const seen = new Set();
  for (const match of orders) {
    assert.ok(!seen.has(match[2]), `two header controls share order ${match[2]}`);
    seen.add(match[2]);
  }
});

check('patches: shell appearance outlives the settings page being closed', () => {
  // The effect used to live in the settings page, so closing it ran the cleanup, stripped the
  // body attributes, and silently undid every appearance patch.
  assert.match(
    client,
    /function ShellPatches\(\)[\s\S]{0,140}useInterfacePatches\(settings\)/,
    'a headless component must own the effect',
  );
  assert.match(client, /id: IDS\.patches/, 'and it must be mounted in shell.overlay');

  // Apply and unload are separate effects: a cleanup bound to [settings] re-runs on every
  // change, which is precisely the bug.
  const hook = patches.slice(patches.indexOf('export function useInterfacePatches'));
  const body = hook.slice(0, hook.indexOf('\n}'));
  assert.equal((body.match(/React\.useEffect/g) ?? []).length, 2, 'apply and unload are separate effects');
  assert.match(body, /\}, \[settings\]\)/, 'the apply effect tracks the settings snapshot');
  assert.match(body, /\}, \[\]\)/, 'the unload effect runs once');
});

check('settings: an unreachable configuration can be repaired from the page', () => {
  // With every module off there is no tab whose controls could switch them back on.
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

check('usage: the context insight toggle is actually read', () => {
  // `contextInsight` shipped as a setting with a label and no consumer, so switching it off
  // changed nothing.
  assert.match(
    usagePanel,
    /contextInsight === true \? h\(ContextCard/,
    'the card must be gated on the stored switch',
  );
  assert.match(usagePanel, /function ContextCard\(/, 'and the card must exist');
});

check('usage: the overview states every figure the aggregate carries', () => {
  // Four cards left cache, reasoning, and the derived averages unstated.
  const overview = usagePanel.slice(usagePanel.indexOf('function Overview'));
  const body = overview.slice(0, overview.indexOf('\n}\n'));
  for (const key of [
    'usage.totalTokens', 'usage.cost', 'usage.input', 'usage.output',
    'usage.cacheRead', 'usage.cacheWrite', 'usage.calls',
  ]) {
    assert.ok(body.includes(key), `${key} needs a card`);
  }
  assert.ok((body.match(/h\(Stat,/g) ?? []).length >= 8, 'at least eight figures');
});

check('dashboard: the plugin opens on data, not on a settings form', () => {
  // `active` falls back to `visible[0]`, so the first tab is the landing page. It must be the
  // dashboard: opening on "where things go" shows a configuration screen to someone who just
  // wanted to know what they spent.
  const tabs = settingsPage.slice(settingsPage.indexOf('export const TABS'));
  // Read the first entry directly: slicing to the first ']' breaks on the comment above it,
  // which contains 'visible[0]'.
  const firstId = tabs.match(/\{ id: '([a-z]+)'/);
  assert.ok(firstId, 'the tab list must start with an entry');
  assert.equal(firstId[1], 'dashboard', 'the dashboard must be the first tab so it is the landing page');

  // And it must actually be bound to a component, or the landing page is blank.
  assert.match(client, /dashboard: Dashboard,/, 'the dashboard tab needs a panel');
  assert.ok("import { Dashboard } from './panel-dashboard.js'" .length > 0 && client.includes("from './panel-dashboard.js'"), 'and the import that provides it');
});

check('dashboard: it never displays a zero it has not measured', () => {
  // The first paint has no payload. Rendering `totals.cost ?? 0` there claims "you spent
  // nothing" for as long as the request takes, and forever if it failed.
  assert.match(dashboard, /const settling = usage\.loading === true/, 'a not-yet-loaded state must be distinguished');
  assert.match(dashboard, /settling[\s\S]{0,120}?common\.loading/, 'and shown as loading rather than as zeros');
  assert.match(dashboard, /usage\.error !== undefined/, 'a failed read must surface, not render as zero');
});
check('settings: configuration lives on one page, not scattered per feature', () => {
  // Every module page used to carry its own switch and settings form, so a feature page read
  // as a form and the thing you came to see was buried under the thing you configure once.
  const withForms = featurePanels.filter((source) => source.includes("h(FieldForm,"));
  assert.equal(withForms.length, 0, 'no feature page may render a settings form');
  const withSwitches = featurePanels.filter((source) => source.includes("h(ModuleToggle,"));
  assert.equal(withSwitches.length, 0, 'no feature page may render a module switch');

  // And the settings page must actually cover every declared section, or a switch has no home.
  for (const section of ['display', 'interface', 'usage', 'budget', 'backup', 'retry', 'prompt', 'remote', 'toolbox']) {
    assert.ok(settingsPanel.includes(`'${section}'`), `${section} is missing from the settings page`);
  }
});

check('settings: a switched-off feature reports itself instead of offering its switch', () => {
  // The replacement for the inline switch: the page says the module is off and points at the
  // settings tab, rather than duplicating a control that belongs elsewhere.
  for (const source of featurePanels) {
    const off = source.includes('enabled !== true');
    // The dashboard decides differently (it has no module of its own), so only assert where a
    // module gate exists at all.
    if (source.includes('usage.trackingOff') || source.includes('.disabledTitle')) {
      assert.ok(off || source.includes('.disabledTitle'), 'a gated feature page must report the off state');
    }
  }
  // The pointer belongs on the feature page (it is what the user sees when the module is off),
  // not on the settings page itself.
  const pointing = featurePanels.filter((source) => source.includes('settings.whereHint'));
  assert.ok(pointing.length > 0, 'a switched-off feature must say where to turn it on');
});

check('settings: the settings page is reachable while modules are off', () => {
  // A page you cannot reach while things are off cannot turn them back on.
  const tabs = settingsPage.slice(settingsPage.indexOf('export const TABS'));
  const settingsTab = tabs.match(/\{ id: 'settings'[^}]*\}/);
  assert.ok(settingsTab, 'the settings tab must exist');
  assert.match(settingsTab[0], /section: null/, 'and must not be hidden by a module switch');
});
console.log(`\nwiring: ${19 - failures}/19 passed`);
process.exit(failures === 0 ? 0 : 1);
