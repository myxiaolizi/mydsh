// 用户与设备的持久化层。
//
// 存储选型：单个 JSON 文件。中转服务的规模上限是「一个自建者的几台设备 + 少量访客」，
// 引入 SQLite 或 Postgres 会让宝塔上的部署步骤翻倍，而收益接近于零。代价是所有写入
// 都必须走同一把串行队列，并且落盘必须是原子的（见 util.atomicWriteFile）。
//
// 内存里维护一份 Map 作为权威读源，磁盘只是持久化副本：读路径完全不必 await，
// 鉴权这种高频操作因此不会碰磁盘。

import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import { atomicWriteFile, readJsonFile, createLogger, randomId } from './util.js';

const log = createLogger('users');

const SCHEMA_VERSION = 1;

function emptyStore() {
  return {
    version: SCHEMA_VERSION,
    users: {}, // userId -> user
    // 用户名索引单独存一份，避免每次登录 O(n) 遍历；大小写不敏感的唯一性靠这里保证。
    usernames: {}, // 规范化用户名 -> userId
    devices: {}, // deviceId -> device
  };
}

function normalizeUsername(username) {
  return String(username).trim().toLowerCase();
}

export class Store {
  #file;
  #data = emptyStore();
  #writeChain = Promise.resolve();
  #closed = false;
  #dirty = false;
  #flushTimer = null;

  constructor(file) {
    this.#file = file;
  }

  get file() {
    return this.#file;
  }

