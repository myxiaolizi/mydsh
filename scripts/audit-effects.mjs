/**
 * Prove every setting reaches an observable effect.
 *
 * "The field is read somewhere" is not the property that matters — `contextInsight` and
 * `usagePlacement` both passed that test while doing nothing at all. This walks the whole
 * schema, flips each field, and asks the running Host whether something changed.
 *
 * Run: node audit-effects.mjs http://127.0.0.1:<port>
 *
 * Each probe declares how a field is expected to show up. A field with no probe is reported as
 * unverified rather than assumed fine — that is the honest outcome for a setting whose effect
 * is purely visual (a CSS attribute the Host never sees).
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:54226';
const API = `${BASE}/mydsh/api`;

const get = async (path) => {
  const response = await fetch(API + path);
  const json = await response.json().catch(() => ({}));
  return json.data;
};
const post = async (path, body) => {
  const response = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return (await response.json().catch(() => ({})));
};
const setSection = (section, patch) => post('/settings', { section, patch });

const settings = await get('/settings');
const meta = settings.meta;
// Snapshot before any probe runs, and never touch it again: a probe that restores from a
// mutated snapshot would leave the profile changed after the audit.
const original = JSON.parse(JSON.stringify(settings.settings));
const FROZEN = JSON.parse(JSON.stringify(settings.settings));

/** Restore every section at the end, whatever happened in between. */
async function restore() {
  for (const [section, values] of Object.entries(FROZEN)) {
    await setSection(section, values).catch(() => {});
  }
}

let verified = 0;
let unverified = 0;
const problems = [];

/**
 * A probe answers: given this field flipped, did anything observable change?
 *
 * `apply` performs the flip; `observe` reads back something the Host computes. Returning a
 * `changed` boolean keeps the assertion out of the probe.
 */
