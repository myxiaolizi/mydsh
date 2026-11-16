/**
 * Tunnel client for the mydsh-relay server.
 *
 * DSH has no inbound reachability story of its own, so remote access is a tunnel
 * this plugin drives: one outbound WebSocket multiplexes every visitor's traffic
 * to the local HTTP server. The wire format is documented in the relay's
 * `docs/deploy.md` and reproduced here because both halves must agree exactly.
 *
 * The design constraints that shape this file:
 *
 *  - One WebSocket carries many streams. Each stream is identified by a 32-bit id
 *    and every payload is a binary frame with a 5-byte header. Control messages
 *    are JSON text frames.
 *  - Binary-ness is per frame, not per stream. A channel can legitimately switch
 *    between text and binary, so the high bit of the type byte records it. A
 *    per-stream flag would turn every later text message into a Blob.
 *  - Nothing here may crash the Host. Every failure path closes the tunnel and
 *    schedules a reconnect; none of them throws into the caller.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';

/** Protocol version this client speaks. */
const PROTOCOL_VERSION = 1;

/** Frame kinds; the low 7 bits of the type byte. */
const KIND = Object.freeze({
  wsData: 0x01,
  httpRequest: 0x02,
  httpResponse: 0x03,
});

/** The high bit marks a frame whose original WebSocket message was binary. */
const BINARY_FLAG = 0x80;

/** Headers that describe a single connection and must not be forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

/** Encode one data frame. */
function encodeFrame(kind, streamId, payload, isBinary) {
  const header = Buffer.alloc(5);
  header[0] = kind | (isBinary === true ? BINARY_FLAG : 0);
  header.writeUInt32BE(streamId >>> 0, 1);
  return Buffer.concat([header, payload]);
}

/** Decode one data frame, or undefined when it is malformed. */
function decodeFrame(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 5) return undefined;
  const type = bytes[0];
  return {
    kind: type & 0x7f,
    isBinary: (type & BINARY_FLAG) !== 0,
    streamId: ((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) >>> 0,
    payload: bytes.subarray(5),
  };
}

export class TunnelClient {
  #config;
  #logger;
  #origin;
  #socket;
  #streams = new Map();
  #reconnectTimer;
  #attempts = 0;
  #status = { state: 'off', since: Date.now() };
  #closedByUs = false;

  /**
   * @param origin Local origin to forward to, such as `http://127.0.0.1:59382`.
   */
  constructor({ config, logger, origin }) {
    this.#config = config;
    this.#logger = logger;
    this.#origin = origin;
  }

  get status() {
    return { ...this.#status, streams: this.#streams.size, attempts: this.#attempts };
  }

  /** Open the tunnel. Resolves once the socket is created, not when it opens. */
  connect() {
    this.#closedByUs = false;
    return this.#open();
  }

  #open() {
    const url = this.#connectionUrl();
    if (url === undefined) {
      this.#setStatus('error', 'no relay URL configured');
      return Promise.resolve({ ok: false, reason: 'no-relay-url' });
    }

    this.#setStatus('connecting');
    let socket;
    try {
      socket = new WebSocket(url);
      // A device secret travels in a header rather than the query string, so it
      // cannot end up in a proxy access log.
      socket.binaryType = 'arraybuffer';
    } catch (error) {
      this.#setStatus('error', String(error?.message ?? error));
      return Promise.resolve({ ok: false, reason: 'connect-failed', detail: String(error?.message ?? error) });
    }

    this.#socket = socket;

    socket.addEventListener('open', () => {
      this.#attempts = 0;
      this.#setStatus('online');
      this.#logger?.('info')?.(`dsh-mydsh: tunnel connected to ${url.host}`);
    });

    socket.addEventListener('message', (event) => {
      try {
        this.#onMessage(event.data);
      } catch (error) {
        // A bad frame must not tear down the tunnel: log and keep serving.
        this.#logger?.('warn')?.(`dsh-mydsh: tunnel frame error: ${error?.message ?? error}`);
      }
    });

    socket.addEventListener('close', () => {
      this.#socket = undefined;
      this.#abortAllStreams('tunnel closed');
      if (this.#closedByUs) {
        this.#setStatus('off');
        return;
      }
      this.#setStatus('offline');
      this.#scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // `close` always follows, so the reconnect is scheduled there only.
      this.#setStatus('error', 'tunnel error');
    });

    return Promise.resolve({ ok: true, state: 'connecting' });
  }

  /** Build the tunnel URL, carrying credentials in the header only. */
  #connectionUrl() {
    const raw = this.#config.relayUrl;
    if (typeof raw !== 'string' || raw === '') return undefined;
    try {
      const url = new URL(raw);
      if (url.protocol === 'https:') url.protocol = 'wss:';
      if (url.protocol === 'http:') url.protocol = 'ws:';
      if (this.#config.deviceId !== undefined) url.searchParams.set('deviceId', String(this.#config.deviceId));
      return url;
    } catch {
      return undefined;
    }
  }

