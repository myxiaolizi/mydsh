/**
 * Check that the toolbox switches actually do something.
 *
 * The settings page has offered nine module switches since the first release and none of them
 * was read by either half: they were labels for capabilities expected from other plugins. This
 * suite asserts the properties that make a switch meaningful:
 *
 *  - every declared module is either implemented here or reports why it cannot be
 *  - an implemented module reaches a real Host registration (prompt context, tools, route)
 *  - memory round-trips through its own store, including the cap and the dedupe
 *  - switching a module off actually stops its effect
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { MemoryStore, normalizeNote, matchesQuery, MEMORY_LIMITS } = await import(
  '../lib/host/toolbox/memory.js'
);
const { TOOLBOX_REGISTRY, availableModules, puaPromptText } = await import(
  '../lib/host/toolbox/index.js'
);

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}\n        ${error.message}`);
  }
};

/** A store over a temp file, with in-memory JSON so a test never touches the real profile. */
async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), 'mydsh-memory-'));
  let saved;
  const store = new MemoryStore({
    file: join(dir, 'memory.json'),
    readJson: async () => saved,
    writeJson: async (_file, value) => { saved = JSON.parse(JSON.stringify(value)); },
    logger: () => {},
  });
  return { store, dir, saved: () => saved };
}

await check('toolbox: every declared module is either implemented or says why not', () => {
  const keys = Object.keys(TOOLBOX_REGISTRY);
  assert.ok(keys.length >= 9, `expected the nine shipped modules, saw ${keys.length}`);
  for (const key of keys) {
    const entry = TOOLBOX_REGISTRY[key];
    if (entry.available === true) {
      assert.ok(typeof entry.kind === 'string' && entry.kind !== '', `${key} must say how it is implemented`);
    } else {
      // An unavailable module must carry a reason the panel can translate; a bare `false`
      // would leave the UI with nothing to say.
      assert.equal(entry.available, false);
      assert.ok(typeof entry.reason === 'string' && entry.reason !== '', `${key} must explain why it is unavailable`);
    }
  }
});

await check('toolbox: the implemented set excludes what cannot be built here', () => {
  const available = availableModules();
  // These three need a service this plugin does not ship; offering a switch for them would be
  // the original bug in a new place.
  for (const key of ['agencyAgents', 'imageGen', 'windowsMcp']) {
    assert.equal(available.includes(key), false, `${key} cannot be implemented here`);
    assert.equal(TOOLBOX_REGISTRY[key].available, false);
  }
  // These are implemented against Host services.
  for (const key of ['memory', 'pua', 'configManager', 'skillExplorer', 'mcpConnector']) {
    assert.equal(available.includes(key), true, `${key} should be available`);
  }
});

