/**
 * End-to-end backup test against the real bundled 7z binary.
 *
 * The unit tests cover the engine's logic with stubs; this one proves the parts a
 * stub cannot: that the bundled binary is found by the same path resolution the
 * plugin uses, that a 7z archive is actually produced, and that a password-
 * protected archive cannot be read without the password.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error) });
  }
};

const here = fileURLToPath(new URL('.', import.meta.url));
const packageRoot = join(here, '..');

/** The same resolution the engine performs, checked independently. */
const arch = process.arch === 'ia32' ? 'x86' : 'x64';
const sevenZip = join(packageRoot, 'vendor', '7z', arch, '7za.exe');

await check('7z: the bundled binary exists for this architecture', async () => {
  const info = await stat(sevenZip);
  assert.ok(info.isFile());
  assert.ok(info.size > 500_000, `unexpected size ${info.size}`);
});

await check('7z: the bundled binary reports itself as version 7-Zip', async () => {
  const { stdout } = await run(sevenZip, ['i']);
  assert.match(stdout, /7-Zip/);
  assert.match(stdout, /\b7z\b/);
});

await check('7z: compresses a tree and restores it byte-for-byte', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mydsh-7z-'));
  try {
    const source = join(dir, 'source');
    await mkdir(join(source, 'nested', 'deeper'), { recursive: true });
    const payloads = {
      'alpha.txt': 'alpha content',
      'nested/beta.txt': 'beta content, slightly longer to exercise compression',
      'nested/deeper/gamma.txt': 'gamma',
    };
    for (const [relative, content] of Object.entries(payloads)) {
      await writeFile(join(source, relative), content, 'utf8');
    }

    const archive = join(dir, 'out.7z');
    // `a` adds, `-mx=6` is the default level the plugin requests. Entries are
    // stored relative to the wildcard's parent, which is why the engine stages
    // files into a tree and then archives `<staging>/*`.
    await run(sevenZip, ['a', '-t7z', '-mx=6', '-y', archive, join(source, '*')]);
    assert.ok((await stat(archive)).size > 0, 'archive must not be empty');

    const restored = join(dir, 'restored');
    await run(sevenZip, ['x', archive, `-o${restored}`, '-y']);

    // Paths inside the archive are relative to the staging root.
    for (const [relative, content] of Object.entries(payloads)) {
      const actual = await readFile(join(restored, relative), 'utf8');
      assert.equal(actual, content, `${relative} must survive a round trip`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await check('7z: a password-protected archive resists reads without the password', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mydsh-7z-'));
  try {
    const secret = 'top secret payload';
    const source = join(dir, 'secret.txt');
    await writeFile(source, secret, 'utf8');

    const archive = join(dir, 'locked.7z');
    // `-mhe=on` also encrypts the headers, so even the file names are hidden.
    await run(sevenZip, ['a', '-t7z', '-pcorrect-horse', '-mhe=on', '-y', archive, source]);

    // Wrong password must fail rather than yield plaintext.
    let failed = false;
    try {
      await run(sevenZip, ['x', archive, `-o${join(dir, 'wrong')}`, '-pwrong-password', '-y']);
    } catch {
      failed = true;
    }
    assert.equal(failed, true, 'a wrong password must not extract');

    // The right password must.
    await run(sevenZip, ['x', archive, `-o${join(dir, 'right')}`, '-pcorrect-horse', '-y']);
    const recovered = await readFile(join(dir, 'right', 'secret.txt'), 'utf8');
    assert.equal(recovered, secret);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await check('7z: license and notice ship beside the binary', async () => {
  const vendorDir = join(packageRoot, 'vendor', '7z');
  const names = await readdir(vendorDir);
  assert.ok(names.includes('License.txt'), 'the GPL text must ship with the binary');
  const license = await readFile(join(vendorDir, 'License.txt'), 'utf8');
  assert.match(license, /GNU|7-Zip/i);
});

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : `\n        ${result.error}`}`);
}
console.log(`\n7z e2e: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
