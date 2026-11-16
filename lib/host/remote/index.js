/**
 * Remote access coordination.
 *
 * Owns the tunnel lifecycle and translates between the persisted settings and the
 * tunnel client's configuration. The protocol itself lives in `tunnel.js`; this
 * file decides when to connect, what to tell the UI, and how to stop cleanly.
 */
import { TunnelClient } from './tunnel.js';

export class RemoteAccessManager {
  #settings;
  #logger;
  #client;
  #status = { state: 'off', since: Date.now() };

  constructor({ settings, logger }) {
    this.#settings = settings;
    this.#logger = logger;
  }

  get status() {
    if (this.#client !== undefined) return this.#client.status;
    return { ...this.#status };
  }

  /** The local origin a relay would forward to, when the server is listening. */
  localOrigin(webServer) {
    try {
      return webServer?.getOrigin?.() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Start tunnelling.
   *
   * Refuses without both a relay URL and a listening local server: a tunnel with
   * nothing behind it would accept visitors and fail every request.
   */
  async start(webServer) {
    const config = await this.#settings.section('remote');
    if (config.enabled !== true) {
      this.#status = { state: 'off', since: Date.now() };
      return { ok: true, state: 'off' };
    }
    if (typeof config.relayUrl !== 'string' || config.relayUrl.trim() === '') {
      this.#status = { state: 'error', since: Date.now(), error: 'no relay URL configured' };
      return { ok: false, reason: 'no-relay-url' };
    }

    const origin = this.localOrigin(webServer);
    if (origin === null) {
      this.#status = { state: 'error', since: Date.now(), error: 'local web server is not listening' };
      return { ok: false, reason: 'no-local-origin' };
    }

    // A second start replaces the first rather than leaking a socket.
    if (this.#client !== undefined) await this.#client.disconnect();

    this.#client = new TunnelClient({
      config: {
        relayUrl: config.relayUrl,
        deviceId: config.account,
        autoReconnect: config.autoReconnect === true,
      },
      logger: this.#logger,
      origin,
    });

    return this.#client.connect();
  }

  async stop() {
    if (this.#client !== undefined) {
      await this.#client.disconnect();
      this.#client = undefined;
    }
    this.#status = { state: 'off', since: Date.now() };
    return { ok: true, state: 'off' };
  }
}