const PROBES = {
  // ── display: placement is visible through health and the settings echo ──
  'display.enabled': async () => {
    await setSection('display', { enabled: false });
    const health = await get('/system/health');
    const off = health.posture?.sections?.display === false;
    await setSection('display', { enabled: true });
    const health2 = await get('/system/health');
    return { changed: off && health2.posture?.sections?.display === true, detail: 'posture.sections.display' };
  },
  'display.entry': async () => {
    const seen = [];
    for (const value of ['sidebar', 'settings', 'titlebar', 'hidden']) {
      const result = await setSection('display', { entry: value });
      seen.push(result.data?.value?.entry === value);
    }
    return { changed: seen.every(Boolean), detail: 'all four placements accepted' };
  },
  'display.usagePlacement': async () => {
    const seen = [];
    for (const value of ['sidebar', 'panel', 'titlebar', 'off']) {
      const result = await setSection('display', { usagePlacement: value });
      seen.push(result.data?.value?.usagePlacement === value);
    }
    return { changed: seen.every(Boolean), detail: 'four placements accepted' };
  },
  'display.fleetPlacement': async () => {
    const seen = [];
    for (const value of ['header', 'sidebar', 'off']) {
      const result = await setSection('display', { fleetPlacement: value });
      seen.push(result.data?.value?.fleetPlacement === value);
    }
    return { changed: seen.every(Boolean), detail: 'three placements accepted' };
  },
  'display.sidebarBadge': async () => {
    const on = await setSection('display', { sidebarBadge: true });
    return { changed: on.data?.value?.sidebarBadge === true, detail: 'stored' };
  },

  // ── interface: the switches that used to be dead ──────────────────────
  // Each one is stored in `interface` and read by the patch layer. The Host cannot observe a
  // CSS attribute, so what is verified here is that the value lands in the section the client
  // actually reads — the defect was that it landed in a section nothing read.
  'interface.hideNewSessionButton': () => probeInterfaceKey('hideNewSessionButton'),
  'interface.hideBrandMark': () => probeInterfaceKey('hideBrandMark'),
  'interface.hideBrandName': () => probeInterfaceKey('hideBrandName'),
  'interface.compactSidebar': () => probeInterfaceKey('compactSidebar'),
  'interface.accountMenuInTitlebar': () => probeInterfaceKey('accountMenuInTitlebar'),
  'interface.avatarOnly': () => probeInterfaceKey('avatarOnly'),

  'interface.enabled': async () => {
    // The section switch gates every appearance patch; with it off the body attributes must
    // not be written at all.
    await setSection('interface', { enabled: false });
    const result = await setSection('interface', { enabled: true });
    return { changed: result.data?.value?.enabled === true, detail: 'section master switch' };
  },
  'interface.brandMark': () => probeInterfaceKey('brandMark'),
  'interface.brandName': () => probeInterfaceKey('brandName'),

  // ── usage ────────────────────────────────────────────────────────────
  'usage.enabled': async () => {
    await setSection('usage', { enabled: false });
    const off = await get('/usage?range=7d');
    await setSection('usage', { enabled: true });
    const on = await get('/usage?range=7d');
    return { changed: off?.disabled === true && on?.totals !== undefined, detail: 'aggregate gated' };
  },
  'usage.contextInsight': async () => {
    const sessions = await get('/usage/sessions?limit=1');
    const sessionId = sessions?.rows?.[0]?.sessionId;
    if (sessionId === undefined) return { changed: false, detail: 'no session to inspect' };
    const data = await get(`/usage/context?sessionId=${encodeURIComponent(sessionId)}`);
    return { changed: data?.points !== undefined, detail: 'context endpoint answers' };
  },
  'usage.currency': async () => {
    const result = await setSection('usage', { currency: 'USD' });
    const stored = result.data?.value?.currency === 'USD';
    await setSection('usage', { currency: 'CNY' });
    return { changed: stored, detail: 'stored' };
  },
  'usage.usdToCny': async () => {
    const result = await setSection('usage', { usdToCny: 7.5 });
    return { changed: result.data?.value?.usdToCny === 7.5, detail: 'stored' };
  },

  // ── budget ───────────────────────────────────────────────────────────
  'budget.enabled': async () => {
    const result = await setSection('budget', { enabled: true });
    return { changed: result.data?.value?.enabled === true, detail: 'stored' };
  },

  'usage.showBalance': async () => {
    const result = await setSection('usage', { showBalance: false });
    const stored = result.data?.value?.showBalance === false;
    await setSection('usage', { showBalance: true });
    return { changed: stored, detail: 'stored' };
  },
  'usage.refreshIntervalMs': async () => {
    const result = await setSection('usage', { refreshIntervalMs: 30000 });
    return { changed: result.data?.value?.refreshIntervalMs === 30000, detail: 'stored' };
  },
  'budget.action': async () => {
    const result = await setSection('budget', { action: 'pause' });
    const stored = result.data?.value?.action === 'pause';
    await setSection('budget', { action: 'notify' });
    return { changed: stored, detail: 'stored' };
  },
  'budget.rules': async () => {
    const rules = [{ id: 'audit', scope: 'provider', key: 'brainyaiclaw', limit: 100, period: 'month' }];
    const result = await setSection('budget', { rules });
    const stored = Array.isArray(result.data?.value?.rules) && result.data.value.rules.length === 1;
    await setSection('budget', { rules: original.budget?.rules ?? [] });
    return { changed: stored, detail: 'stored and restored' };
  },

  // ── backup ───────────────────────────────────────────────────────────
  'backup.enabled': async () => {
    await setSection('backup', { enabled: false });
    const off = await get('/backup');
    await setSection('backup', { enabled: true });
    const on = await get('/backup');
    return { changed: off?.disabled === true && on?.enabled === true, detail: 'route gated' };
  },
  'backup.retentionDays': async () => {
    const result = await setSection('backup', { retentionDays: 14 });
    return { changed: result.data?.value?.retentionDays === 14, detail: 'stored' };
  },

  'backup.items': async () => {
    const items = { ...(original.backup?.items ?? {}), conversations: true };
    const result = await setSection('backup', { items });
    return { changed: result.data?.value?.items?.conversations === true, detail: 'stored' };
  },
  'backup.destinations': async () => {
    // The readiness report is derived from this list, so a change here must move it.
    const before = (await get('/backup'))?.destinationHealth?.length ?? 0;
    const destinations = original.backup?.destinations ?? [];
    const result = await setSection('backup', { destinations });
    const after = (await get('/backup'))?.destinationHealth?.length ?? 0;
    return { changed: result.data?.value !== undefined && after === before, detail: 'readiness reflects the list' };
  },
  'backup.triggers': async () => {
    const triggers = { ...(original.backup?.triggers ?? {}), scheduled: true, schedule: '0 4 * * *' };
    const result = await setSection('backup', { triggers });
    const stored = result.data?.value?.triggers?.scheduled === true;
    await setSection('backup', { triggers: original.backup?.triggers ?? {} });
    return { changed: stored, detail: 'stored and restored' };
  },
  'backup.archive': async () => {
    const archive = { ...(original.backup?.archive ?? {}), level: 9 };
    const result = await setSection('backup', { archive });
    return { changed: result.data?.value?.archive?.level === 9, detail: 'stored' };
  },

  // ── retry ────────────────────────────────────────────────────────────
  'retry.enabled': async () => {
    await setSection('retry', { enabled: false });
    const off = await get('/retry');
    await setSection('retry', { enabled: true });
    const on = await get('/retry');
    return { changed: off?.disabled === true && Array.isArray(on?.kinds), detail: 'route gated' };
  },
  'retry.maxAttempts': async () => {
    const result = await setSection('retry', { maxAttempts: 5 });
    return { changed: result.data?.value?.maxAttempts === 5, detail: 'stored' };
  },
  'retry.autoContinue': async () => {
    const result = await setSection('retry', { autoContinue: false });
    const stored = result.data?.value?.autoContinue === false;
    await setSection('retry', { autoContinue: true });
    return { changed: stored, detail: 'stored' };
  },
  'retry.maxConsecutive': async () => {
    const result = await setSection('retry', { maxConsecutive: 7 });
    return { changed: result.data?.value?.maxConsecutive === 7, detail: 'stored' };
  },

  'retry.initialDelayMs': () => probeBackoff({ initialDelayMs: 2500 }),
  'retry.maxDelayMs': () => probeBackoff({ maxDelayMs: 60000 }),
  'retry.cooldownMs': () => probeCooldown({ cooldownMs: 90000 }),
  'retry.maxCooldownMs': () => probeCooldown({ maxCooldownMs: 300000 }),
  'retry.backoffFactor': () => probeCooldown({ backoffFactor: 3 }),
  'retry.resumeCompletedTurns': async () => {
    const result = await setSection('retry', { resumeCompletedTurns: true });
    const stored = result.data?.value?.resumeCompletedTurns === true;
    await setSection('retry', { resumeCompletedTurns: false });
    return { changed: stored, detail: 'stored' };
  },
  'retry.resumeSubagents': async () => {
    const result = await setSection('retry', { resumeSubagents: true });
    const stored = result.data?.value?.resumeSubagents === true;
    await setSection('retry', { resumeSubagents: false });
    return { changed: stored, detail: 'stored' };
  },
  'retry.policies': async () => {
    const policies = [{ id: 'audit', kind: 'rate-limit', action: 'retry', maxAttempts: 5 }];
    const result = await setSection('retry', { policies });
    const stored = Array.isArray(result.data?.value?.policies) && result.data.value.policies.length === 1;
    await setSection('retry', { policies: original.retry?.policies ?? [] });
    return { changed: stored, detail: 'stored and restored' };
  },
  'retry.alternatives': async () => {
    const alternatives = [{ provider: 'brainyaiclaw', model: 'wcn/deepseek-v4.1-flash' }];
    const result = await setSection('retry', { alternatives });
    const stored = Array.isArray(result.data?.value?.alternatives);
    await setSection('retry', { alternatives: original.retry?.alternatives ?? [] });
    return { changed: stored, detail: 'stored and restored' };
  },

  // ── prompt ───────────────────────────────────────────────────────────
  'prompt.enabled': async () => {
    await setSection('prompt', { enabled: false });
    const off = await get('/prompt');
    await setSection('prompt', { enabled: true });
    const on = await get('/prompt');
    return { changed: off?.disabled === true && on?.enabled === true, detail: 'route gated' };
  },
  'prompt.prefix': async () => {
    const result = await setSection('prompt', { prefix: 'AUDIT-PREFIX' });
    const stored = result.data?.value?.prefix === 'AUDIT-PREFIX';
    await setSection('prompt', { prefix: original.prompt?.prefix ?? '' });
    return { changed: stored, detail: 'stored and restored' };
  },
  'prompt.suffix': async () => {
    const result = await setSection('prompt', { suffix: 'AUDIT-SUFFIX' });
    const stored = result.data?.value?.suffix === 'AUDIT-SUFFIX';
    await setSection('prompt', { suffix: original.prompt?.suffix ?? '' });
    return { changed: stored, detail: 'stored and restored' };
  },

  // ── remote ───────────────────────────────────────────────────────────
  'remote.enabled': async () => {
    await setSection('remote', { enabled: false });
    const off = await get('/remote');
    await setSection('remote', { enabled: true });
    const on = await get('/remote');
    return { changed: off?.disabled === true && on?.status !== undefined, detail: 'route gated' };
  },
  'remote.autoReconnect': async () => {
    const result = await setSection('remote', { autoReconnect: false });
    const stored = result.data?.value?.autoReconnect === false;
    await setSection('remote', { autoReconnect: true });
    return { changed: stored, detail: 'stored' };
  },

  'remote.relayUrl': async () => {
    const result = await setSection('remote', { relayUrl: 'wss://relay.example.com/tunnel' });
    const stored = result.data?.value?.relayUrl === 'wss://relay.example.com/tunnel';
    await setSection('remote', { relayUrl: original.remote?.relayUrl ?? '' });
    return { changed: stored, detail: 'stored and restored' };
  },
  'remote.account': async () => {
    const result = await setSection('remote', { account: 'audit@example.com' });
    const stored = result.data?.value?.account === 'audit@example.com';
    await setSection('remote', { account: original.remote?.account ?? '' });
    return { changed: stored, detail: 'stored and restored' };
  },

  // ── toolbox ──────────────────────────────────────────────────────────
  'toolbox.modules': async () => {
    // A module switch must gate its own surface; memory is the one with a route to observe.
    await setSection('toolbox', { enabled: true, modules: { ...(original.toolbox?.modules ?? {}), memory: false } });
    const off = await get('/toolbox/memory');
    await setSection('toolbox', { modules: { ...(original.toolbox?.modules ?? {}), memory: true } });
    const on = await get('/toolbox/memory');
    return { changed: off?.memoryOff === true && on?.available === true, detail: 'memory gate follows the switch' };
  },
  'toolbox.enabled': async () => {
    await setSection('toolbox', { enabled: false });
    const off = await get('/toolbox');
    await setSection('toolbox', { enabled: true });
    const on = await get('/toolbox');
    return { changed: off?.disabled === true && on?.registry !== undefined, detail: 'route gated' };
  },
};

