// 隧道的配对与双向转发层：把「公网访客」和「内网设备的插件连接」接起来。
//
// ── 线上协议（relay ⇄ 插件端） ────────────────────────────────────────────
// 一条 WebSocket 上复用所有通道，通过 32 位 streamId 区分。数据帧用二进制，
// 控制帧用 JSON 文本，两者都可被现有 WebSocket 实现直接处理：
//
//   二进制帧：  [1 字节 type][4 字节 streamId BE][payload...]
//     type 低 7 位是 kind，最高位 0x80 表示「这条消息原本是 WebSocket 二进制帧」：
//     kind = 0x01  访客 WebSocket 的帧体（文本/二进制由 0x80 位区分）
//     kind = 0x02  HTTP 请求体分片
//     kind = 0x03  HTTP 响应体分片
//
//     文本/二进制属性必须逐条带上，不能每个通道记一个标志：WebSocket 允许同一条
//     连接混发文本帧与二进制帧，浏览器端也真的会区分（string vs Blob）。按通道
//     记标志的话，一旦某条是二进制，后续所有文本都会被当二进制投递，前端拿到
//     Blob 就直接解析失败。
//
//   文本帧（JSON）：见下方 MSG 常量与 README 的协议表。
//
// 为什么二进制帧要自带 kind 和 id 而不是每片都包 JSON：视频/前端静态资源一旦
// 走 JSON 就得 base64，体积和 CPU 都白涨 33%；而纯二进制又无法表达「这是哪个
// 通道」，所以折中是 5 字节的固定头。
//
// ── 流控 ─────────────────────────────────────────────────────────────────
// 中继两侧速度天然不匹配（内网上行 vs 公网下行）。任一方向积压超过高水位就向
// 上游发 pause，降到低水位再 resume。只做「让上游停发」而不做「丢数据」，
// 因为 WebSocket 语义要求消息完整。

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createLogger, nowMs, sanitizeHeaderValue, isValidHeaderName, isHopByHopHeader } from './util.js';
import { establishConnection, rejectUpgrade, CLOSE_CODE } from './websocket.js';

const log = createLogger('tunnel');

export const KIND = {
  WS_DATA: 0x01,
  HTTP_REQ_BODY: 0x02,
  HTTP_RES_BODY: 0x03,
};

// 数据帧首字节的最高位：置位表示这条消息原本是 WebSocket 二进制帧。
const BINARY_FLAG = 0x80;

export const MSG = {
  HELLO: 'hello',
  WS_OPEN: 'ws.open',
  WS_CLOSE: 'ws.close',
  WS_FLOW: 'ws.flow',
  HTTP_REQ: 'http.req',
  HTTP_REQ_END: 'http.req.end',
  HTTP_ABORT: 'http.abort',
  HTTP_RES: 'http.res',
  HTTP_RES_END: 'http.res.end',
  HTTP_RES_ERROR: 'http.res.error',
  HTTP_FLOW: 'http.flow',
};

// 高/低水位（字节）。取 1 MiB / 256 KiB：既能让大文件通过，又不至于
// 让单个慢消费者把整机内存吃掉。
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;

const MAX_TEXT_CONTROL = 64 * 1024;
const MAX_HEADER_COUNT = 100;

let nextStreamId = 1;

/** 32 位自增 streamId；0 保留为「无」。伪造/回绕都在这里挡住。 */
function allocStreamId() {
  for (;;) {
    const id = nextStreamId;
    nextStreamId = nextStreamId >= 0xffffffff ? 1 : nextStreamId + 1;
    if (id !== 0) return id;
  }
}

export function encodeDataFrame(kind, streamId, payload, binary = false) {
  const head = Buffer.allocUnsafe(5);
  head[0] = (kind & 0x7f) | (binary ? BINARY_FLAG : 0);
  head.writeUInt32BE(streamId >>> 0, 1);
  return Buffer.concat([head, payload], 5 + payload.length);
}

export function decodeDataFrame(buf) {
  if (buf.length < 5) return null;
  const type = buf[0];
  return {
    kind: type & 0x7f,
    binary: (type & BINARY_FLAG) !== 0,
    streamId: buf.readUInt32BE(1),
    payload: buf.subarray(5),
  };
}

/* ------------------------------------------------------------ 访客 WS 通道 */

