/**
 * Check automatic turn continuation.
 *
 * This feature sends messages to a live agent without the user asking, using a real budget,
 * so the tests focus on the guard rails rather than the happy path: every rule that stops a
 * continuation is a rule that keeps an unattended session from talking to itself.
 *
 * The decision function is pure, so the policy is tested directly. The engine is driven with
 * a fake clock, fake timers, and fake agents so a test never waits or spends anything.
 */
import assert from 'node:assert/strict';

const { AutoContinueEngine, shouldResume, cooldownFor, continuationMessage } = await import(
  '../lib/host/retry/auto-continue.js'
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

const BASE = {
  enabled: true,
  autoContinue: true,
  maxConsecutive: 3,
  cooldownMs: 45_000,
  maxCooldownMs: 120_000,
  backoffFactor: 2,
  resumeCompletedTurns: false,
  resumeSubagents: false,
};

await check('continuation: a turn the user stopped is never resumed', () => {
  // `aborted` means the user pressed stop. Continuing it would fight them.
  for (const kind of ['aborted', 'blocked', 'forked']) {
    const decision = shouldResume({ reason: kind, config: BASE, attempts: 0, now: 0 });
    assert.equal(decision.resume, false, `${kind} must not be resumed`);
    assert.match(decision.why, /^final:/);
  }
});

await check('continuation: a completed turn is opt-in only', () => {
  // Continuing a finished answer is an autonomous loop, not error recovery. Off by default
  // because it turns every normal answer into another turn.
  const off = shouldResume({ reason: 'completed', config: BASE, attempts: 0, now: 0 });
  assert.equal(off.resume, false);
  assert.equal(off.why, 'completed-not-opted-in');

  const on = shouldResume({
    reason: 'completed',
    config: { ...BASE, resumeCompletedTurns: true },
    attempts: 0,
    now: 0,
  });
  assert.equal(on.resume, true, 'the explicit opt-in must be honoured');
});

await check('continuation: the failures that leave a conversation hanging are resumed', () => {
  for (const kind of ['max-tokens', 'error', 'interrupted']) {
    const decision = shouldResume({ reason: kind, config: BASE, attempts: 0, now: 0 });
    assert.equal(decision.resume, true, `${kind} should be resumed`);
    assert.ok(decision.text.length > 20, `${kind} needs continuation text, not just "continue"`);
  }
});

await check('continuation: the module switch is a master switch', () => {
  const off = shouldResume({ reason: 'max-tokens', config: { ...BASE, enabled: false }, attempts: 0, now: 0 });
  assert.equal(off.resume, false);
  assert.equal(off.why, 'disabled');

  const subOff = shouldResume({ reason: 'max-tokens', config: { ...BASE, autoContinue: false }, attempts: 0, now: 0 });
  assert.equal(subOff.resume, false, 'autoContinue must be able to switch off on its own');
});

await check('continuation: subagents are left alone by default', () => {
  // DSH retries a child through its parent's protocol. A child that keeps waking itself is
  // how a delegation tree runs away, so this needs an explicit opt-in.
  const off = shouldResume({ reason: 'error', config: BASE, attempts: 0, now: 0, isSubagent: true });
  assert.equal(off.resume, false);
  assert.equal(off.why, 'subagent');

  const on = shouldResume({
    reason: 'error',
    config: { ...BASE, resumeSubagents: true },
    attempts: 0,
    now: 0,
    isSubagent: true,
  });
  assert.equal(on.resume, true);
});

await check('continuation: the budget is a hard stop', () => {
  const decision = shouldResume({ reason: 'error', config: BASE, attempts: 3, now: 0 });
  assert.equal(decision.resume, false);
  assert.equal(decision.why, 'budget-exhausted');

  // `0` means unlimited, which must be distinguishable from "no attempts yet".
  const unlimited = shouldResume({ reason: 'error', config: { ...BASE, maxConsecutive: 0 }, attempts: 99, now: 0 });
  assert.equal(unlimited.resume, true, '0 must mean unlimited, not zero attempts');
});

await check('continuation: the cooldown grows and then stops growing', () => {
  // First resume is immediate; later ones back off so a provider that is down is not hammered.
  assert.equal(cooldownFor(BASE, 0), 0);
  assert.equal(cooldownFor(BASE, 1), 45_000);
  assert.equal(cooldownFor(BASE, 2), 90_000);
  // 45s * 2^2 = 180s, above the 120s ceiling.
  assert.equal(cooldownFor(BASE, 3), 120_000, 'the ceiling must hold');
});

await check('continuation: a reply inside the cooldown waits instead of being dropped', () => {
  const decision = shouldResume({ reason: 'error', config: BASE, attempts: 1, lastAttemptAt: 1_000, now: 2_000 });
  assert.equal(decision.resume, false);
  assert.equal(decision.why, 'cooldown');
  assert.ok(decision.waitMs > 0, 'the caller needs to know how long is left');
});

await check('continuation: the user replying ends automated continuation', () => {
  // This is the strongest stop signal: they have taken the conversation back.
  const decision = shouldResume({ reason: 'error', config: BASE, attempts: 0, now: 0, userTouchedAfter: true });
  assert.equal(decision.resume, false);
  assert.equal(decision.why, 'user-took-over');
});

await check('continuation: the message is shaped like a real user turn', () => {
  // DSH's own bridges build `{ id, role, source, content }`; anything else would be treated
  // as a plugin artefact downstream and could be filtered or rendered differently.
  let counter = 0;
  const message = continuationMessage('continue please', () => `id-${(counter += 1)}`);
  assert.equal(message.role, 'user');
  assert.deepEqual(message.source, { kind: 'user' });
  assert.equal(message.content[0].type, 'text');
  assert.equal(message.content[0].text, 'continue please');
  assert.ok(Object.isFrozen(message), 'the message must be frozen like the platform builds them');
});

/** Build an engine over a fake clock so nothing actually waits. */
function harness({ config = BASE, agent } = {}) {
  const sent = [];
  const timers = [];
  let clock = 0;
  const engine = new AutoContinueEngine({
    settings: { section: async () => ({ ...config }) },
    logger: () => {},
    agents: { get: () => agent },
    randomId: () => 'msg-1',
    setTimeout: (fn, ms) => {
      const entry = { fn, ms, dueAt: clock + ms };
      timers.push(entry);
      return entry;
    },
    clearTimeout: (handle) => {
      const index = timers.indexOf(handle);
      if (index >= 0) timers.splice(index, 1);
    },
    now: () => clock,
  });
  return {
    engine,
    sent,
    timers,
    advance: (ms) => {
      clock += ms;
    },
    /** Run the timer that is due; the engine uses 0 ms for the first attempt. */
    flush: async () => {
      for (const timer of [...timers]) {
        if (timer.dueAt <= clock) {
          timer.fn();
          const index = timers.indexOf(timer);
          if (index >= 0) timers.splice(index, 1);
          await Promise.resolve();
          await Promise.resolve();
        }
      }
    },
  };
}

const session = { id: 'session-a', header: { origin: undefined } };

await check('engine: the first continuation is sent immediately', async () => {
  let followups = 0;
  const h = harness({ agent: { status: 'idle', followup: () => { followups += 1; } } });
  const decision = await h.engine.onSessionEvent(session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'error' } },
  });
  assert.equal(decision.resume, true);
  assert.equal(decision.waitMs, 0, 'the first attempt must not wait');
  await h.flush();
  assert.equal(followups, 1, 'the message must actually reach the agent');
});

