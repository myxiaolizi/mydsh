// 鉴权层：密码哈希、自包含 token、登录/注册限流、会话解析、设备凭据校验。
//
// token 选型是「HMAC 签名的自包含结构」而不是磁盘会话表：
//  - 中转服务可能被多个进程/多台机器跑（宝塔上换机器很方便），无状态签名天然可横向扩；
//  - 少一张需要清理的表，就少一处会在半夜出问题的地方。
// 代价是签发后无法由服务端单独撤销某枚 token，因此 payload 里带了
// `uid + pv`（用户口令版本号）：改密码时把 pv 加一，所有旧 token 立刻失效。

import crypto from 'node:crypto';
import { hashPassword, verifyPassword, DUMMY_PASSWORD_HASH, normalizeUsername } from './users.js';
import {
  randomToken,
  randomId,
  hmacSha256,
  sha256,
  safeEqual,
  nowSec,
  createLogger,
  validateUsername,
  validatePassword,
  ipMatchesRule,
  checkIpAllowlist,
} from './util.js';

const log = createLogger('auth');

/* ------------------------------------------------------------------- token */

const TOKEN_PREFIX = 'v1';
const TOKEN_MAX_LEN = 4096;

function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

function fromB64u(str) {
  return Buffer.from(str, 'base64url');
}

/**
 * 生成签名密钥。如果配置没给 `tokenSecret` 也没有可读的环境变量，就从数据文件里
 * 派生并持久化一条随机密钥——绝不能退化成硬编码默认值，那等于公开可伪造 token。
 */
export async function resolveSigningKey(config, readOrCreateKeyFile) {
  const explicit = config.tokenSecret || process.env.MYDSH_RELAY_TOKEN_SECRET;
  if (explicit) {
    if (String(explicit).length < 32) {
      throw new Error('tokenSecret 太短（至少 32 字符）；请用 `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"` 生成');
    }
    return Buffer.from(String(explicit), 'utf8');
  }
  return readOrCreateKeyFile;
}

export class TokenIssuer {
  #key;
  #issuer;
  #ttlSec;
  #clockSkewSec;

  constructor({ key, issuer = 'mydsh-relay', ttlSec = 12 * 3600, clockSkewSec = 30 }) {
    this.#key = key;
    this.#issuer = issuer;
    this.#ttlSec = ttlSec;
    this.#clockSkewSec = clockSkewSec;
  }

  get ttlSec() {
    return this.#ttlSec;
  }

