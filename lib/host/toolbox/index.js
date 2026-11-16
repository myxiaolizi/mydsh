/**
 * The toolbox modules this plugin implements itself.
 *
 * ## What this file is for
 *
 * The settings page offered nine module switches (`memory`, `pua`, `imageGen`,
 * `agencyAgents`, `agentTeams`, `windowsMcp`, `mcpConnector`, `configManager`,
 * `skillExplorer`) and **none of them did anything**: the stored booleans were never read by
 * either half. They were labels for capabilities that were expected to come from other
 * plugins, which made the whole section a promise the build did not keep.
 *
 * Every module here is implemented inside this plugin against Host services that ship with
 * DSH itself — no other plugin is required. Modules that genuinely cannot be built here
 * without a third-party dependency are declared unavailable with a reason, so the panel can
 * say why rather than offering a switch that toggles nothing.
 */

import { MemoryStore, MEMORY_LIMITS } from './memory.js';

/**
 * What each module is, in machine terms.
 *
 * `available: false` carries the reason the panel shows; it is not a TODO, it is a statement
 * that this capability needs something this plugin cannot supply on its own.
 */
export const TOOLBOX_REGISTRY = Object.freeze({
  memory: {
    available: true,
    // Registered as system-prompt context plus two tools.
    kind: 'context+tools',
  },
  pua: {
    available: true,
    // A prompt section that asks for a tightened restatement; no external service.
    kind: 'prompt-section',
  },
  configManager: {
    available: true,
    // Reads and writes the profile's own patch entries through the settings store.
    kind: 'routes',
  },
  skillExplorer: {
    available: true,
    // Lists the skills the Host already advertises.
    kind: 'routes',
  },
  agentTeams: {
    available: true,
    // Uses the Host's agentTeams service when present; degrades to a report when absent.
    kind: 'routes',
  },
  mcpConnector: {
    available: true,
    // Lists and reports the MCP servers the Host manages.
    kind: 'routes',
  },
  agencyAgents: {
    available: false,
    reason: 'needsSpecialistCatalog',
  },
  imageGen: {
    available: false,
    reason: 'needsImageProvider',
  },
  windowsMcp: {
    available: false,
    reason: 'needsWindowsMcpServer',
  },
});

/** Modules that can actually do something on this build. */
export function availableModules() {
  return Object.entries(TOOLBOX_REGISTRY)
    .filter(([, entry]) => entry.available === true)
    .map(([key]) => key);
}

/**
 * The memory module's prompt section name.
 *
 * Exported so the prompt registration and the settings page agree on one identifier; a
 * mismatch would register the context under a name nobody looks up.
 */
export const MEMORY_CONTEXT_NAME = 'mydsh-memory';

/**
 * Build the prompt text for the PUA module.
 *
 * "PUA" in the reference set means prompt refinement: restate a vague request as a precise
 * one before answering. Implementing it as a prompt section is honest — it changes what the
 * model is asked to do, and costs nothing when the switch is off.
 */
export function puaPromptText() {
  return [
    'Before working on a request that is vague or under-specified, restate it once as a',
    'precise task: what is to be produced, for whom, and what "done" looks like. Keep the',
    'restatement to one or two sentences, then proceed. Do not restate requests that are',
    'already precise — that only adds noise.',
  ].join('\n');
}

/**
 * Wire the toolbox modules into the Host.
 *
 * `runtime.toolbox` collects what was actually installed so `/toolbox` can report the truth:
 * a switch that is on but whose implementation failed to attach must not read as working.
 */