class VisitorChannel {
  constructor({ streamId, ws, ip, userAgent, path, host, device }) {
    this.streamId = streamId;
    this.ws = ws;
    this.ip = ip;
    this.userAgent = userAgent;
    this.path = path;
    this.host = host;
    this.device = device;
    this.startedAt = nowMs();
    this.bytesToDevice = 0;
    this.bytesToVisitor = 0;
    this.closed = false;
    this.paused = false;
  }
}

/* ------------------------------------------------------------ HTTP 挂起表 */

class PendingHttp {
  constructor({ streamId, res, req, timer }) {
    this.streamId = streamId;
    this.res = res;
    this.req = req;
    this.timer = timer;
    this.headWritten = false;
    this.bytesOut = 0;
    this.bytesIn = 0;
    this.done = false;
    this.paused = false;
    this.onDrain = null;
  }
}

/* --------------------------------------------------------------- 设备隧道 */

class DeviceTunnel extends EventEmitter {
  #hub;
  #ws;
  #channels = new Map();
  #pending = new Map();
  #closed = false;
  #flowPending = new Set();

  constructor(hub, device, ws) {
    super();
    this.#hub = hub;
    this.#ws = ws;
    this.device = device;
    this.deviceId = device.id;
    this.connectedAt = nowMs();
    this.connectionId = crypto.randomBytes(6).toString('hex');
    this.wsId = ws.id;
  }

  get ws() {
    return this.#ws;
  }

  get isOpen() {
    return !this.#closed && this.#ws.isOpen;
  }

  get channelCount() {
    return this.#channels.size;
  }

  get httpPendingCount() {
    return this.#pending.size;
  }