  issue(user) {
    const iat = nowSec();
    const payload = {
      v: 1,
      iss: this.#issuer,
      sub: user.id,
      usr: user.username,
      pv: user.tokenVersion || 0,
      iat,
      // nbf/exp 都用秒；jti 让日志可以只靠一个短 id 关联「哪个会话」，
      // 不必把整枚 token 写进日志。
      nbf: iat,
      exp: iat + this.#ttlSec,
      jti: randomId('t_').slice(0, 18),
    };
    const body = b64u(JSON.stringify(payload));
    const sig = b64u(hmacSha256(this.#key, `${TOKEN_PREFIX}.${body}`));
    return { token: `${TOKEN_PREFIX}.${body}.${sig}`, payload };
  }

  verify(token) {
    if (typeof token !== 'string' || token.length === 0 || token.length > TOKEN_MAX_LEN) {
      return { ok: false, reason: 'malformed' };
    }
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return { ok: false, reason: 'malformed' };
    const [, body, sig] = parts;
    let given;
    try {
      given = fromB64u(sig);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    const expected = hmacSha256(this.#key, `${TOKEN_PREFIX}.${body}`);
    // 签名不合格时不要解析 payload：解析不可信 JSON 没有意义，还多攻击面。
    if (!safeEqual(given, expected)) return { ok: false, reason: 'bad-signature' };
    let payload;
    try {
      payload = JSON.parse(fromB64u(body).toString('utf8'));
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (!payload || typeof payload !== 'object' || payload.v !== 1) return { ok: false, reason: 'unsupported' };
    if (typeof payload.sub !== 'string' || payload.sub.length > 64) return { ok: false, reason: 'malformed' };
    const t = nowSec();
    if (typeof payload.exp !== 'number' || payload.exp + this.#clockSkewSec < t) return { ok: false, reason: 'expired' };
    if (typeof payload.nbf === 'number' && payload.nbf - this.#clockSkewSec > t) return { ok: false, reason: 'not-yet' };
    if (payload.iss !== this.#issuer) return { ok: false, reason: 'bad-issuer' };
    return { ok: true, payload };
  }
}

/** 一次性邀请/找回凭据之类场景用的短时随机串（扩展点）。 */
export function newOpaqueToken() {
  return randomToken(32);
}

/* ---------------------------------------------------------------- 限流器 */

/**
 * 指数退避式限流。与「固定窗口计数」相比，退避更省状态：只需记每把钥匙的失败次数
 * 和下次允许时间，且对长期持续爆破的压制更强。
 *
 * 维度设计：
 *  - 按 `ip` 限制：挡住同一来源横向撞多个账号；
 *  - 按 `ip|username` 限制：挡住针对单账号的定点爆破；
 *  - 按 `username` 限制：挡住分布式 IP 打同一账号（宁可达不到，也不能让单账号被攻破）。
 */
export class LoginLimiter {
  #map = new Map();
  #timer = null;

  constructor({
    maxFailures = 5,
    windowMs = 15 * 60_000,
    lockBaseMs = 30_000,
    lockMaxMs = 60 * 60_000,
    maxEntries = 20_000,
  } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.lockBaseMs = lockBaseMs;
    this.lockMaxMs = lockMaxMs;
    this.maxEntries = maxEntries;
    // 定期清理，防止攻击者用海量随机用户名把内存撑爆（见 maxEntries 的硬上限）。
    this.#timer = setInterval(() => this.sweep(), 60_000);
    if (typeof this.#timer.unref === 'function') this.#timer.unref();
  }

  #key(kind, value) {
    return `${kind}:${value}`;
  }

  /** 返回 null 表示放行，否则返回剩余锁定毫秒数。 */
  check(...keys) {
    const t = Date.now();
    let worst = 0;
    for (const [kind, value] of keys) {
      if (!value) continue;
      const entry = this.#map.get(this.#key(kind, value));
      if (!entry) continue;
      if (entry.lockedUntil > t) worst = Math.max(worst, entry.lockedUntil - t);
    }
    return worst > 0 ? worst : null;
  }

  fail(...keys) {
    const t = Date.now();
    for (const [kind, value] of keys) {
      if (!value) continue;
      const key = this.#key(kind, value);
      let entry = this.#map.get(key);
      if (!entry || t - entry.firstAt > this.windowMs) {
        entry = { count: 0, firstAt: t, lockedUntil: 0 };
        this.#map.set(key, entry);
      }
      entry.count += 1;
      if (entry.count >= this.maxFailures) {
        const exponent = entry.count - this.maxFailures;
        const lock = Math.min(this.lockMaxMs, this.lockBaseMs * 2 ** Math.min(exponent, 12));
        entry.lockedUntil = t + lock;
        log.warn('触发登录锁定', { kind, value: String(value).slice(0, 48), failures: entry.count, lockMs: lock });
      }
    }
    if (this.#map.size > this.maxEntries) this.sweep(true);
  }

  reset(...keys) {
    for (const [kind, value] of keys) {
      if (!value) continue;
      this.#map.delete(this.#key(kind, value));
    }
  }

  sweep(aggressive = false) {
    const t = Date.now();
    let removed = 0;
    for (const [key, entry] of this.#map) {
      const stale = t - entry.firstAt > this.windowMs && entry.lockedUntil <= t;
      if (stale) {
        this.#map.delete(key);
        removed += 1;
      }
    }
    if (aggressive && this.#map.size > this.maxEntries) {
      // 仍然超限：按字典序砍掉前 20%（Map 保持插入序，即最老的批次）。
      const target = Math.floor(this.#map.size * 0.2);
      let i = 0;
      for (const key of this.#map.keys()) {
        if (i >= target) break;
        this.#map.delete(key);
        i += 1;
      }
      log.warn('限流表超出上限，已淘汰最旧条目', { size: this.#map.size });
    }
    return removed;
  }

  get size() {
    return this.#map.size;
  }

  dispose() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}

/* ------------------------------------------------------------- 鉴权服务 */

export class AuthService {
  #store;
  #tokens;
  #limiter;
  #config;
  #registerLimiter;
  #verifyHooks = [];

  constructor({ store, tokens, config, limiter, registerLimiter }) {
    this.#store = store;
    this.#tokens = tokens;
    this.#config = config;
    this.#limiter = limiter;
    this.#registerLimiter = registerLimiter;
  }

  /**
   * 「每次登录需邮箱验证」的扩展点。默认不挂任何 hook，行为等价于关闭。
   * hook 形态：async (ctx) => void，抛错即拒绝登录。ctx 含 user/ip/userAgent。
   * 之所以留成注册式而不是写死开关，是为了让插件版本可以自己实现发信。
   */
  registerLoginVerifier(fn) {
    if (typeof fn === 'function') this.#verifyHooks.push(fn);
  }

  get tokens() {
    return this.#tokens;
  }

  async register({ username, password, inviteCode, ip, userAgent }) {
    const cfg = this.#config;
    if (!cfg.allowRegistration) {
      return { ok: false, status: 403, code: 'EREG_DISABLED', message: '本站点已关闭注册' };
    }
    const lock = this.#registerLimiter.check(['ip', ip]);
    if (lock) {
      return { ok: false, status: 429, code: 'ERATE', message: `注册过于频繁，请 ${Math.ceil(lock / 1000)} 秒后再试` };
    }
    const userErr = validateUsername(username);
    if (userErr) {
      this.#registerLimiter.fail(['ip', ip]);
      return { ok: false, status: 400, code: 'EINVAL', message: userErr };
    }
    const passErr = validatePassword(password);
    if (passErr) {
      this.#registerLimiter.fail(['ip', ip]);
      return { ok: false, status: 400, code: 'EINVAL', message: passErr };
    }
    if (cfg.maxUsers && this.#store.countUsers() >= cfg.maxUsers) {
      return { ok: false, status: 403, code: 'EFULL', message: '注册人数已达上限' };
    }
    if (cfg.inviteCode) {
      // 邀请码用定长比较，避免逐字符时间侧信道（虽然实际价值有限，但成本为零）。
      const given = String(inviteCode || '');
      if (!safeEqual(sha256(given), sha256(cfg.inviteCode))) {
        this.#registerLimiter.fail(['ip', ip]);
        return { ok: false, status: 403, code: 'EINVITE', message: '邀请码不正确' };
      }
    }
    if (this.#store.hasUsername(username)) {
      // 注册和登录不同：用户名唯一性必须明说，否则用户会一直试。这里只限制次数，
      // 不做「已存在」的模糊化——注册接口本来就能通过尝试揭示用户名存在性。
      this.#registerLimiter.fail(['ip', ip]);
      return { ok: false, status: 409, code: 'EUSERNAME_TAKEN', message: '用户名已被占用' };
    }
    let passwordHash;
    try {
      passwordHash = await hashPassword(password);
    } catch (err) {
      log.error('密码哈希失败', { error: err.message });
      return { ok: false, status: 500, code: 'EHASH', message: '服务端错误' };
    }
    let user;
    try {
      user = await this.#store.createUser({ username, passwordHash });
    } catch (err) {
      if (err.code === 'EUSERNAME_TAKEN') {
        return { ok: false, status: 409, code: 'EUSERNAME_TAKEN', message: '用户名已被占用' };
      }
      throw err;
    }
    // 注册后不自动登录：让用户确认一次密码，是低成本的人为校验点。
    log.info('注册成功', { userId: user.id, username: user.username, ip, ua: String(userAgent || '').slice(0, 80) });
    return { ok: true, user };
  }

  async login({ username, password, ip, userAgent }) {
    const nameKey = typeof username === 'string' ? normalizeUsername(username).slice(0, 64) : '';
    const keys = [
      ['ip', ip],
      ['ipuser', `${ip}|${nameKey}`],
      ['user', nameKey],
    ];
    const lock = this.#limiter.check(...keys);
    if (lock) {
      return { ok: false, status: 429, code: 'ERATE', message: `尝试次数过多，请 ${Math.ceil(lock / 1000)} 秒后再试` };
    }
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      return { ok: false, status: 400, code: 'EINVAL', message: '请输入用户名和密码' };
    }
    if (username.length > 128 || password.length > 512) {
      this.#limiter.fail(...keys);
      return { ok: false, status: 400, code: 'EINVAL', message: '输入过长' };
    }

    const user = this.#store.getUserByName(username);
    // 用户不存在时也算一遍哈希：否则「响应快 = 用户不存在」就是一个免费的
    // 用户名枚举接口，限流挡不住这种零成本探测。
    const stored = user ? user.passwordHash : DUMMY_PASSWORD_HASH;
    const started = Date.now();
    let good = false;
    try {
      good = await verifyPassword(password, stored);
    } catch (err) {
      log.error('口令校验异常', { error: err.message });
    }
    const elapsed = Date.now() - started;
    // 补齐到统一的响应下界，进一步抹平存在性差异。
    const floor = 80;
    if (elapsed < floor) await new Promise((r) => setTimeout(r, floor - elapsed));

    if (!user || !good) {
      this.#limiter.fail(...keys);
      log.warn('登录失败', { username: nameKey, ip, ua: String(userAgent || '').slice(0, 80) });
      return { ok: false, status: 401, code: 'EBADCRED', message: '用户名或密码错误' };
    }
    if (user.disabled) {
      log.warn('登录被拒：账号已停用', { userId: user.id, ip });
      return { ok: false, status: 403, code: 'EDISABLED', message: '账号已停用' };
    }
    if (!checkIpAllowlist(ip, user.ipAllowlist)) {
      // 账号级 IP 白名单：用户自己开的开关，命中即拒并留痕。
      log.warn('登录被拒：不在账号 IP 白名单内', { userId: user.id, ip });
      return { ok: false, status: 403, code: 'EIPDENY', message: `当前 IP（${ip}）不在该账号的白名单内` };
    }
    for (const hook of this.#verifyHooks) {
      try {
        await hook({ user, ip, userAgent });
      } catch (err) {
        log.warn('二次验证未通过', { userId: user.id, error: err.message });
        return { ok: false, status: 403, code: 'E2FA', message: err.message || '二次验证未通过' };
      }
    }

    this.#limiter.reset(...keys);
    await this.#store.touchLogin(user.id, ip).catch(() => {});
    const issued = this.#tokens.issue(user);
    log.info('登录成功', { userId: user.id, jti: issued.payload.jti, ip, ua: String(userAgent || '').slice(0, 80) });
    return { ok: true, user, token: issued.token, payload: issued.payload };
  }

  /** 从请求中取凭据：优先 Authorization，其次 cookie。 */
  static extractToken(req, cookieName = 'mydsh_token') {
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.length > 0) {
      const m = /^Bearer\s+(.+)$/i.exec(header.trim());
      if (m) return m[1].trim();
    }
    const cookies = req.cookies || {};
    const fromCookie = cookies[cookieName];
    if (typeof fromCookie === 'string' && fromCookie) return fromCookie;
    return null;
  }

  /**
   * 校验会话并返回用户对象。注意 token 里的 pv 必须与当前用户记录一致：
   * 这是「改密码即踢下线」的实现方式。
   */
  authenticate(token) {
    const result = this.#tokens.verify(token);
    if (!result.ok) return { ok: false, reason: result.reason };
    const user = this.#store.getUserById(result.payload.sub);
    if (!user) return { ok: false, reason: 'user-gone' };
    if (user.disabled) return { ok: false, reason: 'disabled' };
    if ((user.tokenVersion || 0) !== (result.payload.pv || 0)) return { ok: false, reason: 'stale' };
    return { ok: true, user, payload: result.payload };
  }

  authenticateRequest(req) {
    const token = AuthService.extractToken(req, this.#config.cookieName);
    if (!token) return { ok: false, reason: 'no-token' };
    return this.authenticate(token);
  }

  async changePassword(userId, currentPassword, nextPassword) {
    const user = this.#store.getUserById(userId);
    if (!user) return { ok: false, status: 404, message: '用户不存在' };
    const err = validatePassword(nextPassword);
    if (err) return { ok: false, status: 400, message: err };
    if (currentPassword === nextPassword) return { ok: false, status: 400, message: '新密码不能与旧密码相同' };
    const good = await verifyPassword(String(currentPassword || ''), user.passwordHash);
    if (!good) return { ok: false, status: 401, message: '当前密码不正确' };
    const nextHash = await hashPassword(nextPassword);
    await this.#store.updatePasswordHash(userId, nextHash);
    // tokenVersion 递增：所有已签发的 token 立即失效，必须重新登录。
    const bumped = await this.#bumpTokenVersion(userId);
    log.info('密码已修改', { userId, tokenVersion: bumped });
    return { ok: true, tokenVersion: bumped };
  }

  async #bumpTokenVersion(userId) {
    const store = this.#store;
    const user = store.getUserById(userId);
    if (!user) return 0;
    // 只有 Store 能改持久化状态，避免各处随手改内存对象导致漏落盘。
    const next = (user.tokenVersion || 0) + 1;
    await store.setTokenVersion(userId, next);
    return next;
  }

  /** 设备凭据校验：deviceId 存在、未吊销、secret 哈希匹配、且属于活跃用户。 */
  async verifyDevice(deviceId, deviceSecret) {
    if (typeof deviceId !== 'string' || typeof deviceSecret !== 'string') {
      return { ok: false, reason: 'malformed' };
    }
    const device = this.#store.getDevice(deviceId);
    if (!device) {
      // 设备不存在也走一次哈希计算，避免时间差异泄露 deviceId 是否存在。
      await verifyPassword(deviceSecret, DUMMY_PASSWORD_HASH).catch(() => false);
      return { ok: false, reason: 'unknown-device' };
    }
    if (device.revoked) return { ok: false, reason: 'revoked' };
    if (!device.tunnelEnabled) return { ok: false, reason: 'tunnel-disabled' };
    const user = this.#store.getUserById(device.userId);
    if (!user || user.disabled) return { ok: false, reason: 'owner-inactive' };
    const good = await verifyPassword(deviceSecret, device.secretHash);
    if (!good) return { ok: false, reason: 'bad-secret' };
    return { ok: true, device, user };
  }

  isDeviceAllowedFromIp(device, ip) {
    const user = this.#store.getUserById(device.userId);
    if (!user) return false;
    if (!Array.isArray(user.ipAllowlist) || user.ipAllowlist.length === 0) return true;
    // 同一份白名单同时约束「登录」和「设备上线」：后者才是真正的数据面入口，
    // 只限制登录不限制隧道等于留了后门。
    return user.ipAllowlist.some((rule) => ipMatchesRule(ip, rule));
  }

  get store() {
    return this.#store;
  }
}