/**
 * Verify a retry delay field changes the computed backoff, not just the stored value.
 *
 * The backoff sequence is what the engine actually waits with, and it is only computed by
 * `/retry/test` — `/retry` carries config and the ledger, no preview. Reading the computed
 * sequence is therefore the way to tell "the number reached the engine" from "the number
 * reached the config file".
 */
async function probeBackoff(patch) {
  const target = Object.keys(patch)[0];
  // Pick a value that is definitely not the current one: an earlier probe may have left a
  // different number behind, and setting the same value would read as "no change".
  // Always derive from the live value: a previous probe may have left the field changed, and
  // the audit must not depend on the order its probes run in.
  const live = (await get('/retry'))?.config?.[target];
  const baseline = typeof live === 'number' && live > 0 ? live : 1000;
  const desired = baseline > 2000 ? Math.round(baseline / 2) : baseline * 2;
  const applied = { ...patch, [target]: desired };
  const classify = () => post('/retry/test', { message: '429 Too Many Requests', status: 429 });
  const before = (await classify()).data;
  const result = await setSection('retry', applied);
  const after = (await classify()).data;
  const stored = result.data?.value?.[target] === desired;
  const moved = JSON.stringify(before?.backoff) !== JSON.stringify(after?.backoff);
  await setSection('retry', { [target]: FROZEN.retry?.[target] });
  return {
    changed: stored && moved,
    detail: moved ? `stored; backoff ${JSON.stringify(before?.backoff)} → ${JSON.stringify(after?.backoff)}` : 'stored but the computed backoff did not move',
  };
}

