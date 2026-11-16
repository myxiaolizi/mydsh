/**
 * Check that the session-usage endpoint stays cheap.
 *
 * The endpoint once took 20 s because it read and decompressed one session log per row to
 * recover titles. Titles are now cached outside the request path: a request reads the cache
 * and nothing else, and the cache is warmed in the background.
 *
 * This asserts that structure from the source rather than by timing a running Host, because
 * the failure mode is a regression in shape — someone re-adding `await` on the title reader
 * — and that is visible without a benchmark. Timing is checked separately against the live
 * Host in `README/03_deploy.md`.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const source = await readFile(join(ROOT, 'lib/index.js'), 'utf8');

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

check('sessions: a request never blocks on a title read', () => {
  assert.match(
    source,
    /const titles = cachedTitles\(ids\)/,
    'the route must read the cache instead of calling the reader',
  );
  assert.doesNotMatch(
    source,
    /await titlesFor\(/,
    'no request may await a title lookup: that is what made latency scale with the row count',
  );
  assert.doesNotMatch(
    source,
    /await prewarmTitles\(/,
    'warming the cache must not be awaited by the request',
  );
  assert.match(
    source,
    /void prewarmTitles\(/,
    'the cache must be warmed without blocking the response',
  );
});

check('sessions: the title cache is bounded', () => {
  assert.match(source, /const TITLE_CACHE_LIMIT = \d+/, 'the cache needs an explicit cap');
  assert.match(
    source,
    /while \(titleCache\.size > TITLE_CACHE_LIMIT\)/,
    'the cap must be enforced on insert, or a long-lived process grows without bound',
  );
});

check('sessions: a missing title is null, not a crash', () => {
  assert.match(
    source,
    /row\.title = titles\.get\(row\.sessionId\) \?\? null/,
    'an unknown title must resolve to null so the panel can fall back to the id',
  );
});

check('sessions: only one background warm runs at a time', () => {
  assert.match(source, /if \(prewarming\) return;/, 'concurrent warms would duplicate every read');
  assert.match(source, /prewarming = false;/, 'the guard must be released even on failure');
});

check('sessions: the reader is still reachable for warming', () => {
  // Removing the lookup entirely would leave every row permanently untitled.
  assert.match(source, /readTitleSnapshots/, 'titles must still be readable somewhere');
});

console.log(`\nsession titles: ${5 - failures}/5 passed`);
process.exit(failures === 0 ? 0 : 1);
