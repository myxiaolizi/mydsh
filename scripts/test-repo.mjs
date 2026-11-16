/**
 * Check that the repository is self-sufficient.
 *
 * Two release-blocking defects got past every other test because they only appear
 * outside this working tree, where files happen to exist already:
 *
 *   - `esbuild` was never declared, so `npm install` on a clone installed nothing and
 *     the build failed with a module-not-found error.
 *   - `.gitignore` excluded the whole of `lib/`, but only `lib/client.js` is generated —
 *     `lib/index.js` and `lib/host/` are hand-written source. A clone had no Host half at
 *     all and seven suites failed.
 *
 * Both are invisible from inside a working tree that already has `node_modules` and an
 * ignored-but-present `lib/`. This inspects what Git would actually ship.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}\n        ${error.message}`);
  }
};

// Every file Git tracks, as POSIX paths.
const tracked = git('ls-files').split('\n').filter(Boolean);

check('repo: the Host entry point is tracked', () => {
  assert.ok(tracked.includes('lib/index.js'), 'lib/index.js must be committed: it is the Host entry, not a build artifact');
});

check('repo: every Host module is tracked', () => {
  const host = tracked.filter((path) => path.startsWith('lib/host/') && path.endsWith('.js'));
  // The count is asserted loosely, but the important part is that it is not zero and that
  // the directories with logic are all present.
  assert.ok(host.length >= 15, `expected the Host modules to be committed, found ${host.length}`);
  for (const required of [
    'lib/host/settings.js',
    'lib/host/settings-meta.js',
    'lib/host/api.js',
    'lib/host/util.js',
    'lib/host/usage/store.js',
    'lib/host/backup/engine.js',
    'lib/host/retry/engine.js',
    'lib/host/remote/tunnel.js',
  ]) {
    assert.ok(host.includes(required), `${required} is missing from the repository`);
  }
});

check('repo: the generated client bundle is not tracked', () => {
  // Committing it would make every source edit produce a bundle diff nobody reviews, and
  // a stale bundle would silently override a fixed source tree.
  assert.ok(!tracked.includes('lib/client.js'), 'lib/client.js is generated and must stay out of Git');
});

check('repo: the build dependency is declared', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const declared = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
  };
  assert.ok(declared.esbuild !== undefined, 'esbuild must be declared, or a clone cannot build');
});

check('repo: the lockfile is committed so installs are reproducible', () => {
  // It was ignored while the dependency was undeclared, so `npm install` resolved nothing.
  assert.ok(tracked.includes('package-lock.json'), 'package-lock.json must be committed');
});

check('repo: the relay server ships with the plugin', () => {
  // The remote-access feature is half a feature without it, and `APP/Re/` is not published.
  for (const required of [
    'relay/package.json',
    'relay/relay.config.example.json',
    'relay/src/server.js',
    'relay/src/tunnel.js',
    'relay/src/auth.js',
  ]) {
    assert.ok(tracked.includes(required), `${required} is missing: the relay would not ship`);
  }
});

check('repo: the relay declares no external dependencies', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'relay/package.json'), 'utf8'));
  const deps = Object.keys(manifest.dependencies ?? {});
  assert.deepEqual(deps, [], `the relay must stay dependency-free, found ${deps.join(', ')}`);
});

check('repo: no credential-looking file is tracked', () => {
  const suspicious = tracked.filter((path) => {
    const name = path.split('/').pop();
    return name === '.env' || name === '.env.local' || name.endsWith('.local.env') ||
      name.endsWith('signing.key') || name === 'relay.config.json';
  });
  assert.deepEqual(suspicious, [], `these must not be committed: ${suspicious.join(', ')}`);
});

console.log(`\nrepo targets: ${8 - failures}/8 passed`);
process.exit(failures === 0 ? 0 : 1);
