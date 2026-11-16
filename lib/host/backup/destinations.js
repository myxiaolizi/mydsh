/**
 * Backup destinations.
 *
 * A destination answers three questions: can it accept this archive, where does
 * the copy live, and can it still hold the requested number of copies? Retention
 * runs after upload rather than before, so a failed upload never deletes the last
 * good copy.
 *
 * All three destinations share one interface, which is what lets the engine stay
 * destination-agnostic and the UI list them uniformly.
 */
import { mkdir, readdir, stat, unlink, copyFile, rename, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash, createHmac } from 'node:crypto';

/**
 * Local filesystem destination.
 *
 * The safest default: no network, no credentials, and a copy the user can find
 * with their own file manager.
 */
export class LocalDestination {
  kind = 'local';
  #directory;
  #keepCopies;

  constructor({ directory, keepCopies = 7 }) {
    this.#directory = directory;
    this.#keepCopies = keepCopies;
  }

  async ready() {
    if (typeof this.#directory !== 'string' || this.#directory.trim() === '') {
      return { ok: false, reason: 'no-directory' };
    }
    try {
      await mkdir(this.#directory, { recursive: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: 'unwritable', detail: String(error?.message ?? error) };
    }
  }

  async put(file) {
    const target = join(this.#directory, basename(file));
    // Copy then rename: a half-copied archive never appears under its final name.
    const temporary = `${target}.partial`;
    await copyFile(file, temporary);
    await rename(temporary, target);
    return { location: target, bytes: (await stat(target)).size };
  }

  async list() {
    const names = await readdir(this.#directory).catch(() => []);
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.zip') && !name.endsWith('.7z')) continue;
      const full = join(this.#directory, name);
      const info = await stat(full).catch(() => undefined);
      if (info?.isFile() === true) out.push({ name, path: full, bytes: info.size, at: info.mtimeMs });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  async prune(keep) {
    const copies = await this.list();
    const limit = Number.isFinite(keep) ? keep : this.#keepCopies;
    const removed = [];
    for (const copy of copies.slice(limit)) {
      await unlink(copy.path).catch(() => {});
      removed.push(copy.path);
    }
    return removed;
  }
}

/**
 * WebDAV destination.
 *
 * Implemented against plain HTTP verbs so it works with Nextcloud, Synology,
 * Jianguoyun, and most NAS appliances without a vendor SDK.
 */
export class WebdavDestination {
  kind = 'webdav';
  #url;
  #username;
  #password;
  #directory;
  #keepCopies;

  constructor({ url, username, password, directory = 'mydsh', keepCopies = 7 }) {
    this.#url = typeof url === 'string' ? url.replace(/\/+$/, '') : '';
    this.#username = username;
    this.#password = password;
    this.#directory = directory;
    this.#keepCopies = keepCopies;
  }

  #authHeader() {
    if (this.#username === undefined || this.#password === undefined) return {};
    const token = Buffer.from(`${this.#username}:${this.#password}`, 'utf8').toString('base64');
    return { authorization: `Basic ${token}` };
  }

  #target(name) {
    return `${this.#url}/${this.#directory}${name === undefined ? '' : `/${encodeURIComponent(name)}`}`;
  }

  async ready() {
    if (this.#url === '') return { ok: false, reason: 'no-url' };
    try {
      // MKCOL is idempotent enough for this purpose: 405 means it already exists.
      const response = await fetch(this.#target(), { method: 'MKCOL', headers: this.#authHeader() });
      if (response.ok || response.status === 405) return { ok: true };
      return { ok: false, reason: 'http-status', detail: String(response.status) };
    } catch (error) {
      return { ok: false, reason: 'unreachable', detail: String(error?.message ?? error) };
    }
  }

  async put(file) {
    const info = await stat(file);
    const body = await readFile(file);
    const response = await fetch(this.#target(basename(file)), {
      method: 'PUT',
      headers: {
        ...this.#authHeader(),
        'content-type': 'application/octet-stream',
        'content-length': String(info.size),
      },
      body,
    });
    if (!response.ok) throw new Error(`WebDAV upload failed: ${response.status} ${response.statusText}`);
    return { location: this.#target(basename(file)), bytes: info.size };
  }

  async list() {
    const response = await fetch(this.#target(), {
      method: 'PROPFIND',
      headers: { ...this.#authHeader(), depth: '1', 'content-type': 'application/xml' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>',
    });
    if (!response.ok) return [];
    const text = await response.text();
    const out = [];
    // A tolerant scan beats an XML parser here: the response shape differs per
    // server, and only the href and length of archive files matter.
    const blocks = text.split(/<d:response[\s>]/i).slice(1);
    for (const block of blocks) {
      const href = /<d:href>([^<]+)<\/d:href>/i.exec(block)?.[1];
      if (href === undefined) continue;
      const name = decodeURIComponent(href.split('/').filter(Boolean).pop() ?? '');
      if (!name.endsWith('.zip') && !name.endsWith('.7z')) continue;
      const length = Number(/<d:getcontentlength>(\d+)</i.exec(block)?.[1] ?? 0);
      const modified = /<d:getlastmodified>([^<]+)</i.exec(block)?.[1];
      out.push({ name, path: href, bytes: length, at: modified === undefined ? 0 : Date.parse(modified) });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  async prune(keep) {
    const copies = await this.list();
    const limit = Number.isFinite(keep) ? keep : this.#keepCopies;
    const removed = [];
    for (const copy of copies.slice(limit)) {
      const target = copy.path.startsWith('http') ? copy.path : `${this.#url}${copy.path}`;
      const response = await fetch(target, { method: 'DELETE', headers: this.#authHeader() });
      if (response.ok || response.status === 404) removed.push(copy.name);
    }
    return removed;
  }
}

/**
 * Aliyun OSS destination.
 *
 * Signed with the V1 header scheme OSS documents, computed locally so the plugin
 * needs no SDK. Only what a backup job uses is implemented: PUT, a bucket
 * listing, and DELETE.
 */
export class OssDestination {
  kind = 'oss';
  #bucket;
  #endpoint;
  #accessKeyId;
  #accessKeySecret;
  #prefix;
  #keepCopies;

  constructor({ bucket, endpoint, accessKeyId, accessKeySecret, prefix = 'Agent/mydsh', keepCopies = 7 }) {
    this.#bucket = bucket;
    this.#endpoint = typeof endpoint === 'string' ? endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '') : '';
    this.#accessKeyId = accessKeyId;
    this.#accessKeySecret = accessKeySecret;
    this.#prefix = String(prefix ?? '').replace(/^\/+|\/+$/g, '');
    this.#keepCopies = keepCopies;
  }

  #host() {
    return `${this.#bucket}.${this.#endpoint}`;
  }

  #key(name) {
    return this.#prefix === '' ? name : `${this.#prefix}/${name}`;
  }

  /** OSS V1 signature: method, content-md5, type, date, canonicalized resource. */
  #sign(method, contentMd5, contentType, date, resource) {
    const text = `${method}\n${contentMd5}\n${contentType}\n${date}\n${resource}`;
    return createHmac('sha1', this.#accessKeySecret).update(text, 'utf8').digest('base64');
  }

  #headers(method, objectKey, contentType = '', contentMd5 = '') {
    const date = new Date().toUTCString();
    const resource = `/${this.#bucket}/${objectKey}`;
    return {
      date,
      'content-type': contentType,
      'content-md5': contentMd5,
      authorization: `OSS ${this.#accessKeyId}:${this.#sign(method, contentMd5, contentType, date, resource)}`,
    };
  }

  async ready() {
    if (this.#bucket === '' || this.#endpoint === '') return { ok: false, reason: 'not-configured' };
    if (this.#accessKeyId === undefined || this.#accessKeySecret === undefined) {
      return { ok: false, reason: 'no-credentials' };
    }
    try {
      const response = await fetch(`https://${this.#host()}/?prefix=${encodeURIComponent(`${this.#prefix}/`)}&max-keys=1`, {
        headers: this.#headers('GET', ''),
      });
      if (response.ok) return { ok: true };
      return { ok: false, reason: 'http-status', detail: String(response.status) };
    } catch (error) {
      return { ok: false, reason: 'unreachable', detail: String(error?.message ?? error) };
    }
  }

  async put(file) {
    const info = await stat(file);
    const body = await readFile(file);
    const md5 = createHash('md5').update(body).digest('base64');
    const key = this.#key(basename(file));
    const response = await fetch(`https://${this.#host()}/${key}`, {
      method: 'PUT',
      headers: { ...this.#headers('PUT', key, 'application/octet-stream', md5), 'content-length': String(info.size) },
      body,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`OSS upload failed: ${response.status} ${detail.slice(0, 200)}`);
    }
    return { location: `oss://${this.#bucket}/${key}`, bytes: info.size };
  }

  async list() {
    const response = await fetch(`https://${this.#host()}/?prefix=${encodeURIComponent(`${this.#prefix}/`)}&max-keys=200`, {
      headers: this.#headers('GET', ''),
    });
    if (!response.ok) return [];
    const text = await response.text();
    const out = [];
    const pattern = /<Contents>([\s\S]*?)<\/Contents>/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const block = match[1];
      const key = /<Key>([^<]+)<\/Key>/.exec(block)?.[1];
      if (key === undefined) continue;
      const size = Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? 0);
      const modified = /<LastModified>([^<]+)<\/LastModified>/.exec(block)?.[1];
      const relativeKey = this.#prefix === '' ? key : key.slice(this.#prefix.length + 1);
      out.push({
        name: relativeKey,
        path: key,
        bytes: size,
        at: modified === undefined ? 0 : Date.parse(modified),
      });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  async prune(keep) {
    const copies = await this.list();
    const limit = Number.isFinite(keep) ? keep : this.#keepCopies;
    const removed = [];
    for (const copy of copies.slice(limit)) {
      const response = await fetch(`https://${this.#host()}/${copy.path}`, {
        method: 'DELETE',
        headers: this.#headers('DELETE', copy.path),
      });
      if (response.ok || response.status === 404) removed.push(copy.name);
    }
    return removed;
  }
}

/**
 * What each destination kind needs before it can accept an archive.
 *
 * This exists because a destination could be saved half-configured and the failure only
 * surfaced at run time as `webdav:no-url` — which tells a user nothing about what to fill in.
 * Naming the missing fields at save time, and again in the run error, turns an opaque failure
 * into an instruction.
 */
const REQUIRED_FIELDS = Object.freeze({
  webdav: [
    { key: 'url', label: 'server-url' },
  ],
  oss: [
    { key: 'bucket', label: 'bucket' },
    { key: 'endpoint', label: 'endpoint' },
  ],
  local: [
    { key: 'directory', label: 'folder' },
  ],
});

/**
 * List the required fields a destination config is still missing.
 *
 * Returns keys a caller can translate; an empty array means "nothing missing". An unknown
 * kind is reported as missing its whole field set rather than silently accepted, because a
 * typo in `kind` would otherwise fall through to the local destination and write somewhere
 * the user did not choose.
 */
export function missingDestinationFields(config) {
  const kind = typeof config?.kind === 'string' ? config.kind : 'local';
  const required = REQUIRED_FIELDS[kind];
  if (required === undefined) return [{ key: 'kind', label: 'type' }];
  return required.filter((field) => {
    const value = config?.[field.key];
    return typeof value !== 'string' || value.trim() === '';
  });
}

/** Build a destination from its persisted config plus resolved secrets. */
export function destinationFrom(config, secrets = {}) {  switch (config?.kind) {
    case 'webdav':
      return new WebdavDestination({
        url: config.url,
        username: secrets.username,
        password: secrets.password,
        directory: config.directory,
        keepCopies: config.keepCopies,
      });
    case 'oss':
      return new OssDestination({
        bucket: config.bucket,
        endpoint: config.endpoint,
        accessKeyId: secrets.accessKeyId,
        accessKeySecret: secrets.accessKeySecret,
        prefix: config.prefix,
        keepCopies: config.keepCopies,
      });
    case 'local':
    default:
      return new LocalDestination({ directory: config?.directory, keepCopies: config?.keepCopies });
  }
}
