/**
 * Check the agent-family endpoint and page.
 *
 * The family is read from `subagents.listDescendants`, which is the only supported way to
 * learn a session's tree: there is no parent field on a session to read, and catalogs are
 * observed and released one at a time. That makes two things worth asserting:
 *
 *  - the route uses that call rather than inventing a traversal of its own, and
 *  - a missing service or an unreadable catalog is reported as a state, not thrown at the
 *    page. A family that cannot be read is something to display, not a failed request.
 *
 * As with the title cache, the failure mode this guards is a change in shape, so the
 * assertions read the source.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const host = await readFile(join(ROOT, 'lib/index.js'), 'utf8');
const page = await readFile(join(ROOT, 'src/client/panel-fleet.js'), 'utf8');
const data = await readFile(join(ROOT, 'src/client/data.js'), 'utf8');

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

check('agents: the route defers to the subagent service', () => {
  assert.match(host, /router\.get\('\/agents\/tree'/, 'the route must exist');
  assert.match(
    host,
    /subagents\.listDescendants\(/,
    'the tree must come from the service, not a hand-rolled catalog walk',
  );
  assert.match(
    host,
    /typeof subagents\.listDescendants !== 'function'/,
    'a composition without the service must be detected before calling it',
  );
});

check('agents: an unreadable family is a state, not a thrown error', () => {
  // The try/catch must return a payload the page can render.
  assert.match(
    host,
    /reason: 'listing-failed'/,
    'a failed listing must be reported, not thrown at the page',
  );
  assert.match(
    host,
    /reason: 'no-subagent-service'/,
    'a missing service must be reported as its own reason',
  );
  // `/usage/context` still requires an id, which is correct — it names one session's
  // context. Only the family route may fall back, so the assertion is scoped to its body.
  const familyRoute = host.slice(host.indexOf("router.get('/agents/tree'"));
  assert.doesNotMatch(
    familyRoute.slice(0, familyRoute.indexOf('router.get(') + 1 || undefined),
    /sessionId is required/,
    'an omitted id falls back to the newest live agent, so it must not be rejected',
  );
});

check('agents: the root is added explicitly', () => {
  // `listDescendants` returns descendants only; the root would otherwise be missing from
  // its own family page.
  assert.match(
    host,
    /kind: 'root'/,
    'the root has no descendant entry and must be added by the route',
  );
  assert.match(
    host,
    /parentId: null/,
    'the root must be parentless so the page can anchor the tree',
  );
});

check('agents: the page never caches the family', () => {
  assert.match(
    data,
    /agentsTree:[\s\S]{0,220}?ttlMs: 0/,
    'children start and finish while the page is open, so a cached tree would be wrong',
  );
});

check('agents: the walk is cached and shared, not repeated per open', () => {
  // Each descendant costs one catalog read that decompresses a session log; a nine-child
  // family measured ~6 s. Without this the page pays that on every open.
  assert.match(host, /const AGENT_TREE_TTL = \d/, 'the walk needs an explicit TTL');
  assert.match(
    host,
    /agentTreeInFlight\.get\(rootId\)/,
    'concurrent opens must share one traversal instead of starting a second',
  );
  assert.match(
    host,
    /while \(agentTreeCache\.size > AGENT_TREE_CACHE_LIMIT\)/,
    'the cache needs a cap, or a long-lived process grows one entry per session',
  );
  assert.match(
    host,
    /finally \{[\s\S]{0,160}?agentTreeInFlight\.delete\(rootId\)/,
    'the in-flight entry must be released on every path, including failure',
  );
});

check('agents: the page tolerates a missing subject', () => {
  assert.match(
    page,
    /reason === 'no-live-session'/,
    'nothing running is a state with its own hint, not a failure banner',
  );
  assert.match(
    page,
    /members \?\? \[\]/,
    'an absent member list must not break rendering',
  );
});

console.log(`\nagent family: ${6 - failures}/6 passed`);
process.exit(failures === 0 ? 0 : 1);