await check('engine: a running agent is not given a second turn', async () => {
  // Sending to a running agent queues a message behind its current turn, which is how two
  // continuations end up in flight at once.
  let followups = 0;
  const h = harness({ agent: { status: 'running', followup: () => { followups += 1; } } });
  await h.engine.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'error' } } });
  await h.flush();
  assert.equal(followups, 0, 'a running session must be left alone');
});

await check('engine: a disposed agent is not continued', async () => {
  const h = harness({ agent: undefined });
  const decision = await h.engine.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'error' } } });
  assert.equal(decision.resume, true, 'the decision is taken; only the send is skipped');
  await h.flush();
  assert.equal(h.engine.inspect().sessions[0].attempts, 0, 'no attempt may be counted without a send');
});

await check('engine: a user message cancels a queued continuation', async () => {
  let followups = 0;
  const h = harness({ agent: { status: 'idle', followup: () => { followups += 1; } } });
  await h.engine.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'error' } } });
  await h.flush();
  assert.equal(followups, 1);

  // The second attempt is inside the cooldown, so the engine schedules it and returns.
  h.advance(1_000);
  const second = await h.engine.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'error' } } });
  assert.equal(second.resume, false);
  assert.equal(second.why, 'cooldown');

  // A user reply must clear the session's budget so their next failure gets a full one.
  const cancelled = await h.engine.onSessionEvent(session, { type: 'user/message', data: {} });
  assert.equal(cancelled.why, 'user-message');
  assert.equal(h.engine.inspect().sessions[0].attempts, 0, 'the budget resets when the user replies');
});