  markInterrupted(reason) {
    if (this.#closed) return;
    this.#closed = true;
    this.emit('down', reason);
  }

  attach(heartbeatMs, graceMs) {
    const ws = this.#ws;
    ws.on('message', (data, isBinary) => {
      if (!this.isOpen) return;
      try {
        if (isBinary) this.#onBinary(data);
        else this.#onControl(data);
      } catch (err) {
        log.warn('处理插件消息失败', { deviceId: this.deviceId, error: err.message });
      }
    });
    ws.on('error', (err) => {
      log.warn('插件连接出错', { deviceId: this.deviceId, error: err.message });
    });
    ws.on('close', ({ code, reason }) => {
      this.markInterrupted(`closed:${code}`);
      log.info('设备隧道断开', { deviceId: this.deviceId, code, reason: String(reason || '').slice(0, 80) });
    });
    ws.startHeartbeat(heartbeatMs, () => {
      log.warn('插件心跳超时，主动断开', { deviceId: this.deviceId });
    });
    // 首帧下发 hello：插件据此确认协议版本与自己的 deviceId，
    // 以便在版本不匹配时立刻报错而不是「连上了但什么都不对」。
    this.sendControl({
      t: MSG.HELLO,
      v: 1,
      deviceId: this.deviceId,
      serverTime: nowMs(),
      graceMs,
      limits: { maxTextControl: MAX_TEXT_CONTROL, highWater: HIGH_WATER, lowWater: LOW_WATER },
    });
    // 事件监听器绑定完毕后再放行握手阶段残留的首帧，否则会 emit 到空气里。
    ws.flushHandshakeLeftover();
  }

  sendControl(obj) {
    if (!this.#ws.isOpen) return false;
    let text;
    try {
      text = JSON.stringify(obj);
    } catch {
      return false;
    }
    if (text.length > MAX_TEXT_CONTROL) {
      log.warn('控制消息过大，已丢弃', { deviceId: this.deviceId, t: obj?.t, size: text.length });
      return false;
    }
    this.#applyBackpressureToPlugin(this.#ws.sendText(text));
    return true;
  }

  sendData(kind, streamId, payload, binary = false) {
    if (!this.#ws.isOpen) return false;
    const frame = encodeDataFrame(kind, streamId, payload, binary);
    const ok = this.#ws.sendBinary(frame);
    this.#applyBackpressureToPlugin(ok);
    return ok;
  }

  /**
   * 插件侧写不动时，停止从所有访客读取。这是最粗但最可靠的背压：
   * 精确到通道的控制需要插件配合暂停单个本地连接，收益不值得复杂度。
   */
  #applyBackpressureToPlugin(ok) {
    if (ok) return;
    if (this.#backpressured) return;
    this.#backpressured = true;
    for (const ch of this.#channels.values()) ch.ws.pauseInput();
    this.#ws.once('drain', () => {
      this.#backpressured = false;
      for (const ch of this.#channels.values()) ch.ws.resumeInput();
    });
  }

  #backpressured = false;

  /* ------------------------------------------------------ 插件 → 中转处理 */

  #onBinary(data) {
    const frame = decodeDataFrame(data);
    if (!frame) return;
    const { kind, streamId, payload, binary } = frame;
    if (kind === KIND.WS_DATA) {
      const ch = this.#channels.get(streamId);
      if (!ch) {
        // 通道可能刚被访客关掉，这类竞态属于正常现象，不当作错误。
        return;
      }
      ch.bytesToVisitor += payload.length;
      // binary 属性逐条跟随，见文件头对 0x80 位的解释。
      const ok = ch.ws.send(payload, { binary });
      if (!ok) {
        // 访客侧积压：请插件暂停该通道的本地读取。
        this.#requestFlow(ch.streamId, 'ws', true);
      }
      return;
    }
    if (kind === KIND.HTTP_RES_BODY) {
      const p = this.#pending.get(streamId);
      if (!p || p.done) return;
      p.bytesOut += payload.length;
      if (!p.headWritten) {
        // 插件没先发 http.res 就推 body，属于协议违规；按 502 处理以免浏览器挂死。
        this.#failHttp(p, 502, '插件端协议错误：缺少响应头');
        return;
      }
      if (!p.res.writableEnded) {
        const ok = p.res.write(payload);
        if (!ok) this.#pauseHttp(p, true);
      }
      return;
    }
    log.debug('收到未知数据帧 kind', { deviceId: this.deviceId, kind });
  }

  #onControl(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      log.warn('插件控制消息不是合法 JSON', { deviceId: this.deviceId });
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    const t = msg.t;

    if (t === MSG.WS_CLOSE) {
      const ch = this.#takeChannel(msg.id);
      if (ch) {
        const code = normalizeCloseCode(msg.code);
        ch.ws.close(code, sanitizeHeaderValue(msg.reason || '').slice(0, 120));
        this.#hub.stats.wsClosed += 1;
      }
      return;
    }

    if (t === MSG.WS_FLOW) {
      // 插件告诉我们它那边读不动了 → 暂停访客侧的输入流。
      const ch = this.#channels.get(Number(msg.id));
      if (ch) {
        if (msg.pause) ch.ws.pauseInput();
        else ch.ws.resumeInput();
      }
      return;
    }

    if (t === MSG.HTTP_RES) {
      const p = this.#pending.get(Number(msg.id));
      if (!p || p.done) return;
      p.headWritten = true;
      this.#writeResponseHead(p, msg);
      return;
    }

    if (t === MSG.HTTP_RES_END) {
      const p = this.#pending.get(Number(msg.id));
      if (!p || p.done) return;
      if (!p.headWritten) {
        // 某些合法响应确实没有 body（如 204/304），但至少要有响应头。
        this.#failHttp(p, 502, '插件端未返回响应头');
        return;
      }
      this.#finishHttp(p);
      return;
    }

    if (t === MSG.HTTP_RES_ERROR) {
      const p = this.#pending.get(Number(msg.id));
      if (!p || p.done) return;
      const status = Number.isInteger(msg.status) && msg.status >= 400 && msg.status <= 599 ? msg.status : 502;
      this.#failHttp(p, status, sanitizeHeaderValue(msg.message || '插件端返回错误'));
      return;
    }

    log.debug('收到未知控制消息', { deviceId: this.deviceId, t: String(t).slice(0, 32) });
  }

  /* ------------------------------------------------------ 中转 → 插件出口 */

  addVisitorChannel({ ws, ip, userAgent, path, host }) {
    const streamId = allocStreamId();
    const ch = new VisitorChannel({ streamId, ws, ip, userAgent, path, host, device: this.deviceId });
    this.#channels.set(streamId, ch);

    ws.on('message', (data, isBinary) => {
      if (ch.closed) return;
      if (!this.isOpen) {
        ws.close(CLOSE_CODE.TRY_AGAIN_LATER, '设备已离线');
        return;
      }
      ch.bytesToDevice += data.length;
      this.sendData(KIND.WS_DATA, streamId, data, isBinary);
    });
    ws.on('close', ({ code }) => {
      if (ch.closed) return;
      ch.closed = true;
      this.#channels.delete(streamId);
      this.#hub.stats.wsClosed += 1;
      if (this.isOpen) {
        this.sendControl({ t: MSG.WS_CLOSE, id: streamId, code: normalizeCloseCode(code) });
      }
    });
    ws.on('drain', () => {
      // 访客侧缓冲排空，通知插件继续推送。
      if (ch.paused) {
        ch.paused = false;
        this.sendControl({ t: MSG.WS_FLOW, id: streamId, pause: false });
      }
    });

    // 访客通道的 ping 由中转自己回 pong（websocket.js 已自动处理），
    // 但保活仍需一层超时判断：浏览器崩溃时不会发 close。
    ws.startHeartbeat(this.#hub.heartbeatMs, () => {
      log.debug('访客心跳超时', { deviceId: this.deviceId, streamId });
    });

    this.sendControl({
      t: MSG.WS_OPEN,
      id: streamId,
      ip,
      ua: String(userAgent || '').slice(0, 255),
      path,
      host,
    });
    this.#hub.stats.wsOpened += 1;
    return ch;
  }

