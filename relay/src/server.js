// 入口：配置装载、HTTP/HTTPS 服务、路由分发、升级请求分流、优雅退出。
//
// 分层意图很明确：
//   server.js  只做「把请求送到正确的处理器」，不碰协议细节；
//   websocket.js 只做 RFC 6455，不认识设备也不认识用户；
//   tunnel.js  只做配对与转发，不知道 HTTP 路由长什么样；
//   auth.js / users.js 只做身份与持久化。
// 这样每一层都可以单独用脚本验证（见项目根目录的验证脚本）。

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { URL } from 'node:url';

import {
  createLogger,
  setLogLevel,
  jsonResponse,
  htmlResponse,
  textResponse,
  readBody,
  readJsonBody,
  parseCookies,
  serializeCookie,
  clientIp,
  isSameOrigin,
  publicOrigin as computePublicOrigin,
  requestOrigin,
  normalizeIpRule,
  checkIpAllowlist,
  clampInt,
  validateDeviceName,
  ipMatchesRule,
  nowMs,
  HttpError,
} from './util.js';
import { Store, makeDeviceSecretHash, normalizeUsername } from './users.js';
import { AuthService, TokenIssuer, LoginLimiter, resolveSigningKey } from './auth.js';
import { TunnelHub } from './tunnel.js';
import { homePage, loginPage, registerPage, devicesPage, errorPage } from './static.js';

const log = createLogger('server');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* ------------------------------------------------------------------ 配置 */

const DEFAULTS = {
  listen: { host: '0.0.0.0', port: 8787 },
  tls: { enabled: false, certPath: '', keyPath: '' },
  domain: 'localhost',
  publicUrl: '',
  dataDir: './data',
  usersFile: '',
  signingKeyFile: '',
  tokenSecret: '',
  auth: {
    allowRegistration: true,
    maxUsers: 50,
    inviteCode: '',
    tokenTtlSec: 12 * 3600,
    cookieName: 'mydsh_token',
    cookieSecure: true,
    // 「每次登录需邮箱验证」的扩展点开关。置 true 时本程序仍不会自己发信，
    // 需要由插件/外部服务注册 verifier，否则登录会因为缺少校验器而被拒绝。
    requireEmailVerification: false,
  },
  limits: {
    maxDevicesPerUser: 5,
    loginMaxFailures: 5,
    registerPerHour: 10,
    upgradeAttemptsPerMinute: 30,
    apiRequestsPerMinute: 120,
    maxBodyBytes: 25 * 1024 * 1024,
    maxJsonBodyBytes: 64 * 1024,
  },
  tunnel: {
    heartbeatMs: 30_000,
    httpTimeoutMs: 60_000,
    maxChannelsPerDevice: 32,
    maxMessageBytes: 16 * 1024 * 1024,
  },
  security: {
    trustProxy: true,
    visitorRequireAuth: false,
    globalIpAllowlist: [],
    allowedOrigins: [],
    hsts: false,
  },
  log: { level: 'info' },
};

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    if (base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k]) && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function configPathFromEnv() {
  const fromArgv = process.argv[2];
  return (
    fromArgv ||
    process.env.MYDSH_RELAY_CONFIG ||
    path.join(ROOT, 'relay.config.json')
  );
}

