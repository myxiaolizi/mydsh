// 公共工具层：日志、HTTP 响应封装、输入校验、原子写、IP/代理解析、header 消毒。
//
// 这里刻意不收第三方依赖。中转服务直接面向公网，依赖树越短，可被供应链攻击和
// CVE 波及的概率越低；同时纯内置模块也让「拷到宝塔服务器上 node src/server.js」
// 这种最朴素的部署方式成立。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';

/* ------------------------------------------------------------------ 日志 */

const LEVEL_VALUE = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
let currentLevel = LEVEL_VALUE.info;

export function setLogLevel(name) {
  const v = LEVEL_VALUE[String(name || '').toLowerCase()];
  if (v !== undefined) currentLevel = v;
}

// 只对「看起来像凭据」的字段做遮蔽：日志里出现 token/secret 是最常见的泄露途径，
// 而这里的遮蔽是最后一道保险，真正的防线是不把凭据写进日志。
const SENSITIVE_KEY = /(secret|token|password|passwd|cookie|authorization|accesskey|apikey|hash)/i;

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > 300 ? `${value.slice(0, 120)}…(${value.length}B)` : value;
  }
  if (typeof value !== 'object') return value;
  if (depth >= 3) return '…';
  if (Array.isArray(value)) {
    const head = value.slice(0, 12).map((v) => redact(v, depth + 1));
    if (value.length > 12) head.push(`…+${value.length - 12}`);
    return head;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function emit(level, scope, message, fields) {
  if (LEVEL_VALUE[level] < currentLevel) return;
  const ts = new Date().toISOString();
  let line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  if (fields !== undefined) {
    let tail;
    try {
      tail = JSON.stringify(redact(fields));
    } catch {
      tail = '"[unserializable]"';
    }
    line += ` ${tail}`;
  }
  // 用一行一条的纯文本而不是 JSON：宝塔的日志面板、journalctl、grep 都直接可读。
  process.stdout.write(`${line}\n`);
}

export function createLogger(scope) {
  return {
    debug: (m, f) => emit('debug', scope, m, f),
    info: (m, f) => emit('info', scope, m, f),
    warn: (m, f) => emit('warn', scope, m, f),
    error: (m, f) => emit('error', scope, m, f),
    child: (sub) => createLogger(`${scope}/${sub}`),
  };
}

/* -------------------------------------------------------------- 通用小工具 */

export const nowMs = () => Date.now();
export const nowSec = () => Math.floor(Date.now() / 1000);

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function randomId(prefix = '') {
  return prefix + crypto.randomBytes(12).toString('base64url');
}

export function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

// 定长比较，避免通过响应时间逐字节爆破 secret。
export function safeEqual(a, b) {
  const ba = Buffer.isBuffer(a) ? a : Buffer.from(String(a), 'utf8');
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/* ------------------------------------------------------------------- 校验 */

// 用户名限制成 DNS 安全字符集：它以后会出现在 URL、日志、文件名里，
// 提前收窄字符集比事后到处转义便宜得多。
export const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,32}$/;

export function validateUsername(username) {
  if (typeof username !== 'string') return '用户名必须是字符串';
  if (!USERNAME_RE.test(username)) return '用户名只能包含字母、数字、下划线、连字符，长度 3-32';
  return null;
}

export function validatePassword(password) {
  if (typeof password !== 'string') return '密码必须是字符串';
  if (password.length < PASSWORD_MIN) return `密码至少 ${PASSWORD_MIN} 位`;
  if (password.length > PASSWORD_MAX) return `密码最多 ${PASSWORD_MAX} 位`;
  // 不强制复杂度上限，但拒绝「aaaaaaaaaa」这类明显垃圾口令；
  // 真正的强度靠长度和后续的限流，而不是把用户逼去写 Password1!。
  if (new Set(password).size < 4) return '密码过于简单（有效字符种类太少）';
  return null;
}

export function validateDeviceName(name) {
  if (name === undefined || name === null || name === '') return null;
  if (typeof name !== 'string') return '设备名必须是字符串';
  if (name.length > 48) return '设备名最长 48 个字符';
  if (/[\u0000-\u001f\u007f]/.test(name)) return '设备名包含不可见控制字符';
  return null;
}

export function validateIpAllowlist(list) {
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list)) return 'IP 白名单必须是数组';
  if (list.length > 64) return 'IP 白名单最多 64 条';
  for (const entry of list) {
    if (typeof entry !== 'string' || entry.length > 64) return 'IP 白名单条目必须是短字符串';
    const normalized = normalizeIpRule(entry);
    if (normalized === null) return `无法识别的 IP 或 CIDR：${entry}`;
  }
  return null;
}

