/**
 * Persisted settings for dsh-mydsh.
 *
 * Two layers cooperate:
 *  - The plugin's Cordis `config` row (edited in cordis.patch.yml) carries the
 *    envelope and the module master switches.
 *  - This store carries everything a user changes from the plugin UI.
 *
 * The store lives under `$DSH_HOME/mydsh/settings.json` so it survives plugin
 * upgrades and profile edits. Writes are atomic and coalesced, so a burst of UI
 * toggles produces one disk write instead of one per click.
 */
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { dataRoot, mergeDeep, readJson, writeJsonAtomic, SETTINGS_VERSION } from './util.js';

/** Per-module defaults. Every module is opt-in except the interface polish. */
export const MODULE_DEFAULTS = Object.freeze({
  /**
   * Placement: where the plugin's own entry appears, and where each feature's
   * surface goes.
   *
   * This is the section a user lands on first, and the one that decides whether the
   * other sections are reachable at all, so it is always enabled and has no
   * master switch of its own.
   */
  display: {
    enabled: true,
    // Where the plugin entry lives. `settings` keeps only the settings section.
    entry: 'sidebar',
    // Show today's token total beside the sidebar entry.
    sidebarBadge: true,
    // Replace the shell's brand furniture with the plugin's mark.
    brandMark: false,
    brandName: false,
    // Where the usage surface is placed, independently of its own module switch.
    usagePlacement: 'panel',
    // Where the agent-family entry sits. `header` is the session header's action row,
    // which is the only seat that also carries the session id the page needs; `off`
    // hides the entry without unmounting the page itself.
    fleetPlacement: 'header',
    // Shell density and grouping.
    compactSidebar: false,
    // Hide the shell's own controls where the plugin offers a replacement.
    hideNewSessionButton: false,
    hideBrandMark: false,
    hideBrandName: false,
    accountMenuInTitlebar: false,
    avatarOnly: true,
  },
  interface: {
    enabled: true,
    hideNewSessionButton: false,
    hideBrandMark: false,
    hideBrandName: false,
    compactSidebar: false,
    accountMenuInTitlebar: false,
    avatarOnly: true,
  },
  usage: {
    enabled: true,
    showBalance: true,
    contextInsight: true,
    refreshIntervalMs: 60_000,
    currency: 'CNY',
    usdToCny: 7.2,
  },
  budget: {
    enabled: false,
    action: 'notify',
    rules: [],
  },
  backup: {
    enabled: false,
    destinations: [],
    triggers: { scheduled: false, schedule: '0 3 * * *', afterSession: false, onStartup: false },
    items: {
      workspaces: false,
      conversations: false,
      systemConfig: false,
      plugins: false,
      extras: false,
      models: false,
    },
    archive: { format: 'zip', level: 6, splitSizeMb: 0, encrypt: false, keepCopies: 7, incremental: false },
    retentionDays: 30,
  },
  /**
   * Retry defaults. The flat fields are what every policy inherits unless it
   * overrides them; `policies` adds per-error-kind overrides and `alternatives`
   * is the fallback route chain used when a policy asks to switch.
   */
  retry: {
    enabled: false,
    maxAttempts: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    jitterRatio: 0.1,
    // Resume a turn that stopped without being asked to. `maxAttempts` above governs one
    // model request; these govern a whole turn, which is a different failure with a
    // different budget — a turn can need continuing after its last request succeeded.
    autoContinue: true,
    maxConsecutive: 3,
    cooldownMs: 45000,
    maxCooldownMs: 120000,
    backoffFactor: 2,
    resumeCompletedTurns: false,
    resumeSubagents: false,
    policies: [],
    alternatives: [],
  },
  prompt: {
    enabled: false,
    prefix: '',
    suffix: '',
    scope: 'all',
  },
  remote: {
    enabled: false,
    relayUrl: '',
    account: '',
    autoReconnect: true,
  },
  toolbox: {
    enabled: true,
    modules: {
      memory: false,
      pua: false,
      imageGen: false,
      agencyAgents: false,
      agentTeams: false,
      windowsMcp: false,
      mcpConnector: false,
      configManager: false,
      skillExplorer: false,
    },
  },
});

/** Secrets never enter settings.json; they live in the credentials service. */
export const SECRET_FIELDS = Object.freeze({
  'backup.webdav': ['password', 'username'],
  'backup.oss': ['accessKeyId', 'accessKeySecret'],
  'remote.relay': ['token'],
});

function defaultsOf(key) {
  return key in MODULE_DEFAULTS ? structuredClone(MODULE_DEFAULTS[key]) : {};
}

export class SettingsStore extends EventEmitter {
  /** @type {Record<string, unknown>} */
  #values = {};
  #file;
  #writeChain = Promise.resolve();
  #pending = null;
  #loaded = false;

  constructor(file = join(dataRoot(), 'settings.json')) {
    super();
    this.#file = file;
  }

  get file() {
    return this.#file;
  }

  /** Load persisted values once; later calls are cheap. */
  async load() {
    if (this.#loaded) return this.#values;
    const stored = (await readJson(this.#file)) ?? {};
    const candidate = stored.version === SETTINGS_VERSION ? stored.values : {};
    this.#values = {};
    for (const key of Object.keys(MODULE_DEFAULTS)) {
      this.#values[key] = mergeDeep(defaultsOf(key), candidate?.[key] ?? {});
    }
    // Preserve unknown top-level sections so an older build never deletes a
    // newer build's data.
    for (const [key, value] of Object.entries(candidate ?? {})) {
      if (!(key in this.#values)) this.#values[key] = value;
    }
    this.#loaded = true;
    return this.#values;
  }

  /** Snapshot of every section; callers must not mutate the result. */
  async snapshot() {
    await this.load();
    return structuredClone(this.#values);
  }

  /** Read one section, always a shallow clone. */
  async section(key) {
    await this.load();
    return structuredClone(this.#values[key] ?? defaultsOf(key));
  }

  /**
   * Merge a patch into one section and persist.
   *
   * Coalescing keeps a slider drag from becoming hundreds of writes: while a
   * flush is in flight, later patches accumulate into one pending document.
   */
  async patch(key, patch) {
    await this.load();
    this.#values[key] = mergeDeep(this.#values[key] ?? defaultsOf(key), patch);
    const snapshot = { version: SETTINGS_VERSION, values: structuredClone(this.#values) };
    this.#pending = snapshot;
    this.#writeChain = this.#writeChain.then(() => this.#flush());
    await this.#writeChain;
    this.emit('change', key, structuredClone(this.#values[key]));
    return structuredClone(this.#values[key]);
  }

  /** Replace an entire section, bypassing merge semantics. */
  async replace(key, value) {
    await this.load();
    this.#values[key] = value;
    this.#pending = { version: SETTINGS_VERSION, values: structuredClone(this.#values) };
    this.#writeChain = this.#writeChain.then(() => this.#flush());
    await this.#writeChain;
    this.emit('change', key, structuredClone(this.#values[key]));
    return structuredClone(this.#values[key]);
  }

  async #flush() {
    const snapshot = this.#pending;
    if (snapshot === null) return;
    this.#pending = null;
    await writeJsonAtomic(this.#file, snapshot);
  }

  /** Whether a module is switched on, honouring the master switch. */
  async isModuleEnabled(key) {
    const section = await this.section(key);
    return section?.enabled === true;
  }
}