  #takeChannel(idText) {
    const id = Number(idText);
    if (!Number.isInteger(id)) return null;
    const ch = this.#channels.get(id);
    if (!ch) return null;
    ch.closed = true;
    this.#channels.delete(id);
    return ch;
  }

  #requestFlow(streamId, kind, pause) {
    const key = `${kind}:${streamId}:${pause}`;
    if (this.#flowPending.has(key)) return;
    this.#flowPending.add(key);
    setTimeout(() => this.#flowPending.delete(key), 250);
    if (kind === 'ws' && pause) {
      const ch = this.#channels.get(streamId);
      if (ch && !ch.paused) {
        ch.paused = true;
        this.sendControl({ t: MSG.WS_FLOW, id: streamId, pause: true });
      }
    }
  }

  /* ---------------------------------------------------------- HTTP 转发 */

  beginHttp({ req, res, method, path, query, headers, ip }) {
    const streamId = allocStreamId();
    const timeoutMs = this.#hub.httpTimeoutMs;
    const timer = setTimeout(() => {
      const p = this.#pending.get(streamId);
      if (p) this.#failHttp(p, 504, '内网设备响应超时');
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const pending = new PendingHttp({ streamId, res, req, timer });
    this.#pending.set(streamId, pending);

    const ok = this.sendControl({
      t: MSG.HTTP_REQ,
      id: streamId,
      method,
      path,
      query,
      headers,
      ip,
      // 让插件端知道该用多长的超时，避免两侧超时时间倒挂导致「中转已经 504、
      // 插件还在跑」的浪费。
      timeoutMs,
    });
    if (!ok) {
      this.#failHttp(pending, 502, '设备隧道不可用');
      return null;
    }
    this.#hub.stats.httpStarted += 1;
    return pending;
  }

  pushHttpBody(pending, chunk) {
    if (pending.done || !this.isOpen) return false;
    pending.bytesIn += chunk.length;
    return this.sendData(KIND.HTTP_REQ_BODY, pending.streamId, chunk);
  }

  endHttpRequest(pending) {
    if (pending.done) return;
    this.sendControl({ t: MSG.HTTP_REQ_END, id: pending.streamId });
  }

  abortHttp(pending, reason) {
    if (!pending || pending.done) return;
    pending.done = true;
    if (pending.timer) clearTimeout(pending.timer);
    this.#pending.delete(pending.streamId);
    if (this.isOpen) this.sendControl({ t: MSG.HTTP_ABORT, id: pending.streamId, reason: String(reason || '').slice(0, 120) });
  }

  #writeResponseHead(p, msg) {
    const status = Number.isInteger(msg.status) && msg.status >= 100 && msg.status <= 599 ? msg.status : 502;
    const headers = {};
    const raw = msg.headers;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      let count = 0;
      for (const [name, value] of Object.entries(raw)) {
        if (count >= MAX_HEADER_COUNT) break;
        if (!isValidHeaderName(name)) continue;
        const lower = name.toLowerCase();
        if (isHopByHopHeader(lower)) continue;
        // set-cookie 可能多值，必须保留数组语义，否则多枚 cookie 会被合并成一条坏值。
        if (Array.isArray(value)) {
          headers[lower] = value.slice(0, 20).map((v) => sanitizeHeaderValue(v));
        } else {
          headers[lower] = sanitizeHeaderValue(value);
        }
        count += 1;
      }
    }
    if (!p.res.headersSent) {
      try {
        p.res.writeHead(status, headers);
      } catch (err) {
        this.#failHttp(p, 502, `响应头无效：${err.message}`);
        return;
      }
    }
    // 立即 flush 头部：SPA 的 index.html 要尽早到达浏览器，否则首屏白屏时间
    // 会被内网设备的上行速度拖长。
    p.res.flushHeaders?.();
  }

  #pauseHttp(p, pause) {
    if (p.done) return;
    if (pause && !p.paused) {
      p.paused = true;
      this.sendControl({ t: MSG.HTTP_FLOW, id: p.streamId, pause: true });
      if (!p.onDrain) {
        p.onDrain = () => {
          p.paused = false;
          if (!p.done && this.isOpen) this.sendControl({ t: MSG.HTTP_FLOW, id: p.streamId, pause: false });
        };
        p.res.once('drain', p.onDrain);
      }
    } else if (!pause && p.paused) {
      p.paused = false;
      this.sendControl({ t: MSG.HTTP_FLOW, id: p.streamId, pause: false });
    }
  }

  #finishHttp(p) {
    if (p.done) return;
    p.done = true;
    if (p.timer) clearTimeout(p.timer);
    this.#pending.delete(p.streamId);
    this.#hub.stats.httpFinished += 1;
    try {
      if (!p.res.writableEnded) p.res.end();
    } catch {
      /* 客户端可能已断开 */
    }
  }

  #failHttp(p, status, message) {
    if (p.done) return;
    p.done = true;
    if (p.timer) clearTimeout(p.timer);
    this.#pending.delete(p.streamId);
    this.#hub.stats.httpFailed += 1;
    try {
      if (!p.res.headersSent) {
        p.res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        p.res.end(`${message}\n`);
      } else if (!p.res.writableEnded) {
        // 头已经发出去了，无法再改状态码；只能截断连接让浏览器看到网络错误，
        // 这比悄悄返回半截 HTML 更好——后者会被当成正常页面渲染。
        p.res.destroy();
      }
    } catch {
      /* 忽略 */
    }
  }

  /** 设备连接断开：礼貌地关掉所有访客通道，并让挂起的 HTTP 请求快速失败。 */
  shutdown(reason) {
    for (const ch of this.#channels.values()) {
      ch.closed = true;
      try {
        ch.ws.close(CLOSE_CODE.TRY_AGAIN_LATER, '设备离线');
      } catch {
        /* 忽略 */
      }
    }
    this.#channels.clear();
    for (const p of this.#pending.values()) this.#failHttp(p, 502, `设备连接已断开（${reason}）`);
    this.#pending.clear();
  }

  stop() {
    this.markInterrupted('stopped');
    this.shutdown('shutdown');
    this.ws.stopHeartbeat();
    try {
      this.ws.close(CLOSE_CODE.GOING_AWAY, '服务端关闭');
    } catch {
      this.ws.terminate();
    }
  }
}