async function loadConfig() {
  const file = path.resolve(configPathFromEnv());
  let raw = {};
  try {
    raw = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      // 没有配置文件不直接失败：容器/宝塔场景里常用纯环境变量注入，
      // 但要把「我用的是默认配置」这件事显式说出来，避免以为读了配置。
      log.warn('未找到配置文件，使用默认值 + 环境变量', { file });
    } else {
      throw new Error(`配置文件解析失败（${file}）：${err.message}`);
    }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('配置文件顶层必须是对象');
  }

  const cfg = deepMerge(structuredClone(DEFAULTS), raw);

  // 环境变量优先级最高：这样同一份配置文件可以在不同机器上跑，
  // 密钥只需要在部署平台上注入，不必落到磁盘。
  const env = process.env;
  if (env.MYDSH_RELAY_PORT) cfg.listen.port = Number(env.MYDSH_RELAY_PORT);
  if (env.MYDSH_RELAY_HOST) cfg.listen.host = env.MYDSH_RELAY_HOST;
  if (env.MYDSH_RELAY_DOMAIN) cfg.domain = env.MYDSH_RELAY_DOMAIN;
  if (env.MYDSH_RELAY_PUBLIC_URL) cfg.publicUrl = env.MYDSH_RELAY_PUBLIC_URL;
  if (env.MYDSH_RELAY_DATA_DIR) cfg.dataDir = env.MYDSH_RELAY_DATA_DIR;
  if (env.MYDSH_RELAY_TOKEN_SECRET) cfg.tokenSecret = env.MYDSH_RELAY_TOKEN_SECRET;
  if (env.MYDSH_RELAY_INVITE_CODE) cfg.auth.inviteCode = env.MYDSH_RELAY_INVITE_CODE;
  if (env.MYDSH_RELAY_ALLOW_REGISTRATION) cfg.auth.allowRegistration = /^(1|true|yes)$/i.test(env.MYDSH_RELAY_ALLOW_REGISTRATION);
  if (env.MYDSH_RELAY_TLS_CERT) cfg.tls.certPath = env.MYDSH_RELAY_TLS_CERT;
  if (env.MYDSH_RELAY_TLS_KEY) cfg.tls.keyPath = env.MYDSH_RELAY_TLS_KEY;
  if (env.MYDSH_RELAY_LOG_LEVEL) cfg.log.level = env.MYDSH_RELAY_LOG_LEVEL;
  if (env.MYDSH_RELAY_TRUST_PROXY) cfg.security.trustProxy = /^(1|true|yes)$/i.test(env.MYDSH_RELAY_TRUST_PROXY);

  // ---- 归一化与校验：任何一项不合规都直接拒绝启动，不要带着半可用配置上线 ----
  cfg.listen.port = clampInt(cfg.listen.port, 1, 65535, 8787);
  if (!/^[A-Za-z0-9._-]{1,253}$/.test(String(cfg.domain || ''))) {
    throw new Error(`domain 不合法：${cfg.domain}`);
  }
  cfg.dataDir = path.isAbsolute(cfg.dataDir) ? cfg.dataDir : path.join(ROOT, cfg.dataDir);
  cfg.usersFile = cfg.usersFile
    ? path.isAbsolute(cfg.usersFile)
      ? cfg.usersFile
      : path.join(ROOT, cfg.usersFile)
    : path.join(cfg.dataDir, 'users.json');
  cfg.signingKeyFile = cfg.signingKeyFile
    ? path.isAbsolute(cfg.signingKeyFile)
      ? cfg.signingKeyFile
      : path.join(ROOT, cfg.signingKeyFile)
    : path.join(cfg.dataDir, 'signing.key');

  cfg.auth.tokenTtlSec = clampInt(cfg.auth.tokenTtlSec, 300, 30 * 86400, 12 * 3600);
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(String(cfg.auth.cookieName))) throw new Error('cookieName 只允许字母数字与 _ . -');
  cfg.limits.maxBodyBytes = clampInt(cfg.limits.maxBodyBytes, 1024, 512 * 1024 * 1024, 25 * 1024 * 1024);
  cfg.limits.maxJsonBodyBytes = clampInt(cfg.limits.maxJsonBodyBytes, 1024, 1024 * 1024, 64 * 1024);
  cfg.tunnel.heartbeatMs = clampInt(cfg.tunnel.heartbeatMs, 5000, 300_000, 30_000);
  cfg.tunnel.httpTimeoutMs = clampInt(cfg.tunnel.httpTimeoutMs, 5000, 600_000, 60_000);
  cfg.tunnel.maxChannelsPerDevice = clampInt(cfg.tunnel.maxChannelsPerDevice, 1, 1024, 32);
  cfg.tunnel.maxMessageBytes = clampInt(cfg.tunnel.maxMessageBytes, 64 * 1024, 256 * 1024 * 1024, 16 * 1024 * 1024);
  cfg.limits.maxDevicesPerUser = clampInt(cfg.limits.maxDevicesPerUser, 1, 100, 5);

  const normalizedAllow = [];
  for (const entry of cfg.security.globalIpAllowlist || []) {
    const n = normalizeIpRule(entry);
    if (!n) throw new Error(`security.globalIpAllowlist 中存在无法识别的条目：${entry}`);
    normalizedAllow.push(n);
  }
  cfg.security.globalIpAllowlist = normalizedAllow;

  const tlsWanted = Boolean(cfg.tls.certPath && cfg.tls.keyPath);
  cfg.tls.enabled = Boolean(cfg.tls.enabled && tlsWanted);
  if (cfg.tls.enabled) {
    for (const key of ['certPath', 'keyPath']) {
      const p = path.isAbsolute(cfg.tls[key]) ? cfg.tls[key] : path.join(ROOT, cfg.tls[key]);
      cfg.tls[key] = p;
      // 提前探测可读性，别等到第一次 TLS 握手才炸。
      await fsp.access(p).catch(() => {
        throw new Error(`TLS ${key} 不可读：${p}`);
      });
    }
  } else if (cfg.tls.enabled === false && (cfg.tls.certPath || cfg.tls.keyPath) && !tlsWanted) {
    // 只填了证书或只填了私钥：几乎必然是配置写漏了。此时不能静默降级成 HTTP，
    // 否则运维以为自己在跑 HTTPS，实际流量全是明文。
    throw new Error('tls.certPath 与 tls.keyPath 必须同时提供');
  } else if (raw.tls && raw.tls.enabled === true && !tlsWanted) {
    throw new Error('tls.enabled 为 true 但未提供 certPath/keyPath');
  } else if (tlsWanted) {
    // 证书路径写了但 enabled=false：典型的「nginx 做 TLS」场景，只需要提示。
    log.warn('已配置证书路径但 tls.enabled=false，将由前置 nginx 终结 TLS（这是推荐做法）');
  }

  cfg.publicUrl = cfg.publicUrl || `${cfg.tls.enabled ? 'https' : 'http'}://${cfg.domain}`;
  try {
    new URL(cfg.publicUrl);
  } catch {
    throw new Error(`publicUrl 不合法：${cfg.publicUrl}`);
  }
  cfg.__file = file;
  return cfg;
}

/* ------------------------------------------------------------- 限流（HTTP） */

/**
 * 滑动窗口计数器。比「令牌桶」简单，且足以挡住脚本级别的滥用；
 * 真正的抗压交给 nginx 的 limit_req（见 deploy.md），这里只做应用层兜底。
 */