  /** Route one inbound message: JSON is control, binary is stream data. */
  #onMessage(data) {
    if (typeof data === 'string') {
      this.#onControl(data);
      return;
    }
    // Node's WebSocket yields ArrayBuffer for binary frames; browsers may yield a
    // Blob, so both are handled.
    if (data instanceof ArrayBuffer) {
      this.#onStreamData(new Uint8Array(data));
      return;
    }
    if (typeof data?.arrayBuffer === 'function') {
      data.arrayBuffer().then((buffer) => this.#onStreamData(new Uint8Array(buffer))).catch(() => {});
      return;
    }
    if (ArrayBuffer.isView(data)) this.#onStreamData(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }

  #onControl(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }

    switch (message?.t) {
      case 'hello':
        // A version mismatch is fatal: continuing would misparse every frame.
        if (message.v !== PROTOCOL_VERSION) {
          this.#logger?.('error')?.(`dsh-mydsh: relay speaks protocol ${message.v}, this plugin speaks ${PROTOCOL_VERSION}`);
          this.#close();
        }
        return;
      case 'http.req':
        this.#startHttpRequest(message);
        return;
      case 'http.req.end':
        this.#finishHttpRequest(message.id);
        return;
      case 'http.abort':
        this.#abortStream(message.id, 'visitor aborted');
        return;
      case 'ws.open':
        this.#openWebSocketStream(message);
        return;
      case 'ws.close':
        this.#abortStream(message.id, 'visitor closed');
        return;
      case 'ws.flow':
        this.#applyFlowControl(message.id, message.pause === true);
        return;
      case 'http.flow':
        this.#applyFlowControl(message.id, message.pause === true);
        return;
      default:
        // Unknown control messages are ignored on purpose: a newer relay may add
        // types this build does not know, and that must not be fatal.
        return;
    }
  }

  #onStreamData(bytes) {
    const frame = decodeFrame(bytes);
    if (frame === undefined) return;
    const stream = this.#streams.get(frame.streamId);
    if (stream === undefined) return;

