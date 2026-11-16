// RFC 6455 的最小可用实现（服务端视角）：升级握手、帧编解码、连接生命周期。
//
// 为什么不用 npm 的 ws：这个服务要长期挂在公网上，依赖越少越好；而我们的需求
// 只覆盖「服务端接收掩码帧 + 发送非掩码帧 + 控制帧」，远没有到需要完整库的复杂度。
// 反过来，自己实现必须严格处理以下每一条，否则就是隐蔽的协议漏洞或内存炸弹：
//   1. 客户端帧必须带掩码（RFC 6455 §5.3），否则断开 1002；
//   2. 未协商扩展时 RSV1-3 必须为 0，否则断开 1002；
//   3. 控制帧必须 FIN=1 且 payload ≤ 125 字节，不得分片；
//   4. payload 长度有 7/16/64 位三种编码，64 位最高位必须为 0；
//   5. 文本帧与 close 原因必须是合法 UTF-8，否则断开 1007；
//   6. close 码必须在允许集合内，1005/1006/1015 不得出现在线路上；
//   7. 单条消息总长必须设上限，否则一个 64 位长度声明就能吃光内存；
//   8. 分片消息的续帧必须紧接在原帧之后，中间只允许插控制帧。
//
// 关于背压：socket.write 返回 false 不代表写入失败，而是内核缓冲区已满。中继场景下
// 一侧慢会导致另一侧数据在内存里堆积，因此这里暴露 bufferedAmount 和
// pauseInput/resumeInput，由 tunnel 层做真正的流量控制。

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { createLogger } from './util.js';

const log = createLogger('ws');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

export const CLOSE_CODE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  NO_STATUS: 1005,
  ABNORMAL: 1006,
  INVALID_PAYLOAD: 1007,
  POLICY_VIOLATION: 1008,
  TOO_BIG: 1009,
  MANDATORY_EXT: 1010,
  INTERNAL_ERROR: 1011,
  TRY_AGAIN_LATER: 1013,
  BAD_GATEWAY: 1014,
};

const CONNECTION_OPEN = 'open';
const CONNECTION_CLOSING = 'closing';
const CONNECTION_CLOSED = 'closed';

// close 码允许出现在线路上的区间（RFC 6455 §7.4 + IANA 注册）。
function isValidCloseCode(code) {
  if (code >= 1000 && code <= 1003) return true;
  if (code >= 1007 && code <= 1011) return true;
  if (code >= 3000 && code <= 4999) return true;
  return false;
}

/* --------------------------------------------------------------- 握手部分 */

/**
 * 校验升级请求。返回 { acceptKey, protocol } 或 { error: { status, message, headers } }。
 * 任何一项不满足都必须拒绝并给出可诊断的原因——这种失败往往是部署时 nginx
 * 少配了一条 Upgrade 头，错误信息越具体，排障越快。
 */