class SlidingWindow {
  #map = new Map();
  #windowMs;
  #limit;
  #timer;

  constructor(limit, windowMs) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#timer = setInterval(() => this.#sweep(), Math.max(10_000, windowMs));
    this.#timer.unref?.();
  }

  hit(key) {
    const t = nowMs();
    let bucket = this.#map.get(key);
    if (!bucket) {
      bucket = { start: t, count: 0 };
      this.#map.set(key, bucket);
    } else if (t - bucket.start >= this.#windowMs) {
      bucket.start = t;
      bucket.count = 0;
    }
    bucket.count += 1;
    if (bucket.count > this.#limit) {
      return { allowed: false, retryAfterMs: this.#windowMs - (t - bucket.start) };
    }
    return { allowed: true };
  }

  #sweep() {
    const t = nowMs();
    for (const [k, b] of this.#map) {
      if (t - b.start > this.#windowMs * 2) this.#map.delete(k);
    }
  }

  dispose() {
    clearInterval(this.#timer);
  }
}

/* ------------------------------------------------------------------ 应用 */

async function main() {
  const config = await loadConfig();
  setLogLevel(config.log.level);

  await fsp.mkdir(config.dataDir, { recursive: true });
  // 数据目录权限收紧：里面存着密码哈希与签名密钥，同机其他用户不该能读。
  await fsp.chmod(config.dataDir, 0o700).catch(() => {});

  // 签名密钥：显式配置优先，否则首次启动生成并落盘。
  // 绝不能有硬编码默认值——那等于让任何人伪造 token。
  let signingKey;
  if (config.tokenSecret) {
    signingKey = await resolveSigningKey(config, null);
  } else {
    signingKey = await loadOrCreateKeyFile(config.signingKeyFile);
  }

  const store = new Store(config.usersFile);
  await store.load();

  const tokens = new TokenIssuer({
    key: signingKey,
    issuer: `mydsh-relay:${config.domain}`,
    ttlSec: config.auth.tokenTtlSec,
  });
  const loginLimiter = new LoginLimiter({ maxFailures: config.limits.loginMaxFailures });
  const registerLimiter = new LoginLimiter({
    maxFailures: config.limits.registerPerHour,
    windowMs: 3600_000,
    lockBaseMs: 600_000,
    lockMaxMs: 3600_000,
  });

  const auth = new AuthService({
    store,
    tokens,
    config: {
      ...config.auth,
      allowRegistration: config.auth.allowRegistration,
      cookieName: config.auth.cookieName,
      maxUsers: config.auth.maxUsers,
    },
    limiter: loginLimiter,
    registerLimiter,
  });

  const hub = new TunnelHub({ config, auth });

  if (config.auth.requireEmailVerification) {
    auth.registerLoginVerifier(async ({ user }) => {
      // 明确的「未配置」失败：不要让运营者以为打开开关就等于有了邮箱验证，
      // 那样反而是安全上的虚假安全感。插件应注册自己的 verifier 来覆盖这里。
      throw new Error(`账号 ${user.username} 需要邮箱验证，但本服务未配置验证器`);
    });
  }

  const apiLimiter = new SlidingWindow(config.limits.apiRequestsPerMinute, 60_000);
  const upgradeLimiter = new SlidingWindow(config.limits.upgradeAttemptsPerMinute, 60_000);

  const ctx = {
    config,
    store,
    auth,
    hub,
    tokens,
    origin: computePublicOrigin(config),
    apiLimiter,
    upgradeLimiter,
  };

  const requestHandler = (req, res) => {
    handleRequest(req, res, ctx).catch((err) => {
      if (err instanceof HttpError) {
        jsonResponse(res, err.status, { ok: false, code: err.code, message: err.message });
        return;
      }
      log.error('请求处理未捕获异常', { url: String(req.url).split('?')[0], error: err.message, stack: err.stack?.split('\n').slice(0, 4).join(' | ') });
      if (!res.headersSent) {
        htmlResponse(res, 500, errorPage({ status: 500, message: '服务端内部错误', origin: ctx.origin }));
      } else {
        res.end();
      }
    });
  };

  const server = config.tls.enabled
    ? https.createServer(
        {
          cert: await fsp.readFile(config.tls.certPath),
          key: await fsp.readFile(config.tls.keyPath),
          minVersion: 'TLSv1.2',
          honorCipherOrder: true,
        },
        requestHandler,
      )
    : http.createServer(requestHandler);

  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head, ctx).catch((err) => {
      log.error('升级请求处理异常', { error: err.message });
      try {
        socket.destroy();
      } catch {
        /* 忽略 */
      }
    });
  });

  // 慢速攻击防护：Node 默认 header 超时 60s，body 超时无限。这里显式收紧。
  server.headersTimeout = 30_000;
  server.requestTimeout = 300_000; // 大文件上传转发需要较长窗口，由 tunnel 层再做单请求超时
  server.keepAliveTimeout = 65_000;
  server.maxHeadersCount = 100;
  server.on('clientError', (err, socket) => {
    if (!socket.writable) return;
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
    } catch {
      /* 忽略 */
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.listen.port, config.listen.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const actualPort = config.listen.port === 0 ? server.address().port : config.listen.port;
  log.info('mydsh-relay 已启动', {
    scheme: config.tls.enabled ? 'https' : 'http',
    listen: `${config.listen.host}:${actualPort}`,
    domain: config.domain,
    users: store.countUsers(),
    allowRegistration: config.auth.allowRegistration,
    publicUrl: config.publicUrl,
  });
  if (!config.tls.enabled) {
    log.warn('当前未启用 TLS。若本服务直接对公网暴露，请务必让 nginx/宝塔面板在前面做 HTTPS 终止');
  }

  /* ------------------------------------------------------------ 优雅退出 */

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    log.info('收到退出信号，开始关闭', { signal });
    const forceTimer = setTimeout(() => {
      log.error('优雅关闭超时，强制退出');
      process.exit(1);
    }, 15_000);
    forceTimer.unref?.();
    try {
      await new Promise((r) => server.close(() => r()));
      await hub.closeAll();
      loginLimiter.dispose();
      registerLimiter.dispose();
      apiLimiter.dispose();
      upgradeLimiter.dispose();
      await store.close();
      log.info('已安全关闭');
      clearTimeout(forceTimer);
      process.exit(0);
    } catch (err) {
      log.error('关闭过程出错', { error: err.message });
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  process.on('uncaughtException', (err) => {
    // 未捕获异常后进程状态不可信，记日志后退出，交给 systemd/pm2 拉起。
    log.error('未捕获异常', { error: err.message, stack: String(err.stack || '').split('\n').slice(0, 6).join(' | ') });
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    log.error('未处理的 Promise 拒绝', { error: reason instanceof Error ? reason.message : String(reason) });
  });

  return { server, ctx };
}

async function loadOrCreateKeyFile(file) {
  try {
    const raw = (await fsp.readFile(file, 'utf8')).trim();
    if (raw.length < 32) throw new Error(`签名密钥文件内容过短：${file}`);
    return Buffer.from(raw, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // 32 字节随机数的 base64url 约 43 字符，足够做 HMAC 密钥。
    const key = crypto.randomBytes(32).toString('base64url');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, `${key}\n`, { mode: 0o600 });
    log.info('已生成新的 token 签名密钥', { file });
    return Buffer.from(key, 'utf8');
  }
}

/* ------------------------------------------------------------------ 路由 */

function securityHeaders(config) {
  const headers = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    // CSP 不用 unsafe-inline 就无法在 <script> 里写内联事件，因此页面脚本
    // 全部放在 <script> 块内并允许 inline；但禁止一切外部源，防止被 CDN 投毒。
    'content-security-policy':
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'permissions-policy': 'geolocation=(), microphone=(), camera=()',
  };
  if (config.tls.enabled || config.security.hsts) {
    headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

function setHeadersOnce(res, headers) {
  if (res.headersSent) return;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
}

async function handleRequest(req, res, ctx) {
  const { config, auth, store, hub, origin } = ctx;
  const baseHeaders = securityHeaders(config);

  // Host 校验：防 DNS rebinding。允许配置的域名与带端口的本机名。
  const host = String(req.headers.host || '').toLowerCase();
  const allowedHosts = new Set([config.domain.toLowerCase(), `127.0.0.1:${config.listen.port}`, `localhost:${config.listen.port}`]);
  try {
    allowedHosts.add(new URL(config.publicUrl).host.toLowerCase());
  } catch {
    /* 已在配置阶段校验过 */
  }
  if (host && !allowedHosts.has(host) && !host.endsWith(`.${config.domain.toLowerCase()}`)) {
    // 反向代理场景下 Host 会被 nginx 改写，因此这里只记日志不拒绝：
    // 强制拒绝会让「用 IP 直连调试」这种正常需求变成故障。
    // 真正的防护是 nginx 侧的 server_name 与证书域名绑定。
    log.debug('Host 与配置域名不一致', { host });
  }

  const ip = clientIp(req, config.security.trustProxy);
  if (!checkIpAllowlist(ip, config.security.globalIpAllowlist)) {
    setHeadersOnce(res, baseHeaders);
    textResponse(res, 403, '你的 IP 不在本站白名单内\n');
    log.warn('全局 IP 白名单拒绝', { ip, path: String(req.url).split('?')[0] });
    return;
  }

  // 解析 URL。用固定 base 只取 path/query，不信任 Host。
  let url;
  try {
    url = new URL(req.url || '/', 'http://relay.local');
  } catch {
    throw new HttpError(400, 'URL 格式错误');
  }
  const pathname = decodeUrlPath(url.pathname);
  if (pathname === null) throw new HttpError(400, 'URL 含有非法路径');

  req.cookies = parseCookies(req.headers.cookie);
  req.clientIp = ip;

  const method = req.method || 'GET';
  setHeadersOnce(res, baseHeaders);

  /* ------------------------------ 静态页面 ------------------------------ */

  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const session = auth.authenticateRequest(req);
    const devices = session.ok
      ? store.listDevicesOfUser(session.user.id).map((d) => {
          const t = hub.getDevice(d.id);
          return { id: d.id, name: d.name, online: Boolean(t && t.isOpen), channels: t ? t.channelCount : 0, lastSeenAt: d.lastSeenAt };
        })
      : [];
    htmlResponse(
      res,
      200,
      homePage({ config, user: session.ok ? session.user : null, stats: hub.statsSnapshot(), devices }),
    );
    return;
  }

  if (method === 'GET' && pathname === '/login') {
    htmlResponse(res, 200, loginPage({ allowRegistration: config.auth.allowRegistration }));
    return;
  }

  if (method === 'GET' && pathname === '/register') {
    if (!config.auth.allowRegistration) {
      htmlResponse(res, 403, errorPage({ status: 403, message: '本站点已关闭注册', origin }));
      return;
    }
    htmlResponse(res, 200, registerPage({ allowRegistration: true }));
    return;
  }

  if (method === 'GET' && pathname === '/devices') {
    const session = auth.authenticateRequest(req);
    if (!session.ok) {
      redirectToLogin(res, pathname);
      return;
    }
    const devices = store.listDevicesOfUser(session.user.id).map((d) => {
      const t = hub.getDevice(d.id);
      return {
        id: d.id,
        name: d.name,
        online: Boolean(t && t.isOpen),
        channels: t ? t.channelCount : 0,
        lastSeenAt: d.lastSeenAt,
        revoked: d.revoked,
      };
    });
    const limit = config.limits.maxDevicesPerUser;
    htmlResponse(res, 200, devicesPage({ user: session.user, devices, deviceLimit: limit, origin }));
    return;
  }

  /* ------------------------------- API --------------------------------- */

  if (pathname.startsWith('/api/')) {
    await handleApi(req, res, ctx, { pathname, url, ip, origin });
    return;
  }

  /* --------------------------- 访客隧道入口 ---------------------------- */

  if (pathname === '/tunnel') {
    // 用普通 HTTP 请求访问 /tunnel 说明客户端没发 Upgrade，直接解释清楚。
    textResponse(res, 426, '此路径只接受 WebSocket 升级请求（Upgrade: websocket）\n', 'text/plain; charset=utf-8', {
      upgrade: 'websocket',
      connection: 'Upgrade',
    });
    return;
  }

  if (pathname.startsWith('/d/')) {
    const parsed = parseDevicePath(pathname);
    if (!parsed) throw new HttpError(400, '设备路径格式错误');
    const { deviceId, rest } = parsed;

    if (!/^[A-Za-z0-9_-]{8,32}$/.test(deviceId)) {
      htmlResponse(res, 400, errorPage({ status: 400, message: '设备 ID 格式不正确', origin }));
      return;
    }
    const device = store.getDevice(deviceId);
    if (!device) {
      htmlResponse(res, 404, errorPage({ status: 404, message: '这台设备不存在，或已被所有者删除', deviceId, origin }));
      return;
    }
    if (!hub.isOnline(deviceId)) {
      htmlResponse(
        res,
        503,
        errorPage({
          status: 503,
          code: 'EOFFLINE',
          message: '该设备当前不在线，隧道没有建立，无法访问。',
          deviceId,
          origin,
        }),
      );
      return;
    }

    // 访问控制：可选「访客必须登录且是设备所有者」。
    if (config.security.visitorRequireAuth) {
      const session = auth.authenticateRequest(req);
      if (!session.ok) {
        redirectToLogin(res, pathname + (url.search || ''));
        return;
      }
      if (session.user.id !== device.userId) {
        htmlResponse(res, 403, errorPage({ status: 403, message: '该设备属于其他账号，当前账号无权访问', deviceId, origin }));
        return;
      }
    }

    // 转发普通 HTTP 请求：DSH 的 SPA 资源与 API 都走这里。
    const targetPath = rest === '' ? '/' : rest;
    const result = await hub.forwardHttp(req, res, {
      deviceId,
      ip,
      targetPath,
      query: url.search ? url.search.slice(1) : '',
    });
    if (!result.ok) {
      if (result.code === 'EOFFLINE') {
        htmlResponse(res, 503, errorPage({ status: 503, code: 'EOFFLINE', message: '设备刚刚离线，请稍后重试。', deviceId, origin }));
      } else if (!res.headersSent) {
        htmlResponse(res, 502, errorPage({ status: 502, code: result.code, message: '转发到内网设备失败。', deviceId, origin }));
      }
    }
    return;
  }

  if (pathname === '/favicon.ico') {
    // 内联一个 1x1 透明 gif，避免每次访问都在日志里刷 404。
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.writeHead(200, { 'content-type': 'image/gif', 'content-length': String(gif.length), 'cache-control': 'public, max-age=86400' });
    res.end(gif);
    return;
  }

  htmlResponse(res, 404, errorPage({ status: 404, message: '没有这个页面。', origin }));
}

function redirectToLogin(res, next) {
  // 只接受站内相对路径，防止变成开放重定向。
  const safeNext = typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/';
  res.writeHead(302, { location: `/login?next=${encodeURIComponent(safeNext)}`, 'cache-control': 'no-store' });
  res.end();
}

/** 解码 URL 路径并拒绝穿越/空字节。返回 null 表示非法。 */
function decodeUrlPath(pathname) {
  if (typeof pathname !== 'string' || pathname.length > 4096) return null;
  if (pathname.includes('\u0000')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // 非法百分号编码
  }
  if (decoded.includes('\u0000')) return null;
  // 路径穿越：虽然我们只把路径原样转给插件端，但插件端可能会做文件拼接，
  // 在入口处就挡掉 ".." 能让下游少一层担心。
  const segments = decoded.split('/');
  if (segments.some((s) => s === '..' || s === '.')) {
    // "." 是合法的（/d/x/./a 等价于 /d/x/a），但为了简单一并拒绝；
    // 这类请求在浏览器里本来就被规范化了。
    return null;
  }
  return pathname; // 保留原始（已编码）形式，转发时不再改动
}

function parseDevicePath(pathname) {
  // 形如 /d/<deviceId> 或 /d/<deviceId>/<rest>
  const after = pathname.slice(3); // 去掉 '/d/'
  const slash = after.indexOf('/');
  if (slash === -1) return { deviceId: after, rest: '' };
  return { deviceId: after.slice(0, slash), rest: after.slice(slash) };
}

/* ------------------------------------------------------------------- API */

async function handleApi(req, res, ctx, { pathname, url, ip, origin }) {
  const { config, auth, store, hub } = ctx;
  const method = req.method || 'GET';

  const limit = ctx.apiLimiter.hit(ip);
  if (!limit.allowed) {
    res.writeHead(429, {
      'content-type': 'application/json; charset=utf-8',
      'retry-after': String(Math.ceil(limit.retryAfterMs / 1000)),
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify({ ok: false, code: 'ERATE', message: '请求过于频繁' }));
    return;
  }

  // 写操作必须同源，防 CSRF（cookie 认证下这是必需的第二道锁）。
  const isWrite = method !== 'GET' && method !== 'HEAD';
  if (isWrite && !isSameOrigin(req, config.publicUrl)) {
    throw new HttpError(403, '跨站请求被拒绝（Origin 校验失败）', 'ECSRF');
  }

  if (pathname === '/api/health' && method === 'GET') {
    jsonResponse(res, 200, {
      ok: true,
      service: 'mydsh-relay',
      time: new Date().toISOString(),
      uptimeSec: Math.floor(process.uptime()),
      stats: hub.statsSnapshot(),
    });
    return;
  }

  if (pathname === '/api/register' && method === 'POST') {
    const body = await readJsonBody(req, config.limits.maxJsonBodyBytes);
    const result = await auth.register({
      username: body.username,
      password: body.password,
      inviteCode: body.inviteCode,
      ip,
      userAgent: req.headers['user-agent'],
    });
    if (!result.ok) {
      jsonResponse(res, result.status, { ok: false, code: result.code, message: result.message });
      return;
    }
    jsonResponse(res, 201, { ok: true, user: publicUser(result.user) });
    return;
  }

  if (pathname === '/api/login' && method === 'POST') {
    const body = await readJsonBody(req, config.limits.maxJsonBodyBytes);
    const result = await auth.login({
      username: body.username,
      password: body.password,
      ip,
      userAgent: req.headers['user-agent'],
    });
    if (!result.ok) {
      jsonResponse(res, result.status, { ok: false, code: result.code, message: result.message });
      return;
    }
    setAuthCookie(res, config, result.token, auth.tokens.ttlSec);
    jsonResponse(res, 200, {
      ok: true,
      user: publicUser(result.user),
      // 同时返回 token：插件端/CLI 用 Bearer 更自然，浏览器端继续用 cookie。
      token: result.token,
      expiresAt: result.payload.exp,
    });
    return;
  }

  if (pathname === '/api/logout' && method === 'POST') {
    // 无状态 token 无法真正吊销，只能清 cookie；若需强制下线请改密码（tokenVersion +1）。
    clearAuthCookie(res, config);
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/me' && method === 'GET') {
    const session = auth.authenticateRequest(req);
    if (!session.ok) {
      jsonResponse(res, 401, { ok: false, code: 'EUNAUTH', message: '未登录或会话已过期' });
      return;
    }
    jsonResponse(res, 200, { ok: true, user: publicUser(session.user), expiresAt: session.payload.exp });
    return;
  }

  const deviceMatch = /^\/api\/devices(?:\/([A-Za-z0-9_-]{1,64}))?(?:\/(rotate))?$/.exec(pathname);
  if (!deviceMatch) {
    jsonResponse(res, 404, { ok: false, code: 'ENOTFOUND', message: '接口不存在' });
    return;
  }
  const deviceId = deviceMatch[1];
  const subAction = deviceMatch[2];

  const session = auth.authenticateRequest(req);
  if (!session.ok) {
    jsonResponse(res, 401, { ok: false, code: 'EUNAUTH', message: '未登录或会话已过期' });
    return;
  }
  const user = session.user;

  if (!deviceId && method === 'GET') {
    const list = store.listDevicesOfUser(user.id).map((d) => {
      const t = hub.getDevice(d.id);
      return {
        ...publicDevice(d),
        online: Boolean(t && t.isOpen),
        channels: t ? t.channelCount : 0,
        accessPath: `/d/${d.id}/`,
      };
    });
    jsonResponse(res, 200, { ok: true, devices: list, limit: config.limits.maxDevicesPerUser });
    return;
  }

  if (!deviceId && method === 'POST') {
    const body = await readJsonBody(req, config.limits.maxJsonBodyBytes);
    const nameErr = validateDeviceName(body.name);
    if (nameErr) {
      jsonResponse(res, 400, { ok: false, code: 'EINVAL', message: nameErr });
      return;
    }
    // deviceSecret 只在创建时出现一次；库里只存 scrypt 哈希。
    const secret = crypto.randomBytes(32).toString('base64url');
    const secretHash = await makeDeviceSecretHash(secret);
    try {
      const device = await store.createDevice({
        userId: user.id,
        name: body.name || '未命名设备',
        secretHash,
        limit: config.limits.maxDevicesPerUser,
      });
      log.info('设备已创建', { userId: user.id, deviceId: device.id, ip });
      jsonResponse(res, 201, {
        ok: true,
        device: publicDevice(device),
        deviceSecret: secret,
        warning: 'deviceSecret 只显示这一次，请立即保存到插件配置中。',
      });
    } catch (err) {
      if (err.code === 'EDEVICE_LIMIT') {
        jsonResponse(res, 409, { ok: false, code: err.code, message: err.message });
        return;
      }
      throw err;
    }
    return;
  }

  if (deviceId && subAction === 'rotate' && method === 'POST') {
    const device = store.getDevice(deviceId);
    if (!device || device.userId !== user.id) {
      jsonResponse(res, 404, { ok: false, code: 'ENOTFOUND', message: '设备不存在' });
      return;
    }
    const secret = crypto.randomBytes(32).toString('base64url');
    const secretHash = await makeDeviceSecretHash(secret);
    await store.rotateDeviceSecret(deviceId, user.id, secretHash);
    // 轮换后立刻踢掉现有隧道：否则旧进程仍持有一条已失效凭据的连接，
    // 会造成「凭据已泄露但攻击者还在线」的错觉。
    const tunnel = hub.getDevice(deviceId);
    if (tunnel) {
      tunnel.markInterrupted('secret-rotated');
      tunnel.shutdown('凭据已轮换');
      try {
        tunnel.ws.close(4000, 'device secret rotated');
      } catch {
        tunnel.ws.terminate();
      }
    }
    log.info('设备凭据已轮换', { userId: user.id, deviceId, ip });
    jsonResponse(res, 200, { ok: true, deviceId, deviceSecret: secret, warning: '旧密钥已失效，请立即更新插件配置。' });
    return;
  }

  if (deviceId && method === 'PATCH') {
    const body = await readJsonBody(req, config.limits.maxJsonBodyBytes);
    const patch = {};
    if (body.name !== undefined) {
      const nameErr = validateDeviceName(body.name);
      if (nameErr) {
        jsonResponse(res, 400, { ok: false, code: 'EINVAL', message: nameErr });
        return;
      }
      patch.name = String(body.name).trim() || '未命名设备';
    }
    if (body.tunnelEnabled !== undefined) patch.tunnelEnabled = Boolean(body.tunnelEnabled);
    try {
      const device = await store.updateDevice(deviceId, user.id, patch);
      jsonResponse(res, 200, { ok: true, device: publicDevice(device) });
    } catch (err) {
      jsonResponse(res, 404, { ok: false, code: 'ENOTFOUND', message: err.message });
    }
    return;
  }

  if (deviceId && method === 'DELETE') {
    try {
      await store.deleteDevice(deviceId, user.id);
      const tunnel = hub.getDevice(deviceId);
      if (tunnel) {
        tunnel.markInterrupted('device-deleted');
        tunnel.shutdown('设备已删除');
        try {
          tunnel.ws.close(4001, 'device deleted');
        } catch {
          tunnel.ws.terminate();
        }
      }
      log.info('设备已删除', { userId: user.id, deviceId, ip });
      jsonResponse(res, 200, { ok: true });
    } catch (err) {
      jsonResponse(res, 404, { ok: false, code: 'ENOTFOUND', message: err.message });
    }
    return;
  }

  jsonResponse(res, 405, { ok: false, code: 'EMETHOD', message: '不支持的方法' });
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

function publicDevice(device) {
  return {
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    revoked: Boolean(device.revoked),
    tunnelEnabled: device.tunnelEnabled !== false,
  };
}

function setAuthCookie(res, config, token, ttlSec) {
  const secure = config.tls.enabled || Boolean(config.security.hsts) || (config.publicUrl || '').startsWith('https://');
  const cookie = serializeCookie(config.auth.cookieName, token, {
    maxAge: ttlSec,
    httpOnly: true,
    sameSite: 'Lax',
    secure,
  });
  const prev = res.getHeader('set-cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  list.push(cookie);
  res.setHeader('set-cookie', list);
}

function clearAuthCookie(res, config) {
  const secure = config.tls.enabled || (config.publicUrl || '').startsWith('https://');
  res.setHeader(
    'set-cookie',
    serializeCookie(config.auth.cookieName, '', { maxAge: 0, httpOnly: true, sameSite: 'Lax', secure }),
  );
}

/* -------------------------------------------------------------- 升级请求 */

async function handleUpgrade(req, socket, head, ctx) {
  const { config, hub, auth } = ctx;
  socket.on('error', (err) => {
    log.debug('升级前的 socket 错误', { error: err.message });
  });

  const ip = clientIp(req, config.security.trustProxy);
  if (!checkIpAllowlist(ip, config.security.globalIpAllowlist)) {
    rejectSocket(socket, '你的 IP 不在本站白名单内');
    return;
  }
  const gate = ctx.upgradeLimiter.hit(ip);
  if (!gate.allowed) {
    log.warn('升级请求限流', { ip, path: String(req.url || '').split('?')[0] });
    rejectSocket(socket, '连接过于频繁，请稍后再试', 429);
    return;
  }

  let url;
  try {
    url = new URL(req.url || '/', 'http://relay.local');
  } catch {
    rejectSocket(socket, 'URL 格式错误');
    return;
  }
  const pathname = url.pathname;

  /* ---------------------------- 插件端隧道 ---------------------------- */
  if (pathname === '/tunnel') {
    // 凭据可以放在 query、header 或 Authorization 里：不同客户端环境
    // （浏览器受限、反向代理丢 header）限制不同，多给两种入口比让用户猜更好。
    const deviceId = firstOf(url.searchParams.get('deviceId'), req.headers['x-device-id'], bearerOrNull(req));
    const deviceSecret = firstOf(
      url.searchParams.get('deviceSecret'),
      url.searchParams.get('secret'),
      req.headers['x-device-secret'],
    );
    if (!deviceId || !deviceSecret) {
      log.warn('隧道连接缺少凭据', { ip });
      rejectSocket(socket, '缺少 deviceId 或 deviceSecret', 403);
      return;
    }
    if (typeof deviceId !== 'string' || deviceId.length > 64 || typeof deviceSecret !== 'string' || deviceSecret.length > 256) {
      rejectSocket(socket, '凭据格式不正确', 403);
      return;
    }
    // query 里带凭据会被 nginx 默认日志记下来，这里主动提示。
    if (url.searchParams.get('deviceSecret')) {
      log.warn('deviceSecret 通过 URL 传递，建议改用 X-Device-Secret 头以避免被访问日志记录', { ip });
    }
    try {
      await hub.acceptTunnel(req, socket, head, { deviceId, deviceSecret, ip });
    } catch (err) {
      log.error('接受隧道时异常', { error: err.message });
      try {
        socket.destroy();
      } catch {
        /* 忽略 */
      }
    }
    return;
  }

  /* ---------------------------- 访客 WebSocket ---------------------------- */
  if (pathname.startsWith('/d/')) {
    const parsed = parseDevicePath(pathname);
    if (!parsed || !/^[A-Za-z0-9_-]{8,32}$/.test(parsed.deviceId)) {
      rejectSocket(socket, '设备 ID 格式不正确');
      return;
    }
    const device = ctx.store.getDevice(parsed.deviceId);
    if (!device) {
      rejectSocket(socket, '设备不存在', 404);
      return;
    }
    if (!hub.isOnline(parsed.deviceId)) {
      rejectSocket(socket, '设备离线', 503);
      return;
    }
    if (config.security.visitorRequireAuth) {
      const token = AuthService.extractToken(req, config.auth.cookieName);
      const session = token ? auth.authenticate(token) : { ok: false };
      if (!session.ok || session.user.id !== device.userId) {
        rejectSocket(socket, '需要登录且必须是设备所有者', 403);
        return;
      }
    }
    // 同源校验：WebSocket 不受 CORS 限制，浏览器会带 Origin，
    // 校验它可以挡住「用户打开的恶意网页偷连内网设备」这类场景。
    if (!wsOriginAllowed(req, config)) {
      log.warn('访客 WebSocket Origin 被拒', { origin: req.headers.origin, ip });
      rejectSocket(socket, 'Origin 不被允许', 403);
      return;
    }
    try {
      const result = await hub.acceptVisitor(req, socket, head, { deviceId: parsed.deviceId, ip });
      if (!result.ok) {
        if (result.code === 'EOFFLINE') rejectSocket(socket, '设备离线', 503);
        else if (result.code === 'EBUSY') rejectSocket(socket, '该设备通道已满，请稍后再试', 503);
      }
    } catch (err) {
      log.error('接受访客连接时异常', { error: err.message });
      try {
        socket.destroy();
      } catch {
        /* 忽略 */
      }
    }
    return;
  }

  rejectSocket(socket, '未知的 WebSocket 路径', 404);
}

function wsOriginAllowed(req, config) {
  const origin = req.headers.origin;
  if (!origin) return true; // 非浏览器客户端
  const allowList = new Set();
  try {
    allowList.add(new URL(config.publicUrl).origin);
  } catch {
    /* 忽略 */
  }
  for (const extra of config.security.allowedOrigins || []) {
    try {
      allowList.add(new URL(extra).origin);
    } catch {
      /* 忽略非法配置项 */
    }
  }
  if (allowList.has(origin)) return true;
  // 允许同 Host 的直连（用 IP 调试时非常常见）。
  try {
    return new URL(origin).host === String(req.headers.host || '');
  } catch {
    return false;
  }
}

function bearerOrNull(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

function firstOf(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function rejectSocket(socket, message, status = 400) {
  const body = Buffer.from(`${message}\n`, 'utf8');
  try {
    socket.write(
      `HTTP/1.1 ${status} ${http.STATUS_CODES[status] || 'Error'}\r\n` +
        'connection: close\r\n' +
        'content-type: text/plain; charset=utf-8\r\n' +
        `content-length: ${body.length}\r\n\r\n`,
    );
    socket.write(body);
  } catch {
    /* 忽略 */
  }
  socket.end();
  setTimeout(() => socket.destroy(), 1500).unref?.();
}

/* ------------------------------------------------------------------ 启动 */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((err) => {
    // 启动失败必须给出可读原因并退出非零，让 systemd/pm2 明确看到失败而不是反复拉起。
    process.stderr.write(`[fatal] 启动失败：${err.message}\n${err.stack ? `${err.stack}\n` : ''}`);
    process.exit(1);
  });
}

export { main, loadConfig, handleRequest, handleUpgrade };
