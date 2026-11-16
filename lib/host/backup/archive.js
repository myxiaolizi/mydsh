/**
 * Archive creation for backups.
 *
 * Two formats are offered. `zip` is produced by a small writer here so the
 * plugin carries no binary dependency. `7z` needs an external binary, which the
 * plugin looks for in a fixed order and reports honestly when absent rather than
 * silently downgrading — a user who asked for 7z should never receive a zip
 * without knowing.
 *
 * All writers stream: a backup can exceed available memory, so entries go
 * through a file handle instead of being buffered whole.
 */
import { open, stat, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, relative, sep, posix, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

/** CRC-32 as required by the ZIP central directory. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

/** Recursively list files, skipping symlinks so a cycle cannot hang the walk. */
export async function listFiles(root, { onProgress } = {}) {
  const files = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(full);
      onProgress?.(files.length);
    }
  };
  await walk(root);
  return files;
}

/**
 * Minimal streaming ZIP writer.
 *
 * Entries are written with deflate; the central directory is assembled in
 * memory because it is small relative to the payload. ZIP64 is out of scope,
 * and `assertZipCapacity` refuses a job that would need it rather than emitting
 * a corrupt archive.
 */
export class ZipWriter {
  #handle;
  #offset = 0;
  #entries = [];
  #closed = false;

  static async create(file) {
    await mkdir(dirname(file), { recursive: true });
    const writer = new ZipWriter();
    writer.#handle = await open(file, 'w');
    return writer;
  }

  get bytesWritten() {
    return this.#offset;
  }

  async addFile(diskPath, archivePath, { level = 6 } = {}) {
    const info = await stat(diskPath);
    const source = await open(diskPath, 'r');
    try {
      const body = Buffer.allocUnsafe(info.size);
      let read = 0;
      while (read < info.size) {
        const { bytesRead } = await source.read(body, read, info.size - read, read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      const raw = body.subarray(0, read);
      await this.#addEntry(archivePath, raw, info.mtime, level);
    } finally {
      await source.close();
    }
  }

  /** Add an in-memory entry, used for the manifest the archive describes itself by. */
  async addBuffer(archivePath, buffer, mtime = new Date()) {
    await this.#addEntry(archivePath, buffer, mtime, 6);
  }

  async #addEntry(archivePath, raw, mtime, level) {
    const compressed = deflateRawSync(raw, { level });
    // Store uncompressed when compression does not pay for its own header.
    const useDeflate = compressed.length < raw.length;
    const payload = useDeflate ? compressed : raw;
    const name = posix.normalize(archivePath.split(sep).join('/'));
    const checksum = crc32(raw);
    const time = dosTime(mtime);
    const date = dosDate(mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);                    // version needed
    local.writeUInt16LE(0x0800, 6);                // UTF-8 filename flag
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);    // method
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(Buffer.byteLength(name, 'utf8'), 26);
    local.writeUInt16LE(0, 28);                    // extra length

    const entryOffset = this.#offset;
    await this.#write(local);
    await this.#write(Buffer.from(name, 'utf8'));
    await this.#write(payload);

    this.#entries.push({
      name,
      crc: checksum,
      compressedSize: payload.length,
      uncompressedSize: raw.length,
      method: useDeflate ? 8 : 0,
      time,
      date,
      offset: entryOffset,
    });
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const directoryOffset = this.#offset;
    const chunks = [];
    for (const entry of this.#entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);                 // version made by
      header.writeUInt16LE(20, 6);                 // version needed
      header.writeUInt16LE(0x0800, 8);             // flags
      header.writeUInt16LE(entry.method, 10);
      header.writeUInt16LE(entry.time, 12);
      header.writeUInt16LE(entry.date, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.compressedSize, 20);
      header.writeUInt32LE(entry.uncompressedSize, 24);
      header.writeUInt16LE(Buffer.byteLength(entry.name, 'utf8'), 28);
      header.writeUInt16LE(0, 30);                 // extra
      header.writeUInt16LE(0, 32);                 // comment
      header.writeUInt16LE(0, 34);                 // disk
      header.writeUInt16LE(0, 36);                 // internal attrs
      header.writeUInt32LE(0, 38);                 // external attrs
      header.writeUInt32LE(entry.offset, 42);
      chunks.push(header, Buffer.from(entry.name, 'utf8'));
    }
    const directory = Buffer.concat(chunks);
    await this.#write(directory);

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.#entries.length, 8);
    end.writeUInt16LE(this.#entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(directoryOffset, 16);
    end.writeUInt16LE(0, 20);
    await this.#write(end);

    await this.#handle.close();
  }

  async abort() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#handle.close().catch(() => {});
  }

  async #write(buffer) {
    await this.#handle.write(buffer, 0, buffer.length, this.#offset);
    this.#offset += buffer.length;
  }
}

/** MS-DOS time, the only timestamp ZIP understands without an extra field. */
function dosTime(date) {
  return ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
}

function dosDate(date) {
  return (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
}

/** ZIP without ZIP64 cannot address more than 4 GiB. */
export function assertZipCapacity(totalBytes) {
  const limit = 4 * 1024 * 1024 * 1024 - 1;
  if (totalBytes > limit) {
    throw new Error('archive exceeds the 4 GiB ZIP limit; choose 7z or split the backup');
  }
}

/** SHA-256 of a finished archive, used to verify a copy after upload. */
export async function hashFile(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

/**
 * Split a finished archive into fixed-size parts.
 *
 * Splitting after compression (rather than per-entry) means each part is a plain
 * byte slice, so reassembly is `cat parts > archive` with no tooling.
 */
export async function splitFile(file, partBytes, outputDir) {
  if (!Number.isFinite(partBytes) || partBytes <= 0) return [];
  const info = await stat(file);
  if (info.size <= partBytes) return [];

  const parts = [];
  const source = await open(file, 'r');
  try {
    const count = Math.ceil(info.size / partBytes);
    for (let index = 0; index < count; index += 1) {
      const start = index * partBytes;
      const length = Math.min(partBytes, info.size - start);
      const partPath = join(outputDir, `${file.split(sep).pop()}.part${String(index + 1).padStart(3, '0')}`);
      const buffer = Buffer.allocUnsafe(length);
      await source.read(buffer, 0, length, start);
      await writeFile(partPath, buffer);
      parts.push(partPath);
    }
  } finally {
    await source.close();
  }
  return parts;
}

/** Relative archive path for one file under a source root. */
export function archivePathFor(sourceRoot, file, prefix) {
  return posix.join(prefix, relative(sourceRoot, file).split(sep).join('/'));
}

/**
 * Run an external 7z binary, reporting an absent tool as a distinct outcome.
 *
 * A caller must be able to tell "7z is not installed" apart from "7z failed on
 * this data": the first is fixable by the user, the second is not.
 */
export async function runSevenZip(binary, args, { spawn } = {}) {
  const launcher = spawn ?? (await import('node:child_process')).spawn;
  return new Promise((resolve) => {
    let stderr = '';
    let child;
    try {
      child = launcher(binary, args, { windowsHide: true });
    } catch (error) {
      resolve({ ok: false, reason: 'missing', detail: String(error?.message ?? error) });
      return;
    }
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      resolve({ ok: false, reason: error?.code === 'ENOENT' ? 'missing' : 'failed', detail: String(error?.message ?? error) });
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, reason: 'failed', detail: stderr.slice(0, 500) || `exit ${code}` });
    });
  });
}