/* ------------------------------------------------------------------ Hub */

export class TunnelHub extends EventEmitter {
  #devices = new Map();
  #config;
  #auth;

  stats = {
    wsOpened: 0,
    wsClosed: 0,
    httpStarted: 0,
    httpFinished: 0,
    httpFailed: 0,
    deviceConnects: 0,
    deviceRejected: 0,
  };

  constructor({ config, auth }) {
    super();
    this.#config = config;
    this.#auth = auth;
    this.heartbeatMs = config.tunnel?.heartbeatMs ?? 30_000;
    this.httpTimeoutMs = config.tunnel?.httpTimeoutMs ?? 60_000;
    this.maxChannels = config.tunnel?.maxChannelsPerDevice ?? 32;
  }

  getDevice(deviceId) {
    return this.#devices.get(deviceId) || null;
  }

  isOnline(deviceId) {
    const d = this.#devices.get(deviceId);
    return Boolean(d && d.isOpen);
  }

  onlineDeviceIds() {
    return [...this.#devices.values()].filter((d) => d.isOpen).map((d) => d.deviceId);
  }

  /* ------------------------------------------------------------ 插件接入 */

  /**
   * 插件端连接 /tunnel。鉴权必须在响应 101 之前完成，失败直接回 HTTP 错误，
   * 这样插件端能拿到明确原因，而不是一个「握手成功后立刻被关」的谜题。
   */
  async acceptTunnel(req, socket, head, { deviceId, deviceSecret, ip }) {
    const verdict = await this.#auth.verifyDevice(deviceId, deviceSecret);
    if (!verdict.ok) {
      this.stats.deviceRejected += 1;
      rejectUpgrade(socket, 403, `设备鉴权失败：${verdict.reason}`);
      log.warn('设备隧道连接被拒绝', { deviceId: String(deviceId).slice(0, 40), reason: verdict.reason, ip });
      return null;
    }
    if (!this.#devicesAllowedFromIp(verdict.device, ip)) {
      this.stats.deviceRejected += 1;
      rejectUpgrade(socket, 403, '来源 IP 不在该账号的白名单内');
      log.warn('设备隧道连接被拒：IP 不在白名单', { deviceId, ip });
      return null;
    }

    socket.pause(); // 鉴权期间先别让数据流进来，握手完成后再恢复
    const ws = establishConnection(req, socket, head, {
      id: crypto.randomBytes(8).toString('hex'),
      maxMessageBytes: this.#config.tunnel?.maxMessageBytes ?? 16 * 1024 * 1024,
    });
    if (!ws) {
      this.stats.deviceRejected += 1;
      return null;
    }

    const existing = this.#devices.get(deviceId);
    if (existing) {
      // 同 deviceId 重连时踢掉旧连接：常见于插件进程重启而旧 TCP 还没超时，
      // 若保留旧连接，访客会被分到一条已经没人读的死管道上。
      log.info('同设备重连，关闭旧隧道', { deviceId, oldWs: existing.wsId });
      existing.markInterrupted('replaced');
      existing.shutdown('replaced');
      try {
        existing.ws.close(CLOSE_CODE.GOING_AWAY, '被新连接替换');
      } catch {
        existing.ws.terminate();
      }
    }

    const tunnel = new DeviceTunnel(this, verdict.device, ws);
    this.#devices.set(deviceId, tunnel);
    this.stats.deviceConnects += 1;

    tunnel.attach(this.heartbeatMs, 0);
    tunnel.on('down', (reason) => {
      if (this.#devices.get(deviceId) === tunnel) this.#devices.delete(deviceId);
      tunnel.shutdown(reason);
      this.emit('device-offline', { deviceId, reason });
    });

    this.#auth.store.markDeviceSeen(deviceId, ip).catch(() => {});
    socket.resume();
    log.info('设备已上线', { deviceId, ip, userId: verdict.device.userId });
    this.emit('device-online', { deviceId, name: verdict.device.name });
    return tunnel;
  }

  #devicesAllowedFromIp(device, ip) {
    // 复用账号级 IP 白名单：数据面比控制面更需要限制。
    return this.#auth.isDeviceAllowedFromIp(device, ip);
  }

  /* ------------------------------------------------------------ 访客接入 */

  /**
   * 访客 WebSocket 接入。返回 { ok, reason }；错误页由调用方负责渲染
   * （server.js 知道静态模块和请求上下文）。
   */
  async acceptVisitor(req, socket, head, { deviceId, ip }) {
    const tunnel = this.#devices.get(deviceId);
    if (!tunnel || !tunnel.isOpen) {
      return { ok: false, status: 503, code: 'EOFFLINE' };
    }
    if (tunnel.channelCount >= this.maxChannels) {
      return { ok: false, status: 503, code: 'EBUSY' };
    }
    socket.pause();
    const ws = establishConnection(req, socket, head, {
      id: crypto.randomBytes(8).toString('hex'),
      maxMessageBytes: this.#config.tunnel?.maxMessageBytes ?? 16 * 1024 * 1024,
    });
    if (!ws) return { ok: false, status: 400, code: 'EHANDSHAKE' };

    const url = new URL(req.url || '/', 'http://placeholder');
    const channel = tunnel.addVisitorChannel({
      ws,
      ip,
      userAgent: req.headers['user-agent'] || '',
      path: '/d/' + deviceId,
      host: req.headers.host || '',
    });
    ws.flushHandshakeLeftover();
    socket.resume();
    // 只保留必要的 query 上下文，原始 path 里可能带敏感参数，不落日志。
    log.info('访客 WS 已配对', { deviceId, ip, qs: url.search ? url.search.length : 0 });
    return { ok: true, ws, channel };
  }

  /* ---------------------------------------------------------- HTTP 转发 */

  async forwardHttp(req, res, { deviceId, ip, targetPath, query }) {
    const tunnel = this.#devices.get(deviceId);
    if (!tunnel || !tunnel.isOpen) {
      return { ok: false, code: 'EOFFLINE' };
    }

    // 收集请求头并过滤：hop-by-hop 与 host 必须换掉，否则内网 DSH 会收到
    // 公网域名而生成错误的重定向/绝对链接。
    const headers = {};
    let count = 0;
    for (const [name, value] of Object.entries(req.headers)) {
      if (count >= MAX_HEADER_COUNT) break;
      const lower = name.toLowerCase();
      if (isHopByHopHeader(lower)) continue;
      if (lower === 'host') continue;
      if (lower === 'cookie') {
        // cookie 里可能带中转自己的会话 token；转给内网 DSH 没有意义且扩大泄露面。
        // 注意取的是 config.auth.cookieName（不是 config.cookieName），层级错了
        // 就会静默剥不掉，等于把管理端会话 cookie 送给内网服务。
        headers[lower] = stripCookie(String(value), this.#config.auth?.cookieName);
        count += 1;
        continue;
      }
      headers[lower] = sanitizeHeaderValue(value);
      count += 1;
    }

    const pending = tunnel.beginHttp({
      req,
      res,
      method: req.method || 'GET',
      path: targetPath,
      query,
      headers,
      ip,
    });
    if (!pending) return { ok: false, code: 'ETUNNEL' };

    // 访客中断（刷新、关标签页）时立刻告诉插件端停止，否则内网会白跑一个
    // 完整请求，尤其是 SSE/流式接口会一直挂着。
    const onClose = () => tunnel.abortHttp(pending, 'client-aborted');
    res.on('close', onClose);

    try {
      for await (const chunk of req) {
        if (pending.done) break;
        const ok = tunnel.pushHttpBody(pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        if (!ok) await waitDrain(tunnel.ws);
      }
      tunnel.endHttpRequest(pending);
    } catch (err) {
      tunnel.abortHttp(pending, `body-read-error:${err.message}`);
      return { ok: false, code: 'EBODY' };
    }
    return { ok: true, pending };
  }

  /* -------------------------------------------------------------- 其他 */

  statsSnapshot() {
    let channels = 0;
    let httpPending = 0;
    for (const d of this.#devices.values()) {
      channels += d.channelCount;
      httpPending += d.httpPendingCount;
    }
    return {
      devices: this.#devices.size,
      channels,
      httpPending,
      ...this.stats,
    };
  }

  async closeAll() {
    const all = [...this.#devices.values()];
    this.#devices.clear();
    for (const d of all) {
      d.markInterrupted('shutdown');
      d.shutdown('server-shutdown');
      try {
        d.ws.close(CLOSE_CODE.GOING_AWAY, '服务端关闭');
      } catch {
        d.ws.terminate();
      }
    }
  }
}

/* --------------------------------------------------------------- 辅助函数 */

function normalizeCloseCode(code) {
  const n = Number(code);
  // 1005/1006/1015 是「本地状态码」，绝不能出现在线路上；其他越界值统一成 1000。
  if (!Number.isInteger(n)) return CLOSE_CODE.NORMAL;
  if (n === 1005 || n === 1006 || n === 1015) return CLOSE_CODE.NORMAL;
  if (n >= 1000 && n <= 1003) return n;
  if (n >= 1007 && n <= 1011) return n;
  if (n >= 3000 && n <= 4999) return n;
  return CLOSE_CODE.NORMAL;
}

function stripCookie(header, cookieName) {
  if (!header || !cookieName) return header;
  const kept = header
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith(`${cookieName}=`));
  return kept.join('; ');
}

function waitDrain(ws, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      ws.off('drain', done);
      resolve();
    };
    ws.once('drain', done);
    setTimeout(done, timeoutMs).unref?.();
  });
}