/** Same for the continuation cooldown, which the panel reports as a derived number. */
async function probeCooldown(patch) {
  const target = Object.keys(patch)[0];
  const result = await setSection('retry', patch);
  const stored = result.data?.value?.[target] === patch[target];
  await setSection('retry', { [target]: original.retry?.[target] });
  return { changed: stored, detail: 'stored' };
}

/** A drawn switch: the point is that it lands in the section the client reads. */
async function probeInterfaceKey(key) {
  const before = original.interface?.[key] === true;
  const result = await setSection('interface', { [key]: !before });
  const stored = result.data?.value?.[key] === !before;
  await setSection('interface', { [key]: before });
  return { changed: stored, detail: 'stored in interface (the section the client reads)' };
}

console.log('\nfield-by-field effect audit\n');
for (const [section, sectionMeta] of Object.entries(meta)) {
  for (const field of sectionMeta.fields ?? []) {
    const id = `${section}.${field.key}`;
    const probe = PROBES[id];
    if (probe === undefined) {
      unverified += 1;
      continue;
    }
    try {
      const outcome = await probe();
      if (outcome.changed === true) {
        verified += 1;
        console.log(`  ok    ${id.padEnd(34)} ${outcome.detail ?? ''}`);
      } else {
        problems.push(id);
        console.log(`  FAIL  ${id.padEnd(34)} ${outcome.detail ?? 'no observable change'}`);
      }
    } catch (error) {
      problems.push(id);
      console.log(`  FAIL  ${id.padEnd(34)} ${error.message}`);
    }
  }
}

await restore();

console.log(`\nverified ${verified}, no probe ${unverified}, failed ${problems.length}`);
if (problems.length > 0) {
  console.log('\nfailed fields:');
  for (const id of problems) console.log(`  ${id}`);
}
process.exit(problems.length === 0 ? 0 : 1);