await check('engine: a queued continuation fires once its cooldown elapses', async () => {
  // Waiting is what makes a pending timer observable; the first attempt is immediate, so the
  // timer only exists from the second attempt on.
  let followups = 0;
  const h = harness({ agent: { status: 'idle', followup: () => { followups += 1; } } });
  await h.engine.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'error' } } });
  await h.flush();
  h.advance(1_000);
  await h.engine.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'error' } } });
  assert.equal(h.timers.length, 0, 'inside the cooldown nothing is queued — the decision says cooldown');

  // Past the cooldown the attempt is scheduled, then fires.
  h.advance(60_000);
  const third = await h.engine.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'error' } } });
  assert.equal(third.resume, true);
  assert.ok(third.waitMs > 0, 'a later attempt must wait rather than fire immediately');
  assert.equal(h.timers.length, 1, 'the attempt is queued');
  h.advance(third.waitMs);
  await h.flush();
  assert.equal(followups, 2, 'the queued continuation must reach the agent');
});

await check('engine: stop clears every pending timer', async () => {
  const h = harness({ agent: { status: 'idle', followup: () => {} } });
  await h.engine.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'error' } } });
  await h.flush();
  h.advance(120_000);
  const queued = await h.engine.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'error' } } });
  assert.equal(queued.resume, true);
  assert.equal(h.timers.length, 1, 'a timer must be pending for this test to mean anything');
  h.engine.stop();
  assert.equal(h.timers.length, 0, 'shutdown must not leave a timer that fires into a dead engine');

  const after = await h.engine.onSessionEvent(session, { type: 'turn/end', data: { reason: { kind: 'error' } } });
  assert.equal(after.resume, false);
  assert.equal(after.why, 'stopped');
});

await check('engine: unrelated events are ignored', async () => {
  const h = harness({ agent: { status: 'idle', followup: () => {} } });
  for (const type of ['tool/result', 'assistant/message', 'step/end']) {
    const decision = await h.engine.onSessionEvent(session, { type, data: {} });
    assert.equal(decision.resume, false, `${type} must not trigger anything`);
  }
  assert.equal(h.timers.length, 0);
});

await check('engine: a subagent turn is skipped unless opted in', async () => {
  let followups = 0;
  const sub = { id: 'session-child', header: { parentSession: 'session-a', origin: 'subagent' } };
  const h = harness({ agent: { status: 'idle', followup: () => { followups += 1; } } });
  const decision = await h.engine.onSessionEvent(sub, { type: 'turn/end', data: { reason: { kind: 'error' } } });
  assert.equal(decision.resume, false);
  await h.flush();
  assert.equal(followups, 0);
});

console.log(`\nauto-continue: ${15 - failures}/15 passed`);
process.exit(failures === 0 ? 0 : 1);
