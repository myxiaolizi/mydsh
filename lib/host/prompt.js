/**
 * System prompt customization.
 *
 * DSH assembles its system prompt from sections contributed by many packages,
 * then presents them through the `system-prompt/assemble` waterfall. This module
 * uses that seam to prepend or append the user's own instructions without
 * rewriting anyone else's contribution.
 *
 * The customization is presented as an extra section rather than by mutating an
 * existing one, so disabling this feature restores the composed prompt exactly —
 * no residue from a previous configuration.
 */
import { newId } from './util.js';

/** Section id registered with the prompt service. */
const SECTION_ID = 'mydsh/user-instructions';

export class PromptCustomizer {
  #settings;
  #logger;
  #section;
  #dispose;

  constructor({ settings, logger }) {
    this.#settings = settings;
    this.#logger = logger;
  }

  /**
   * Register the prompt section.
   *
   * Registration is synchronous and idempotent; the section body is read at
   * presentation time so an edit applies to the next turn without a reload.
   */
  attach(ctx) {
    const systemPrompt = ctx.get('systemPrompt');
    if (systemPrompt === undefined) {
      this.#logger?.('warn')?.('dsh-mydsh: no systemPrompt service; prompt customization is unavailable');
      return;
    }

    try {
      this.#section = systemPrompt.section({
        id: SECTION_ID,
        order: 900,
        title: () => 'User instructions (我的DSH)',
        // The renderer runs for every assembled prompt, so it must be cheap and
        // must never throw into the assembler.
        render: () => this.#render(),
      });
    } catch (error) {
      this.#logger?.('warn')?.(`dsh-mydsh: cannot register the prompt section: ${error}`);
    }
  }

  async #render() {
    try {
      const config = await this.#settings.section('prompt');
      if (config.enabled !== true) return undefined;
      const parts = [];
      if (typeof config.prefix === 'string' && config.prefix.trim() !== '') parts.push(config.prefix.trim());
      if (typeof config.suffix === 'string' && config.suffix.trim() !== '') parts.push(config.suffix.trim());
      if (parts.length === 0) return undefined;
      return parts.join('\n\n');
    } catch {
      // A prompt that fails to render must not break a turn; fall back to none.
      return undefined;
    }
  }

  dispose() {
    try {
      this.#section?.();
    } catch {
      // Disposal during unload must not throw.
    }
    this.#dispose = undefined;
  }
}