export function validateHandshake(req, options = {}) {
  if (req.method !== 'GET') {
    return { error: { status: 405, message: 'WebSocket 握手必须使用 GET' } };
  }
  const httpVersion = req.httpVersionMajor * 1000 + req.httpVersionMinor;
  if (httpVersion < 1001) {
    return { error: { status: 400, message: 'WebSocket 需要 HTTP/1.1' } };
  }
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (upgrade !== 'websocket') {
    return { error: { status: 400, message: '缺少或错误的 Upgrade 头（应为 websocket）' } };
  }
  const connection = String(req.headers.connection || '').toLowerCase();
  // Connection 是逗号分隔的 token 列表，nginx 常见把它写成 "keep-alive, Upgrade"。
  const tokens = connection.split(',').map((s) => s.trim());
  if (!tokens.includes('upgrade')) {
    return { error: { status: 400, message: 'Connection 头必须包含 Upgrade token' } };
  }
  const version = String(req.headers['sec-websocket-version'] || '').trim();
  if (version !== '13') {
    return {
      error: {
        status: 426,
        message: '仅支持 WebSocket 协议版本 13',
        // 按规范必须回这个头，客户端据此降级重试。
        headers: { 'sec-websocket-version': '13' },
      },
    };
  }
  const key = String(req.headers['sec-websocket-key'] || '').trim();
  if (!key) {
    return { error: { status: 400, message: '缺少 Sec-WebSocket-Key' } };
  }
  let rawKey;
  try {
    rawKey = Buffer.from(key, 'base64');
  } catch {
    rawKey = null;
  }
  if (!rawKey || rawKey.length !== 16) {
    return { error: { status: 400, message: 'Sec-WebSocket-Key 必须是 16 字节 base64' } };
  }

  let protocol = null;
  if (options.protocol) {
    // 只有当客户端确实提供了子协议时才回填；乱回一个未在列表里的协议是协议违规。
    const offered = String(req.headers['sec-websocket-protocol'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (offered.includes(options.protocol)) protocol = options.protocol;
  }

  return { acceptKey: computeAcceptKey(key), protocol };
}

export function computeAcceptKey(key) {
  // 规范要求的算法，不可替换：sha1(客户端 key 字符串 + GUID) 的 base64。
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

/**
 * 在 http server 的 'upgrade' 事件里拒绝一次连接。
 * 注意此时不能用 res 对象（它已随 upgrade 事件被解绑），必须直接写裸 socket。
 */
export function rejectUpgrade(socket, status, message, extraHeaders = {}) {
  if (!socket || socket.destroyed) return;
  const body = Buffer.from(`${message}\n`, 'utf8');
  const reason = STATUS_TEXT[status] || 'Error';
  const headers = [
    `HTTP/1.1 ${status} ${reason}`,
    'connection: close',
    'content-type: text/plain; charset=utf-8',
    `content-length: ${body.length}`,
    'cache-control: no-store',
    ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
  ];
  try {
    socket.write(`${headers.join('\r\n')}\r\n\r\n`);
    socket.write(body);
  } catch {
    /* 对端已断，忽略 */
  }
  socket.end();
  // end() 之后仍可能因为对端不读而挂住，给一个短超时兜底销毁。
  setTimeout(() => socket.destroy(), 2000).unref?.();
}

const STATUS_TEXT = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  426: 'Upgrade Required',
  429: 'Too Many Requests',
  503: 'Service Unavailable',
};

/* --------------------------------------------------------------- 连接类 */

export class WebSocketConnection extends EventEmitter {
  #socket;
  #state = CONNECTION_OPEN;
  #buf = Buffer.alloc(0);
  #payloadChunks = [];
  #payloadReceived = 0;
  #frame = null; // 正在读取的帧头信息
  #messageOpcode = null; // 分片消息的原始 opcode
  #messageChunks = [];
  #messageLength = 0;
  #closeSent = false;
  #closeReceived = false;
  #closeCode = CLOSE_CODE.NO_STATUS;
  #closeReason = '';
  #closeTimer = null;
  #pingTimer = null;
  #maxMessageBytes;
  #maxBufferBytes;
  #id;
  #closedEmitted = false;
  #remoteAddress;

  constructor(socket, options = {}) {
    super();
    this.#socket = socket;
    this.#id = options.id || crypto.randomBytes(6).toString('hex');
    // 单条消息上限。默认 16 MiB：足够传 DSH 的静态资源和较大的 API 响应，
    // 又不至于让一条恶意帧把进程打爆。
    this.#maxMessageBytes = options.maxMessageBytes ?? 16 * 1024 * 1024;
    // 未完成帧的缓冲上限，超出视为对端在灌垃圾。
    this.#maxBufferBytes = options.maxBufferBytes ?? this.#maxMessageBytes * 2 + 1024;
    this.#remoteAddress = socket.remoteAddress || '';

    socket.setNoDelay?.(true);
    socket.setTimeout?.(0); // 超时统一由心跳逻辑管理，避免半开连接被 TCP 层误杀
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (err) => {
      this.emit('error', err);
      this.#finalize(CLOSE_CODE.ABNORMAL, '');
    });
    socket.on('end', () => {
      // 对端发了 FIN 却没走 close 握手：按规范这是异常关闭。
      this.#finalize(this.#closeReceived ? this.#closeCode : CLOSE_CODE.ABNORMAL, this.#closeReason);
    });
    socket.on('close', () => {
      this.#finalize(this.#closeReceived ? this.#closeCode : CLOSE_CODE.ABNORMAL, this.#closeReason);
    });
    socket.on('drain', () => {
      this.emit('drain');
    });
  }

  get id() {
    return this.#id;
  }

  get remoteAddress() {
    return this.#remoteAddress;
  }

  get readyState() {
    return this.#state;
  }

  get isOpen() {
    return this.#state === CONNECTION_OPEN;
  }

  /**
   * 待发送字节数。直接用 socket.writableLength 而不是自己累加：
   * 自己记的计数无法在部分写出时准确衰减，会永久性虚高，最后把流量控制卡死。
   */
  get bufferedAmount() {
    return this.#socket.writableLength || 0;
  }

  /** 由 http 层把 upgrade 事件里附带的 head（握手后立即到达的数据）喂进来。 */
  feedHandshakeLeftover(head) {
    if (head && head.length > 0) this.#onData(head);
  }

  /** 监听器就绪后调用：把握手残留数据补进解析器。只能调一次。 */
  flushHandshakeLeftover() {
    const leftover = this.pendingLeftover;
    this.pendingLeftover = null;
    if (leftover && leftover.length > 0) this.feedHandshakeLeftover(leftover);
  }

  /* ------------------------------------------------------------ 发送路径 */

  send(data, options = {}) {
    if (this.#state !== CONNECTION_OPEN) return false;
    const binary = options.binary === true;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    if (buf.length > this.#maxMessageBytes) {
      this.emit('error', new Error('发送数据超过单条消息上限'));
      this.close(CLOSE_CODE.TOO_BIG, 'message too large');
      return false;
    }
    return this.#writeFrame(binary ? OPCODE.BINARY : OPCODE.TEXT, buf, true);
  }

  sendText(text) {
    return this.send(text, { binary: false });
  }

  sendBinary(buf) {
    return this.send(buf, { binary: true });
  }

  ping(payload) {
    if (this.#state !== CONNECTION_OPEN) return false;
    const p = payload ? Buffer.from(payload) : Buffer.alloc(0);
    if (p.length > 125) throw new Error('ping payload 不能超过 125 字节');
    return this.#writeFrame(OPCODE.PING, p, true);
  }

  pong(payload) {
    if (this.#state !== CONNECTION_OPEN) return false;
    const p = payload ? Buffer.from(payload) : Buffer.alloc(0);
    if (p.length > 125) throw new Error('pong payload 不能超过 125 字节');
    return this.#writeFrame(OPCODE.PONG, p, true);
  }

  /**
   * 服务端发起的关闭。会先发 close 帧，等对端回 close 或超时后销毁 socket。
   * 超时是必须的：恶意对端可以永不回 close，让连接永远停在 CLOSING。
   */
  close(code = CLOSE_CODE.NORMAL, reason = '', timeoutMs = 5000) {
    if (this.#state === CONNECTION_CLOSED) return;
    if (this.#state === CONNECTION_OPEN) {
      this.#sendClose(code, reason);
    }
    this.#state = CONNECTION_CLOSING;
    if (!this.#closeTimer) {
      this.#closeTimer = setTimeout(() => {
        this.#closeTimer = null;
        this.#destroySocket();
      }, timeoutMs);
      this.#closeTimer.unref?.();
    }
  }

  /** 立即销毁，不发 close 帧（用于心跳超时、策略拒绝等不给对端礼貌机会的场景）。 */
  terminate(code = CLOSE_CODE.ABNORMAL, reason = '') {
    this.#finalize(code, reason);
    this.#destroySocket();
  }

  pauseInput() {
    this.#socket.pause?.();
  }

  resumeInput() {
    this.#socket.resume?.();
  }

  /** 心跳探测：见 tunnel 层对 lastSeen 的判定。 */
  startHeartbeat(intervalMs, onTimeout) {
    this.stopHeartbeat();
    let awaitingPong = false;
    this.#pongHandler = () => {
      awaitingPong = false;
      this.#lastPongAt = Date.now();
    };
    this.on('pong', this.#pongHandler);
    this.#pingTimer = setInterval(() => {
      if (this.#state !== CONNECTION_OPEN) return;
      if (awaitingPong) {
        // 上一轮 ping 都没有回音，说明对端已经死了（常见于 NAT 超时/机器断电），
        // 直接销毁，等 TCP 自己发现可能要几十分钟。
        onTimeout?.(this);
        this.terminate(CLOSE_CODE.ABNORMAL, 'heartbeat timeout');
        return;
      }
      awaitingPong = true;
      this.#lastPingAt = Date.now();
      try {
        this.ping(Buffer.from([0x68])); // 'h'，载荷内容无意义，只为触发对端回 pong
      } catch {
        this.terminate(CLOSE_CODE.INTERNAL_ERROR, 'ping failed');
      }
    }, intervalMs);
    this.#pingTimer.unref?.();
  }

  #pongHandler = null;
  #lastPingAt = 0;
  #lastPongAt = 0;

  get lastSeenAt() {
    return Math.max(this.#lastPingAt, this.#lastPongAt, this.#lastActivityAt);
  }

  #lastActivityAt = Date.now();

  stopHeartbeat() {
    if (this.#pingTimer) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
    if (this.#pongHandler) {
      this.off('pong', this.#pongHandler);
      this.#pongHandler = null;
    }
  }

  /* ----------------------------------------------------------- 帧编码 */

  #writeFrame(opcode, payload, fin) {
    const len = payload.length;
    let headerLen = 2;
    if (len >= 126 && len <= 0xffff) headerLen += 2;
    else if (len > 0xffff) headerLen += 8;
    const frame = Buffer.allocUnsafe(headerLen + len);
    frame[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
    // 服务端发出的帧一律不掩码（RFC 6455 §5.1：只有客户端到服务端才需要掩码）。
    if (len < 126) {
      frame[1] = len;
    } else if (len <= 0xffff) {
      frame[1] = 126;
      frame.writeUInt16BE(len, 2);
    } else {
      frame[1] = 127;
      // 用 BigInt 写 64 位，避免超过 2^32 时静默截断。
      frame.writeBigUInt64BE(BigInt(len), 2);
    }
    payload.copy(frame, headerLen);
    return this.#write(frame);
  }

  #write(buf) {
    if (this.#socket.destroyed || !this.#socket.writable) return false;
    try {
      return this.#socket.write(buf);
    } catch (err) {
      this.emit('error', err);
      this.#destroySocket();
      return false;
    }
  }

  #sendClose(code, reason) {
    if (this.#closeSent) return;
    this.#closeSent = true;
    const reasonBuf = Buffer.from(String(reason || ''), 'utf8').subarray(0, 123); // 控制帧上限 125 - 2
    let payload;
    if (code === CLOSE_CODE.NO_STATUS) {
      payload = Buffer.alloc(0); // 无状态码的 close 是合法的
    } else {
      payload = Buffer.allocUnsafe(2 + reasonBuf.length);
      payload.writeUInt16BE(code, 0);
      reasonBuf.copy(payload, 2);
    }
    this.#writeFrame(OPCODE.CLOSE, payload, true);
  }

  /* ----------------------------------------------------------- 帧解码 */

  #onData(chunk) {
    if (this.#state === CONNECTION_CLOSED) return;
    this.#lastActivityAt = Date.now();
    // 合并时只可能残留半个帧头（payload 会被立即搬进 #payloadChunks），
    // 因此这里的拷贝量与帧体大小无关，不会退化成 O(n²)。
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    if (this.#buf.length > this.#maxBufferBytes) {
      this.close(CLOSE_CODE.TOO_BIG, 'buffer overflow');
      return;
    }
    try {
      this.#pump();
    } catch (err) {
      this.emit('error', err);
      this.close(CLOSE_CODE.INTERNAL_ERROR, 'internal parse error');
    }
  }

  #pump() {
    // 一次 data 事件里可能挤了多帧，循环直到数据不足。
    for (;;) {
      if (this.#state === CONNECTION_CLOSED) return;

      if (!this.#frame) {
        if (!this.#parseHeader()) return;
      }

      const frame = this.#frame;
      const remain = frame.length - this.#payloadReceived;
      if (remain > 0) {
        if (this.#buf.length === 0) return;
        const take = Math.min(remain, this.#buf.length);
        // 先切片再异或：只改动本帧的 payload，不碰后面的帧。
        const part = Buffer.from(this.#buf.subarray(0, take));
        if (frame.masked) unmask(part, frame.maskKey, this.#payloadReceived);
        this.#payloadChunks.push(part);
        this.#payloadReceived += take;
        this.#buf = take === this.#buf.length ? Buffer.alloc(0) : this.#buf.subarray(take);
        if (this.#payloadReceived < frame.length) return;
      }

      // 到这里一帧完整了。
      const payload = this.#payloadChunks.length === 1 ? this.#payloadChunks[0] : Buffer.concat(this.#payloadChunks, frame.length);
      this.#payloadChunks = [];
      this.#payloadReceived = 0;
      this.#frame = null;
      if (this.#handleFrame(frame, payload) === false) return;
    }
  }

  /** 解析帧头；数据不足时返回 false 并保留 #buf 以便下次继续。 */
  #parseHeader() {
    if (this.#buf.length < 2) return false;
    const b0 = this.#buf[0];
    const b1 = this.#buf[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let offset = 2;

    if (rsv !== 0) {
      // 我们没有协商任何扩展，任何 RSV 位都意味着对端在说我们没实现的协议。
      this.close(CLOSE_CODE.PROTOCOL_ERROR, 'reserved bits set');
      return false;
    }
    if (!masked) {
      // 客户端必须掩码，这既是规范要求，也是防止恶意客户端用未掩码帧
      // 攻击中间缓存（历史上真实出现过这类缓存投毒）。
      this.close(CLOSE_CODE.PROTOCOL_ERROR, 'client frames must be masked');
      return false;
    }

    if (length === 126) {
      if (this.#buf.length < offset + 2) return false;
      length = this.#buf.readUInt16BE(offset);
      offset += 2;
      // 非最短编码属于协议违规（存在多种表示同一长度的情况，会让审计变难）。
      if (length < 126) {
        this.close(CLOSE_CODE.PROTOCOL_ERROR, 'non-minimal length encoding');
        return false;
      }
    } else if (length === 127) {
      if (this.#buf.length < offset + 8) return false;
      const big = this.#buf.readBigUInt64BE(offset);
      offset += 8;
      if (big > BigInt(Number.MAX_SAFE_INTEGER) || (big >> 63n) === 1n) {
        // 最高位必须为 0，且大小必须落在 JS 安全整数范围内。
        this.close(CLOSE_CODE.PROTOCOL_ERROR, 'invalid 64-bit length');
        return false;
      }
      length = Number(big);
      if (length <= 0xffff) {
        this.close(CLOSE_CODE.PROTOCOL_ERROR, 'non-minimal length encoding');
        return false;
      }
    }

    if (this.#buf.length < offset + 4) return false;
    const maskKey = this.#buf.subarray(offset, offset + 4);
    offset += 4;

    const isControl = (opcode & 0x08) !== 0;
    if (isControl) {
      if (!fin) {
        this.close(CLOSE_CODE.PROTOCOL_ERROR, 'control frame must not be fragmented');
        return false;
      }
      if (length > 125) {
        this.close(CLOSE_CODE.PROTOCOL_ERROR, 'control frame too large');
        return false;
      }
    } else {
      if (opcode !== OPCODE.CONTINUATION && opcode !== OPCODE.TEXT && opcode !== OPCODE.BINARY) {
        this.close(CLOSE_CODE.PROTOCOL_ERROR, `unknown opcode ${opcode}`);
        return false;
      }
      if (opcode === OPCODE.CONTINUATION && this.#messageOpcode === null) {
        this.close(CLOSE_CODE.PROTOCOL_ERROR, 'continuation without start');
        return false;
      }
      if (opcode !== OPCODE.CONTINUATION && this.#messageOpcode !== null) {
        this.close(CLOSE_CODE.PROTOCOL_ERROR, 'new data frame during fragmented message');
        return false;
      }
      const total = (opcode === OPCODE.CONTINUATION ? this.#messageLength : 0) + length;
      if (total > this.#maxMessageBytes) {
        this.close(CLOSE_CODE.TOO_BIG, 'message too large');
        return false;
      }
    }

    // maskKey 指向 #buf 内部；必须在消费 #buf 之前复制出来，否则后续 subarray
    // 会让它悬空（虽然 #buf 被替换时旧内存仍被引用，但语义上不可依赖）。
    this.#frame = {
      fin,
      opcode,
      masked,
      maskKey: Buffer.from(maskKey),
      length,
    };
    this.#buf = offset === this.#buf.length ? Buffer.alloc(0) : this.#buf.subarray(offset);
    return true;
  }

  /** 处理完整帧。返回 false 表示停止解析（连接已进入关闭流程）。 */
  #handleFrame(frame, payload) {
    const { opcode } = frame;

    if (opcode === OPCODE.CLOSE) {
      this.#handleClose(payload);
      return false;
    }
    if (opcode === OPCODE.PING) {
      // 规范要求：收到 ping 必须尽快回 pong，且带同样的载荷。
      // 自动回复放在这里而不是交给上层，是为了让上层代码不必关心保活。
      if (this.#state === CONNECTION_OPEN) this.pong(payload);
      this.emit('ping', payload);
      return true;
    }
    if (opcode === OPCODE.PONG) {
      this.emit('pong', payload);
      return true;
    }

    // 数据帧：处理分片与消息边界
    if (opcode === OPCODE.TEXT || opcode === OPCODE.BINARY) {
      this.#messageOpcode = opcode;
      this.#messageChunks = [];
      this.#messageLength = 0;
    }
    this.#messageChunks.push(payload);
    this.#messageLength += payload.length;
    if (!frame.fin) return true;

    const full = this.#messageChunks.length === 1 ? this.#messageChunks[0] : Buffer.concat(this.#messageChunks, this.#messageLength);
    const isBinary = this.#messageOpcode === OPCODE.BINARY;
    this.#messageOpcode = null;
    this.#messageChunks = [];
    this.#messageLength = 0;

    if (!isBinary && !isUtf8(full)) {
      // 文本帧必须合法 UTF-8；不做 replacement 而是直接断开，否则上层拿到的
      // 是「看起来正常」的乱码，会让插件端难以定位问题。
      this.close(CLOSE_CODE.INVALID_PAYLOAD, 'invalid utf-8');
      return false;
    }

    try {
      this.emit('message', full, isBinary);
    } catch (err) {
      this.emit('error', err);
    }
    return true;
  }

  #handleClose(payload) {
    this.#closeReceived = true;
    if (payload.length === 1) {
      this.close(CLOSE_CODE.PROTOCOL_ERROR, 'invalid close payload length');
      return;
    }
    let code = CLOSE_CODE.NO_STATUS;
    let reason = '';
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      if (!isValidCloseCode(code)) {
        this.close(CLOSE_CODE.PROTOCOL_ERROR, 'invalid close code');
        return;
      }
      const reasonBuf = payload.subarray(2);
      if (reasonBuf.length > 0) {
        if (!isUtf8(reasonBuf)) {
          this.close(CLOSE_CODE.INVALID_PAYLOAD, 'invalid close reason');
          return;
        }
        reason = reasonBuf.toString('utf8');
      }
    }
    this.#closeCode = code;
    this.#closeReason = reason;
    // 回一个 close 完成握手；对端先发起时，回帧的码通常原样带回。
    if (!this.#closeSent) {
      this.#sendClose(code === CLOSE_CODE.NO_STATUS ? CLOSE_CODE.NORMAL : code, '');
    }
    this.#state = CONNECTION_CLOSING;
    this.#finalize(code, reason);
    // 给回帧一点时间冲出内核缓冲区再销毁。
    setImmediate(() => this.#destroySocket());
  }

  #destroySocket() {
    this.stopHeartbeat();
    if (this.#closeTimer) {
      clearTimeout(this.#closeTimer);
      this.#closeTimer = null;
    }
    const socket = this.#socket;
    if (!socket.destroyed) {
      try {
        socket.end();
      } catch {
        /* 忽略 */
      }
      // end() 只是半关闭；对端不配合时必须在短时间内硬关，否则 fd 泄漏。
      setTimeout(() => socket.destroy(), 1000).unref?.();
    }
  }

  #finalize(code, reason) {
    if (this.#closedEmitted) return;
    this.#closedEmitted = true;
    this.#state = CONNECTION_CLOSED;
    this.stopHeartbeat();
    if (this.#closeTimer) {
      clearTimeout(this.#closeTimer);
      this.#closeTimer = null;
    }
    this.emit('close', { code, reason, wasClean: this.#closeReceived && this.#closeSent });
    this.removeAllListeners('message');
    this.removeAllListeners('ping');
    this.removeAllListeners('pong');
  }
}

/** 就地解掩码。offset 是本段在整帧 payload 中的起始位置，保证跨段时掩码对齐。 */
function unmask(buf, maskKey, offset) {
  const len = buf.length;
  const o = offset & 3;
  for (let i = 0; i < len; i++) {
    buf[i] ^= maskKey[(o + i) & 3];
  }
}

/* ------------------------------------------------------------- 服务端工具 */

/**
 * 完成握手并建立连接对象。调用方负责在此之前完成鉴权（因为鉴权失败要回 401/403）。
 * 顺序很重要：先鉴权再发 101，否则浏览器会先看到 successful handshake 再被踢掉，
 * 前端只能显示「连接已断开」，无法给出「设备密钥错误」这类可操作提示。
 * 握手失败时返回 null（响应已经写回），调用方无需再处理。
 */
export function establishConnection(req, socket, head, options = {}) {
  const check = validateHandshake(req, options);
  if (check.error) {
    rejectUpgrade(socket, check.error.status, check.error.message, check.error.headers);
    return null;
  }
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${check.acceptKey}`,
  ];
  if (check.protocol) lines.push(`Sec-WebSocket-Protocol: ${check.protocol}`);
  // nginx 默认会缓冲响应；这里明确告诉它这是长连接，别等着凑够 buffer 再发。
  lines.push('X-Accel-Buffering: no');

  try {
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  } catch (err) {
    socket.destroy();
    log.debug('握手响应写入失败', { error: err.message });
    return null;
  }

  const conn = new WebSocketConnection(socket, options);
  // head 是握手包之后紧跟的数据（客户端常把首帧和握手写在同一个 TCP 段里）。
  // 这里只挂起、不立即解析：调用方此时还没绑定 'message' 监听器，立刻解析会把
  // 客户端的首帧 emit 到空气里。调用方绑定完监听器后必须调 flushHandshakeLeftover()。
  conn.pendingLeftover = head && head.length > 0 ? Buffer.from(head) : null;
  log.debug('WebSocket 已建立', {
    id: conn.id,
    ip: conn.remoteAddress,
    path: String(req.url || '').split('?')[0],
  });
  return conn;
}
