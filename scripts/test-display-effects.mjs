/**
 * Check that every `display` switch has a visible effect, not merely a reader.
 *
 * The user's report was "many features don't take effect" — for example hiding the new-session
 * button worked while the settings page was open and reverted on close. That class of bug is
 * invisible to a "field is read somewhere" audit, which is what `audit-dead-settings.mjs`
 * does. This checks the stronger property: each switch must reach a body attribute, a slot
 * registration, or a CSS rule that is actually shipped.
 *
 * A switch that only appears in `applyInterfacePatches` but has no matching CSS rule does
 * nothing, and that is exactly the failure being guarded.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const patches = await readFile(join(ROOT, 'src/client/interface-patches.js'), 'utf8');
const theme = await readFile(join(ROOT, 'src/client/theme.js'), 'utf8');
const client = await readFile(join(ROOT, 'src/client/index.js'), 'utf8');
const hostSettings = await readFile(join(ROOT, 'lib/host/settings.js'), 'utf8');

const failures = [];
const report = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        ${detail}`}`);
  if (!ok) failures.push(name);
};

/** Every `data-mydsh-*` attribute the patch layer writes. */
const written = [...patches.matchAll(/flag\('([a-z-]+)'/g)].map((m) => m[1]);

/** Every attribute the stylesheet reacts to. */
// The attribute selectors are quoted (`body[data-mydsh-hide-new-session='true']`), so the
// name is followed by `=` only after the closing bracket.
// The rules live in PATCH_STYLES (interface-patches.js), not in the theme sheet; they are
// injected as a second sheet because each rule is conditional on a setting.
const consumed = [...patches.matchAll(/body\[data-mydsh-([a-z-]+)=/g)].map((m) => m[1]);

report(
  'patches: every attribute the layer writes has a CSS rule that uses it',
  written.length > 0 && written.every((name) => consumed.includes(name)),
  `written=[${written.join(', ')}] consumed=[${consumed.join(', ')}]`,
);

report(
  'patches: the CSS consumes no attribute nobody writes',
  consumed.every((name) => written.includes(name)),
  `consumed=[${consumed.join(', ')}] written=[${written.join(', ')}]`,
);

// `hideBrandMark` / `hideBrandName` are not attributes: their slots return null. They must be
// read by the slot components, or the switch does nothing.
for (const [field, component] of [['hideBrandMark', 'BrandMarkSlot'], ['hideBrandName', 'BrandNameSlot']]) {
  const body = client.slice(client.indexOf(`function ${component}`));
  const block = body.slice(0, body.indexOf('\n}\n'));
  report(
    `display.${field}: the switch gates its own slot component`,
    block.includes(field),
    `${component} does not read ${field}`,
  );
}

// Placement switches drive registration, so they must appear next to their slot name.
const placements = [
  ['usagePlacement', "'shell.overlay'"],
  ['fleetPlacement', "'conversation.session.header.actions'"],
  ['entry', "'sidebar.panellist'"],
];
for (const [field, slot] of placements) {
  report(
    `display.${field}: reaches the slot it places`,
    client.includes(field),
    `${field} is never read in the client`,
  );
}

// The account chip's switch decides whether the chip draws; the registration is shared with
// the titlebar entry now, so the component must check it.
{
  const body = client.slice(client.indexOf('function AccountSlot'));
  const block = body.slice(0, body.indexOf('\n}\n'));
  report(
    'display.accountMenuInTitlebar: the switch gates the chip',
    block.includes('accountMenuInTitlebar'),
    'AccountSlot does not read accountMenuInTitlebar',
  );
}

// Every section the host declares must be reachable from some surface. A section needs either
// its own tab or a card inside a related one — `budget` belongs to the usage domain rather than
// deserving a tab, but it still has to be rendered somewhere or its switches are unreachable.
const sections = [...hostSettings.matchAll(/^ {2}([a-z]+): \{$/gm)]
  .map((m) => m[1])
  .filter((name) => name !== 'display' && name !== 'interface');
const panels = await readFile(join(ROOT, 'src/client/panel-usage.js'), 'utf8');
const reachable = new Set([
  ...[...client.matchAll(/^\s+([a-z]+): \w+Panel,$/gm)].map((m) => m[1]),
  ...[...panels.matchAll(/update\('([a-z]+)'/g)].map((m) => m[1]),
  ...[...panels.matchAll(/section: '([a-z]+)'/g)].map((m) => m[1]),
]);
const missing = sections.filter((name) => !reachable.has(name));
report(
  'settings: every declared section is reachable from some surface',
  missing.length === 0,
  `no surface renders: ${missing.join(', ')}`,
);

console.log(`\ndisplay effects: ${8 - failures.length}/8 passed`);
process.exit(failures.length === 0 ? 0 : 1);