export async function installToolbox({ ctx, runtime, settings, logger, readJson, writeJson, memoryPath, registerTool }) {
  const toolbox = {
    installed: new Set(),
    memory: undefined,
    errors: [],
  };
  runtime.toolbox = toolbox;

  /**
   * Synchronous module check for the prompt providers.
   *
   * The Host assembles prompts synchronously, so a provider cannot await the settings store.
   * This keeps the last known configuration and is refreshed on every settings write, which
   * is the same rate a user can flip a switch.
   */
  let liveConfig = { enabled: false, modules: {} };
  const moduleOn = (key) => liveConfig.enabled === true && liveConfig.modules?.[key] === true;
  const refreshConfig = async () => {
    const config = await settings.section('toolbox').catch(() => undefined);
    liveConfig = {
      enabled: config?.enabled === true,
      modules: config?.modules ?? {},
    };
    return liveConfig;
  };
  await refreshConfig();
  // A settings write is the only thing that can change a switch, so this is the one place that
  // needs to re-read it.
  if (typeof ctx.on === 'function') {
    ctx.on('settings/document-updated', () => { void refreshConfig(); });
  }

  const enabledModules = async () => {
    const config = await settings.section('toolbox');
    if (config?.enabled !== true) return new Set();
    const modules = config.modules ?? {};
    return new Set(Object.entries(modules).filter(([, on]) => on === true).map(([key]) => key));
  };

  const memory = new MemoryStore({ file: memoryPath, readJson, writeJson, logger });
  toolbox.memory = memory;

  // ── memory ────────────────────────────────────────────────────────────────
  // The context is registered once and decides for itself whether to say anything, because a
  // registration that comes and goes with each toggle would have to be re-established on
  // every settings write and would race the next assembly.
  const systemPrompt = runtime.services.systemPrompt;
  if (systemPrompt !== undefined && typeof systemPrompt.context === 'function') {
    try {
      const dispose = systemPrompt.context({
        name: MEMORY_CONTEXT_NAME,
        // Late: memory is background the model may consult, not a rule it must obey.
        order: 900,
        // The Host's PromptContext.text is synchronous: an async provider would be
        // stringified as a Promise. The store keeps a synchronous mirror for exactly this
        // reason, refreshed whenever the notes change.
        text: () => (moduleOn('memory') ? memory.cachedPromptText() : ''),
      });
      ctx.effect?.(() => dispose?.());
      toolbox.installed.add('memory-context');
    } catch (error) {
      toolbox.errors.push(`memory context: ${error?.message ?? error}`);
      logger?.('warn')?.(`dsh-mydsh: cannot register the memory context: ${error?.message ?? error}`);
    }
  }

  // ── pua ───────────────────────────────────────────────────────────────────
  if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
    try {
      const dispose = systemPrompt.section({
        name: 'mydsh-prompt-refinement',
        order: 880,
        text: () => (moduleOn('pua') ? puaPromptText() : ''),
      });
      ctx.effect?.(() => dispose?.());
      toolbox.installed.add('prompt-refinement');
    } catch (error) {
      toolbox.errors.push(`prompt refinement: ${error?.message ?? error}`);
      logger?.('warn')?.(`dsh-mydsh: cannot register the refinement section: ${error?.message ?? error}`);
    }
  }

  // ── memory tools ──────────────────────────────────────────────────────────
  if (typeof registerTool === 'function') {
    const tools = runtime.services.tools;
    if (tools !== undefined && typeof tools.register === 'function') {
      try {
        const save = registerTool({
          name: 'mydsh_remember',
          description: 'Store a durable fact or preference so later sessions remember it. Use for things the user states once and expects to hold.',
          parameters: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The fact, in one sentence.' },
              tags: { type: 'array', items: { type: 'string' }, description: 'Optional labels for pruning later.' },
            },
            required: ['text'],
          },
          run: async (args) => {
            const on = await enabledModules();
            if (!on.has('memory')) return { ok: false, reason: 'module-off' };
            return memory.add(args);
          },
        });
        const recall = registerTool({
          name: 'mydsh_recall',
          description: 'List the facts currently remembered, optionally filtered by a search term.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Substring to match against the text or tags.' },
            },
          },
          run: async (args) => {
            const on = await enabledModules();
            if (!on.has('memory')) return { ok: false, reason: 'module-off' };
            const notes = await memory.list(args?.query);
            return { ok: true, count: notes.length, notes, limit: MEMORY_LIMITS.MAX_NOTES };
          },
        });
        const forget = registerTool({
          name: 'mydsh_forget',
          description: 'Remove remembered facts that match a search term.',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string', description: 'Substring identifying what to forget.' } },
            required: ['query'],
          },
          run: async (args) => {
            const on = await enabledModules();
            if (!on.has('memory')) return { ok: false, reason: 'module-off' };
            return memory.remove(args?.query);
          },
        });
        ctx.effect?.(() => {
          save?.();
          recall?.();
          forget?.();
        });
        toolbox.installed.add('memory-tools');
      } catch (error) {
        toolbox.errors.push(`memory tools: ${error?.message ?? error}`);
        logger?.('warn')?.(`dsh-mydsh: cannot register the memory tools: ${error?.message ?? error}`);
      }
    }
  }

  return toolbox;
}