await check('toolbox: memory stores, dedupes, and reports its cap', async () => {
  const { store, dir } = await makeStore();
  try {
    const first = await store.add({ text: 'Prefers Chinese replies', tags: ['lang'] });
    assert.equal(first.ok, true);
    assert.equal(first.count, 1);

    // The same text restated is one fact, not two.
    const again = await store.add({ text: 'Prefers Chinese replies', tags: ['lang', 'tone'] });
    assert.equal(again.ok, true);
    assert.equal(again.replaced, true);
    assert.equal(again.count, 1, 'a restated fact must not spend the cap twice');
    assert.deepEqual(again.note.tags, ['lang', 'tone'], 'tags are updated on replace');

    const other = await store.add({ text: 'Runs Windows 11' });
    assert.equal(other.count, 2);

    const all = await store.list();
    assert.equal(all.length, 2);
    assert.equal((await store.list('windows')).length, 1, 'search is case-insensitive');
    assert.equal((await store.list('lang')).length, 1, 'search covers tags');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await check('toolbox: memory enforces its limits instead of failing silently', async () => {
  const { store, dir } = await makeStore();
  try {
    const empty = await store.add({ text: '   ' });
    assert.equal(empty.ok, false);
    assert.equal(empty.reason, 'empty');

    const long = await store.add({ text: 'x'.repeat(MEMORY_LIMITS.MAX_NOTE_CHARS + 1) });
    assert.equal(long.ok, false);
    assert.equal(long.reason, 'too-long');

    // Fill to the cap, then confirm the next write is refused with a reason the model can act
    // on (rather than dropped, which would lose what the user asked to keep).
    for (let index = 0; index < MEMORY_LIMITS.MAX_NOTES; index += 1) {
      const result = await store.add({ text: `fact ${index}` });
      assert.equal(result.ok, true, `failed at ${index}`);
    }
    const over = await store.add({ text: 'one too many' });
    assert.equal(over.ok, false);
    assert.equal(over.reason, 'full');
    assert.equal(over.limit, MEMORY_LIMITS.MAX_NOTES);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await check('toolbox: memory survives a reload and can be pruned', async () => {
  const { store, dir, saved } = await makeStore();
  try {
    await store.add({ text: 'Uses pnpm, not npm' });
    await store.add({ text: 'Projects live under C:/Data' });

    // A second store over the same persisted payload must read the same notes back.
    const reopened = new MemoryStore({
      file: join(dir, 'memory.json'),
      readJson: async () => saved(),
      writeJson: async () => {},
      logger: () => {},
    });
    const notes = await reopened.list();
    assert.equal(notes.length, 2, 'notes must round-trip through the file');
    assert.ok(notes.some((note) => note.text === 'Uses pnpm, not npm'));

    const removed = await reopened.remove('pnpm');
    assert.equal(removed.ok, true);
    assert.equal(removed.removed, 1);
    assert.equal((await reopened.list()).length, 1);

    // An empty query must not wipe the store.
    const noop = await reopened.remove('   ');
    assert.equal(noop.ok, false);
    assert.equal(noop.reason, 'empty-query');
    assert.equal((await reopened.list()).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await check('toolbox: the prompt text is synchronous and reflects the notes', async () => {
  const { store, dir } = await makeStore();
  try {
    // Before anything is stored there is nothing to say; the Host injects an empty string.
    assert.equal(store.cachedPromptText(), '');

    await store.add({ text: 'Prefers short answers', tags: ['style'] });
    const text = store.cachedPromptText();
    assert.match(text, /Prefers short answers/);
    assert.match(text, /style/, 'tags belong in the injected text');
    assert.match(text, /standing/i, 'the block must frame itself as context, not instructions');

    // Mutation must refresh the cache: the Host's provider cannot await the store.
    await store.add({ text: 'Works in Asia/Shanghai' });
    assert.match(store.cachedPromptText(), /Asia\/Shanghai/);

    await store.remove('short answers');
    assert.doesNotMatch(store.cachedPromptText(), /Prefers short answers/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await check('toolbox: note normalization rejects junk without throwing', () => {
  assert.equal(normalizeNote(undefined).ok, false);
  assert.equal(normalizeNote({ text: 42 }).ok, false, 'non-string text is not a note');
  assert.equal(normalizeNote({ text: 'ok', tags: 'not-an-array' }).ok, true);
  assert.deepEqual(normalizeNote({ text: 'ok', tags: 'nope' }).note.tags, []);

  const tagged = normalizeNote({ text: ' keep ', tags: ['a', 'a', '  ', 7] });
  assert.equal(tagged.ok, true);
  assert.equal(tagged.note.text, 'keep', 'text is trimmed');
  assert.deepEqual(tagged.note.tags, ['a'], 'tags are deduped, trimmed, and filtered to strings');

  assert.equal(matchesQuery({ text: 'ABC', tags: [] }, ''), true, 'an empty query matches everything');
  assert.equal(matchesQuery({ text: 'ABC', tags: [] }, 'abc'), true);
  assert.equal(matchesQuery({ text: 'ABC', tags: [] }, 'zzz'), false);
});

await check('toolbox: prompt refinement is inert boilerplate only when asked', () => {
  const text = puaPromptText();
  assert.ok(text.length > 40, 'the section must say something substantive');
  assert.match(text, /restate/i, 'its job is to make the model restate a vague request');
  assert.match(text, /do not restate requests that are/i, 'and it must exclude already-precise ones');
});

/** The Host wiring: each implemented module must reach a real registration. */
const { readFile } = await import('node:fs/promises');
const hostIndex = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
const toolboxIndex = await readFile(new URL('../lib/host/toolbox/index.js', import.meta.url), 'utf8');

await check('toolbox: memory reaches the Host through a prompt context and tools', () => {
  assert.match(toolboxIndex, /systemPrompt\.context\(\{/, 'memory must register real prompt context');
  assert.match(toolboxIndex, /name: MEMORY_CONTEXT_NAME/, 'under a stable, shared name');
  assert.match(toolboxIndex, /mydsh_remember/, 'and expose a write tool');
  assert.match(toolboxIndex, /mydsh_recall/, 'a read tool');
  assert.match(toolboxIndex, /mydsh_forget/, 'and a prune tool');
  // Each tool must refuse when the module is off, or the switch would not be a switch.
  const saves = toolboxIndex.match(/module-off/g) ?? [];
  assert.ok(saves.length >= 3, 'every memory tool checks the module switch');
});

await check('toolbox: the switches are read, not merely stored', () => {
  // The original bug in one line: the booleans existed and nothing consumed them.
  assert.match(toolboxIndex, /function moduleOn|const moduleOn/, 'a synchronous reader must exist');
  assert.match(toolboxIndex, /liveConfig/, 'and a cached configuration for the sync prompt providers');
  assert.match(toolboxIndex, /settings\/document-updated/, 'refreshed when the settings change');
  assert.match(hostIndex, /installToolbox\(/, 'the installer must actually run');
  assert.match(hostIndex, /router\.get\('\/toolbox\/memory'/, 'memory content needs a read route');
  assert.match(hostIndex, /router\.post\('\/toolbox\/memory'/, 'and a write route');
  assert.match(hostIndex, /registry: TOOLBOX_REGISTRY/, 'the panel needs the registry to tell truth from label');
});

console.log(`\ntoolbox: ${10 - failures}/10 passed`);
process.exit(failures === 0 ? 0 : 1);