  async load() {
    const raw = await readJsonFile(this.#file, null);
    if (raw === null) {
      this.#data = emptyStore();
      await this.flush();
      log.info('用户库不存在，已初始化空库', { file: this.#file });
      return;
    }
    // 结构比版本号更重要：宁可拒绝启动，也不要在半损坏的数据上继续写，
    // 否则下一次 flush 会把可修复的问题固化成永久丢失。
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('用户库格式错误：顶层必须是对象');
    if (raw.version !== SCHEMA_VERSION) {
      throw new Error(`用户库版本 ${raw.version} 与本程序期望的 ${SCHEMA_VERSION} 不一致，请先备份并迁移`);
    }
    const data = emptyStore();
    for (const [id, user] of Object.entries(raw.users || {})) data.users[id] = user;
    for (const [name, id] of Object.entries(raw.usernames || {})) data.usernames[name] = id;
    for (const [id, device] of Object.entries(raw.devices || {})) data.devices[id] = device;
    this.#data = data;
    log.info('用户库已载入', {
      file: this.#file,
      users: Object.keys(data.users).length,
      devices: Object.keys(data.devices).length,
    });
  }

  /* ------------------------------------------------------------- 用户操作 */

  getUserById(userId) {
    return this.#data.users[userId] || null;
  }

  getUserByName(username) {
    const id = this.#data.usernames[normalizeUsername(username)];
    return id ? this.#data.users[id] || null : null;
  }

  hasUsername(username) {
    return Boolean(this.#data.usernames[normalizeUsername(username)]);
  }

  countUsers() {
    return Object.keys(this.#data.users).length;
  }

  async createUser({ username, passwordHash }) {
    const key = normalizeUsername(username);
    if (this.#data.usernames[key]) {
      const err = new Error('用户名已存在');
      err.code = 'EUSERNAME_TAKEN';
      throw err;
    }
    const user = {
      id: randomId('u_'),
      username: String(username).trim(),
      usernameKey: key,
      passwordHash,
      roles: ['user'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastLoginAt: null,
      lastLoginIp: null,
      // 口令版本号：每次改密码 +1，使已经签发的 token 全部失效。
      tokenVersion: 0,
      // 以下三个字段是扩展点：设备数上限、IP 白名单跟随用户，
      // 便于在单用户场景下不改全局配置也能收紧策略。
      deviceLimit: null,
      ipAllowlist: [],
      disabled: false,
    };
    this.#data.users[user.id] = user;
    this.#data.usernames[key] = user.id;
    await this.#persist();
    log.info('用户已创建', { userId: user.id, username: user.username });
    return user;
  }

  async touchLogin(userId, ip) {
    const user = this.#data.users[userId];
    if (!user) return;
    user.lastLoginAt = Date.now();
    user.lastLoginIp = ip || null;
    user.updatedAt = Date.now();
    await this.#persist();
  }

  async updatePasswordHash(userId, passwordHash) {
    const user = this.#data.users[userId];
    if (!user) throw new Error('用户不存在');
    user.passwordHash = passwordHash;
    user.updatedAt = Date.now();
    await this.#persist();
  }

  async setTokenVersion(userId, version) {
    const user = this.#data.users[userId];
    if (!user) throw new Error('用户不存在');
    user.tokenVersion = Number(version) || 0;
    user.updatedAt = Date.now();
    await this.#persist();
    return user;
  }

  async updateUserSettings(userId, patch) {
    const user = this.#data.users[userId];
    if (!user) throw new Error('用户不存在');
    if (patch.deviceLimit !== undefined) user.deviceLimit = patch.deviceLimit;
    if (patch.ipAllowlist !== undefined) user.ipAllowlist = patch.ipAllowlist;
    user.updatedAt = Date.now();
    await this.#persist();
    return user;
  }

  /* ------------------------------------------------------------- 设备操作 */

  getDevice(deviceId) {
    return this.#data.devices[deviceId] || null;
  }

  listDevicesOfUser(userId) {
    return Object.values(this.#data.devices)
      .filter((d) => d.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  countDevicesOfUser(userId) {
    return this.listDevicesOfUser(userId).length;
  }

  /**
   * 注册设备。deviceSecret 只在这一刻以明文返回给调用者一次；
   * 库里存的是 scrypt 哈希——即便 JSON 文件被读走，攻击者也无法冒充设备连隧道。
   */
  async createDevice({ userId, name, secretHash, limit }) {
    if (limit !== null && limit !== undefined && this.countDevicesOfUser(userId) >= limit) {
      const err = new Error(`设备数量已达上限（${limit}）`);
      err.code = 'EDEVICE_LIMIT';
      throw err;
    }
    const device = {
      id: randomId('d_').replace(/[^A-Za-z0-9_-]/g, ''),
      userId,
      name: name || '未命名设备',
      secretHash,
      createdAt: Date.now(),
      lastSeenAt: null,
      lastSeenIp: null,
      revoked: false,
      tunnelEnabled: true,
    };
    this.#data.devices[device.id] = device;
    await this.#persist();
    log.info('设备已注册', { deviceId: device.id, userId, name: device.name });
    return device;
  }

  async markDeviceSeen(deviceId, ip) {
    const device = this.#data.devices[deviceId];
    if (!device) return;
    // 心跳每次都写盘会产生大量无意义 IO：仅在时间戳跨过 60s 粒度时才落盘，
    // 内存值始终是最新的，重启后最多丢失 1 分钟的 lastSeen。
    const prev = device.lastSeenAt || 0;
    device.lastSeenAt = Date.now();
    device.lastSeenIp = ip || device.lastSeenIp;
    if (Date.now() - prev > 60_000) await this.#persist();
  }

  async updateDevice(deviceId, userId, patch) {
    const device = this.#data.devices[deviceId];
    if (!device) throw new Error('设备不存在');
    if (device.userId !== userId) throw new Error('无权操作该设备');
    if (patch.name !== undefined) device.name = patch.name;
    if (patch.tunnelEnabled !== undefined) device.tunnelEnabled = Boolean(patch.tunnelEnabled);
    if (patch.revoked !== undefined) device.revoked = Boolean(patch.revoked);
    await this.#persist();
    return device;
  }

  async deleteDevice(deviceId, userId) {
    const device = this.#data.devices[deviceId];
    if (!device) throw new Error('设备不存在');
    if (device.userId !== userId) throw new Error('无权操作该设备');
    delete this.#data.devices[deviceId];
    await this.#persist();
    log.info('设备已删除', { deviceId, userId });
    return true;
  }

  async rotateDeviceSecret(deviceId, userId, secretHash) {
    const device = this.#data.devices[deviceId];
    if (!device) throw new Error('设备不存在');
    if (device.userId !== userId) throw new Error('无权操作该设备');
    device.secretHash = secretHash;
    // 轮换等价于吊销旧凭据：把「已吊销」清掉，让新 secret 立即生效。
    device.revoked = false;
    await this.#persist();
    log.info('设备密钥已轮换', { deviceId, userId });
    return device;
  }

  /* --------------------------------------------------------------- 持久化 */

  #scheduleFlush() {
    this.#dirty = true;
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.flush().catch((err) => log.error('后台落盘失败', { error: err.message }));
    }, 250);
    if (typeof this.#flushTimer.unref === 'function') this.#flushTimer.unref();
  }

  async #persist() {
    this.#dirty = true;
    // 串行化：并发写入必须排队，否则两次 rename 的顺序不可预测，
    // 可能用较旧的内存快照覆盖较新的快照。
    this.#writeChain = this.#writeChain.then(() => this.flush()).catch((err) => {
      log.error('落盘失败', { error: err.message });
    });
    return this.#writeChain;
  }

  async flush() {
    if (this.#closed) return;
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (!this.#dirty) return;
    this.#dirty = false;
    const payload = JSON.stringify(this.#data, null, 2);
    await atomicWriteFile(this.#file, payload, 0o600);
  }

  async close() {
    this.#closed = true;
    await this.#writeChain.catch(() => {});
    await this.flush().catch(() => {});
  }

  /** 测试与优雅退出时使用：等所有挂起写入结束并强刷一次。 */
  async drain() {
    await this.#writeChain.catch(() => {});
    await this.flush();
  }
}

/* -------------------------------------------------------------- 密码与密钥 */

// scrypt 参数：N=2^15 在 1 核小机器上约 60-100ms，配合登录限流足以让离线爆破变慢，
// 又不会把登录接口变成 DoS 放大器。maxmem 必须显式给够，默认 32MB 会直接抛错。
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

function scryptAsync(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, { ...params, maxmem: SCRYPT_MAXMEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  // 参数随哈希一起存：将来调高 N 时老用户仍能登录，登录成功后可静默升级。
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;
  let key;
  try {
    key = await scryptAsync(password, salt, { N, r, p });
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(key, expected);
}

/** 登录时用户不存在也要算一次哈希，避免用响应时间枚举用户名。 */
export const DUMMY_PASSWORD_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export async function makeDeviceSecretHash(secret) {
  // 设备 secret 是 256 位随机值，本身熵已足够；这里仍用 scrypt 是因为它是
  // 「长期有效的 bearer 凭据」，一旦文件泄露哈希也不可逆推。每次隧道重连都要
  // 验一次，60ms 的代价对单个设备连接完全可以接受。
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(secret, salt, { N: 2 ** 14, r: 8, p: 1 });
  return `scrypt$${2 ** 14}$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}

export { normalizeUsername };