export function normalizeIpRule(entry) {
  const s = String(entry).trim();
  if (!s) return null;
  const slash = s.indexOf('/');
  if (slash === -1) {
    return net.isIP(s) ? s : null;
  }
  const addr = s.slice(0, slash);
  const prefix = Number(s.slice(slash + 1));
  const fam = net.isIP(addr);
  if (fam === 4 && Number.isInteger(prefix) && prefix >= 0 && prefix <= 32) return `${addr}/${prefix}`;
  if (fam === 6 && Number.isInteger(prefix) && prefix >= 0 && prefix <= 128) return `${addr}/${prefix}`;
  return null;
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function expandIpv6(ip) {
  // 只做「够用」的展开：处理 :: 缩写与内嵌 IPv4，用于前缀比较。
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (s.includes('.')) {
    const idx = s.lastIndexOf(':');
    const v4 = s.slice(idx + 1);
    const n = ipv4ToInt(v4);
    if (n === null) return null;
    s = `${s.slice(0, idx + 1)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const fill = 8 - headParts.length - tailParts.length;
  if (fill < 0) return null;
  const groups = [...headParts, ...Array(tail === null ? 0 : fill).fill('0'), ...tailParts];
  if (groups.length !== 8) return null;
  const words = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    words.push(parseInt(g, 16));
  }
  return words;
}

function ipv6PrefixMatch(ip, base, prefix) {
  const a = expandIpv6(ip);
  const b = expandIpv6(base);
  if (!a || !b) return false;
  let bits = prefix;
  for (let i = 0; i < 8 && bits > 0; i++) {
    const take = Math.min(16, bits);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if ((a[i] & mask) !== (b[i] & mask)) return false;
    bits -= take;
  }
  return true;
}

export function ipMatchesRule(ip, rule) {
  if (!ip || !rule) return false;
  const normalized = normalizeIpRule(rule);
  if (!normalized) return false;
  if (!normalized.includes('/')) return normalized === ip;
  const [base, prefixStr] = normalized.split('/');
  const prefix = Number(prefixStr);
  if (net.isIP(ip) === 4 && net.isIP(base) === 4) {
    const ipInt = ipv4ToInt(ip);
    const baseInt = ipv4ToInt(base);
    if (ipInt === null || baseInt === null) return false;
    if (prefix === 0) return true;
    const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
    return (ipInt & mask) >>> 0 === (baseInt & mask) >>> 0;
  }
  if (net.isIP(ip) === 6 && net.isIP(base) === 6) return ipv6PrefixMatch(ip, base, prefix);
  return false;
}

export function checkIpAllowlist(ip, allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return true; // 空 = 不限制
  return allowlist.some((rule) => ipMatchesRule(ip, rule));
}

/* --------------------------------------------------------------- HTTP 工具 */

export function jsonResponse(res, status, body, extraHeaders = {}) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(payload);
}

export function textResponse(res, status, text, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const payload = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(payload);
}

export function htmlResponse(res, status, html, extraHeaders = {}) {
  textResponse(res, status, html, 'text/html; charset=utf-8', extraHeaders);
}

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || `E${status}`;
  }
}

/**
 * 读取并限制请求体大小。先看 content-length 快速拒绝，再在流式读取中二次校验：
 * 攻击者可以不发 content-length 而用 chunked 无限灌数据，只信 header 会被打穿。
 */
export async function readBody(req, maxBytes) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, '请求体过大');
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new HttpError(413, '请求体过大');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

export async function readJsonBody(req, maxBytes) {
  const raw = await readBody(req, maxBytes);
  if (raw.length === 0) return {};
  const type = String(req.headers['content-type'] || '');
  if (type && !/^application\/json\b/i.test(type)) {
    throw new HttpError(415, 'Content-Type 必须是 application/json');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON 格式错误');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'JSON 顶层必须是对象');
  }
  return parsed;
}

export function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string' || header.length === 0) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    let value = part.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.trunc(opts.maxAge)}`);
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

/* ------------------------------------------------------------ header 消毒 */

const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function isValidHeaderName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 64 && TOKEN_RE.test(name);
}

// 从插件端回传的 header 一律视为不可信：CR/LF 会变成响应拆分（header 注入），
// 因此这里按 RFC 7230 的 field-value 规则剔除控制字符。
export function sanitizeHeaderValue(value) {
  if (value === undefined || value === null) return '';
  const raw = Array.isArray(value) ? value.join(', ') : String(value);
  return raw.replace(/[\r\n\u0000]/g, '').replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 8192);
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // content-length 必须丢弃：响应体是被分块流式转发的，保留原始长度会在中途
  // 出错时让浏览器卡在等剩余字节的状态。交给 Node 用 chunked 重新封装。
  'content-length',
]);