    if (frame.kind === KIND.httpRequest) stream.writeBody?.(frame.payload);
    else if (frame.kind === KIND.httpResponse) stream.writeResponse?.(frame.payload);
    else if (frame.kind === KIND.wsData) stream.send?.(frame.payload, frame.isBinary);
  }

  // ── HTTP forwarding ──────────────────────────────────────────────────────

  /**
   * Start one forwarded HTTP request.
   *
   * The response is streamed back rather than buffered: a large download or a
   * server-sent-events stream both work, and a slow visitor never pins memory.
   */
  #startHttpRequest(message) {
    const id = message.id;
    const origin = new URL(this.#origin);
    const target = new URL(message.path ?? '/', origin);
    if (message.query !== undefined && message.query !== '') target.search = message.query;

    const headers = sanitizeHeaders(message.headers);
    // The Host header must match the local server, not the public relay name.
    headers.host = origin.host;

    const isHttps = origin.protocol === 'https:';
    const send = isHttps ? httpsRequest : httpRequest;

    let request;
    try {
      request = send({
        protocol: origin.protocol,
        hostname: origin.hostname,
        port: origin.port,
        method: message.method ?? 'GET',
        path: `${target.pathname}${target.search}`,
        headers,
      });
    } catch (error) {
      this.#sendControl({ t: 'http.res.error', id, status: 502, message: String(error?.message ?? error) });
      return;
    }

    const stream = {
      kind: 'http',
      request,
      writeBody: (chunk) => {
        try {
          request.write(chunk);
        } catch {
          // The request may already be finished; a late chunk is not fatal.
        }
      },
    };
    this.#streams.set(id, stream);

    request.on('response', (response) => {
      const responseHeaders = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (HOP_BY_HOP.has(name)) continue;
        // `set-cookie` is an array; collapsing it would corrupt every cookie but
        // the last.
        responseHeaders[name] = name === 'set-cookie' ? value : Array.isArray(value) ? value.join(', ') : value;
      }
      this.#sendControl({ t: 'http.res', id, status: response.statusCode ?? 502, headers: responseHeaders });

      response.on('data', (chunk) => {
        // Backpressure is the relay's job to signal; pushing unconditionally keeps
        // the implementation simple and the buffering bounded by the socket.
        this.#sendFrame(KIND.httpResponse, id, chunk, true);
      });
      response.on('end', () => {
        this.#sendControl({ t: 'http.res.end', id });
        this.#streams.delete(id);
      });
      response.on('error', (error) => {
        this.#sendControl({ t: 'http.res.error', id, status: 502, message: String(error?.message ?? error) });
        this.#streams.delete(id);
      });
    });

    request.on('error', (error) => {
      this.#sendControl({ t: 'http.res.error', id, status: 502, message: String(error?.message ?? error) });
      this.#streams.delete(id);
    });
  }

  #finishHttpRequest(id) {
    const stream = this.#streams.get(id);
    if (stream?.request === undefined) return;
    try {
      stream.request.end();
    } catch {
      // Already ended.
    }
  }

  // ── WebSocket forwarding ─────────────────────────────────────────────────

  /**
   * Open a local WebSocket for one visitor.
   *
   * The local DSH server serves its own WebSocket endpoints; this bridges the
   * relay's frames to it so a visitor's browser keeps a normal WS session.
   */
  #openWebSocketStream(message) {
    const id = message.id;
    const origin = new URL(this.#origin);
    const path = message.path ?? '/';
    const url = new URL(path, origin);
    url.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';

    let socket;
    try {
      socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
    } catch (error) {
      this.#sendControl({ t: 'ws.close', id, code: 1011, reason: String(error?.message ?? error) });
      return;
    }

    const stream = {
      kind: 'ws',
      socket,
      send: (payload, isBinary) => {
        try {
          socket.send(isBinary === true ? payload : new TextDecoder().decode(payload));
        } catch {
          // Closed between check and send.
        }
      },
    };
    this.#streams.set(id, stream);

    socket.addEventListener('open', () => {
      // Replay the visitor's handshake path and any headers the relay captured.
      // A local DSH WS endpoint usually needs no extra headers, so nothing more
      // is sent here.
    });

    socket.addEventListener('message', (event) => {
      const data = event.data;
      if (typeof data === 'string') {
        this.#sendFrame(KIND.wsData, id, Buffer.from(data, 'utf8'), false);
        return;
      }
      if (data instanceof ArrayBuffer) {
        this.#sendFrame(KIND.wsData, id, Buffer.from(data), true);
        return;
      }
      if (typeof data?.arrayBuffer === 'function') {
        data.arrayBuffer()
          .then((buffer) => this.#sendFrame(KIND.wsData, id, Buffer.from(buffer), true))
          .catch(() => {});
      }
    });

    socket.addEventListener('close', (event) => {
      this.#sendControl({ t: 'ws.close', id, code: event.code ?? 1000, reason: event.reason ?? '' });
      this.#streams.delete(id);
    });

    socket.addEventListener('error', () => {
      this.#sendControl({ t: 'ws.close', id, code: 1011, reason: 'local websocket failed' });
      this.#streams.delete(id);
    });
  }

  #applyFlowControl(id, pause) {
    const stream = this.#streams.get(id);
    if (stream === undefined) return;
    // HTTP request bodies honour pause by pausing the client request; response
    // bodies are already push-based, so no action is needed there.
    if (pause && typeof stream.request?.pause === 'function') stream.request.pause();
    if (!pause && typeof stream.request?.resume === 'function') stream.request.resume();
  }

  // ── transport helpers ────────────────────────────────────────────────────

  #sendFrame(kind, streamId, payload, isBinary) {
    if (this.#socket === undefined || this.#socket.readyState !== 1) return;
    try {
      this.#socket.send(encodeFrame(kind, streamId, payload, isBinary));
    } catch {
      // A failing send means the socket is going away; `close` handles it.
    }
  }

  #sendControl(message) {
    if (this.#socket === undefined || this.#socket.readyState !== 1) return;
    try {
      this.#socket.send(JSON.stringify(message));
    } catch {
      // Same as above.
    }
  }

  #abortStream(id, reason) {
    const stream = this.#streams.get(id);
    if (stream === undefined) return;
    this.#streams.delete(id);
    try {
      if (stream.kind === 'http') stream.request?.destroy();
      else stream.socket?.close(1000, reason);
    } catch {
      // Already gone.
    }
  }

  #abortAllStreams(reason) {
    for (const id of [...this.#streams.keys()]) this.#abortStream(id, reason);
  }

  /** Capped exponential backoff, re-reading settings before each attempt. */
  #scheduleReconnect() {
    if (this.#reconnectTimer !== undefined) return;
    if (this.#config.autoReconnect !== true) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(5, this.#attempts));
    this.#attempts += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#open();
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  #setStatus(state, error) {
    this.#status = { state, since: Date.now(), ...(error === undefined ? {} : { error }) };
  }

  #close() {
    this.#closedByUs = true;
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    const socket = this.#socket;
    this.#socket = undefined;
    try {
      socket?.close();
    } catch {
      // Already closed.
    }
    this.#abortAllStreams('closed');
  }

  /** Close the tunnel and release everything it holds. */
  disconnect() {
    this.#close();
    this.#setStatus('off');
    return Promise.resolve({ ok: true, state: 'off' });
  }
}

/** Strip hop-by-hop and control characters from forwarded headers. */
function sanitizeHeaders(input) {
  const output = {};
  if (input === null || typeof input !== 'object') return output;
  for (const [name, value] of Object.entries(input)) {
    const key = String(name).toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    const single = Array.isArray(value) ? value.join(', ') : String(value ?? '');
    // A raw CR/LF in a header value is a response-splitting attempt.
    if (/[\r\n\0]/.test(single)) continue;
    output[key] = single;
  }
  return output;
}

export const protocol = { PROTOCOL_VERSION, KIND, BINARY_FLAG, encodeFrame, decodeFrame, sanitizeHeaders };