export function isHopByHopHeader(name) {
  return HOP_BY_HOP.has(String(name).toLowerCase());
}

/* ------------------------------------------------------------- 地址与来源 */

export function clientIp(req, trustProxyHeaders) {
  if (trustProxyHeaders) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      for (const candidate of xff.split(',')) {
        const ip = candidate.trim();
        if (net.isIP(ip)) return ip;
      }
    }
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && net.isIP(real.trim())) return real.trim();
  }
  const addr = req.socket?.remoteAddress || '';
  return addr.startsWith('::ffff:') && net.isIP(addr.slice(7)) === 4 ? addr.slice(7) : addr;
}

/**
 * 防 CSRF 的第二道锁（第一道是 SameSite=Lax + Bearer 优先）：
 * 校验 Origin/Referer 与本站同源。nginx 反代后 host 可能变化，因此同时接受
 * 配置里的公开域名与请求自身的 Host。
 */
export function isSameOrigin(req, publicOrigin) {
  const origin = req.headers.origin;
  if (!origin) {
    const referer = req.headers.referer;
    if (!referer) return true; // 非浏览器客户端（curl/服务端调用）不适用 CSRF
    try {
      const u = new URL(referer);
      return originMatchesHost(u.origin, req, publicOrigin);
    } catch {
      return false;
    }
  }
  return originMatchesHost(origin, req, publicOrigin);
}

function originMatchesHost(origin, req, publicOrigin) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.origin === 'null') return false;
  if (publicOrigin) {
    try {
      if (new URL(publicOrigin).origin === parsed.origin) return true;
    } catch {
      /* 配置写错时忽略这一路，退回 Host 比较 */
    }
  }
  const host = String(req.headers.host || '');
  return parsed.host === host;
}

/* ------------------------------------------------------------------ 原子写 */

/**
 * 原子写：同目录临时文件 + fsync + rename。
 * 直接覆盖写有两个致命场景：进程被 kill 时留下半截 JSON（下次启动整库读不出来），
 * 以及两个请求并发写互相截断。rename 在同一文件系统内是原子的。
 */
export async function atomicWriteFile(file, data, mode = 0o600) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fs.open(tmp, 'w', mode);
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  try {
    await fs.rename(tmp, file);
    await fs.chmod(file, mode).catch(() => {});
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function readJsonFile(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

/* -------------------------------------------------------------- 文本转义 */

const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]);
}

/* ---------------------------------------------------------------- 地址拼接 */

export function publicOrigin(config) {
  if (config.publicUrl) {
    try {
      return new URL(config.publicUrl).origin;
    } catch {
      /* 落到下面的推导 */
    }
  }
  const scheme = config.tls?.enabled ? 'https' : 'http';
  return `${scheme}://${config.domain || 'localhost'}`;
}

export function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const scheme = proto === 'https' || proto === 'http' ? proto : (req.socket?.encrypted ? 'https' : 'http');
  return `${scheme}://${req.headers.host || 'localhost'}`;
}
