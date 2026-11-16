/**
 * Resume a turn that stopped for a reason the user did not choose.
 *
 * The stream-level retry in `stream-retry.js` only covers one model call: it replays the
 * request while the provider is failing. Everything above it — a turn that ended on
 * `max-tokens`, an interrupted turn after a Host restart, a turn that died on a permanent
 * provider error after the stream layer gave up — leaves the conversation sitting there
 * with no answer, and the user has to type "continue" themselves.
 *
 * That is the gap `dsh-client-auto-continue` and `dsh-harden` fill from the client and the
 * lifecycle layer respectively. This module fills it from the Host, where the durable
 * `turn/end` event already carries the exact reason the turn stopped, so no polling and no
 * client round-trip is involved.
 *
 * ## What it will not do
 *
 * It only continues a turn the user did not stop. `aborted` (manual stop), `blocked`
 * (policy), and `forked` are final answers, not failures. A `completed` turn is a finished
 * answer, and continuing it would talk to itself — that is an autonomous loop, a different
 * feature with a different risk, so it is opt-in and bounded separately.
 *
 * ## Why the guard rails are this heavy
 *
 * A loop of "continue automatically" can burn a real budget unattended. Every layer below
 * exists to stop a runaway: a per-session ceiling, a wall-clock cooldown that grows with
 * each attempt, a hard stop when the user touches the session, and a never-continue rule for
 * subagent sessions unless asked.
 */

/** Reasons a turn ended that are an answer, not a failure. Never continued. */
const FINAL_REASONS = new Set(['aborted', 'blocked', 'forked']);

/**
 * Continuation text per ending reason.
 *
 * The wording matters: a bare "continue" gets answered with a restatement of what was
 * already said. Naming the concrete gap — truncated output, or a dropped request — gives
 * the model something actionable. Both are kept short so they cost few tokens.
 */
const CONTINUATIONS = Object.freeze({
  'max-tokens': 'Your previous reply was cut off by the output limit. Continue from exactly where it stopped, without repeating the part already written.',
  error: 'Your previous reply failed before it finished. Continue the task from where it stopped.',
  interrupted: 'The previous reply was interrupted by a restart. Continue the task from where it stopped.',
  completed: 'Review the task and continue if anything is still unfinished. If everything is done, reply with a one-line summary and stop.',
});

/**
 * Decide whether a stopped turn should be resumed.
 *
 * Kept as a pure function of the ending reason plus the session's attempt history, so the
 * decision is testable without a live agent or a clock.
 */
export function shouldResume({ reason, config, attempts, lastAttemptAt, now, isSubagent, userTouchedAfter }) {
  if (config?.enabled !== true) return { resume: false, why: 'disabled' };
  // The section switch is the master; this is the feature-level switch under it, so the
  // remaining retry settings can stay configured while continuation is paused.
  if (config?.autoContinue === false) return { resume: false, why: 'continuation-off' };

  const kind = typeof reason === 'string' ? reason : reason?.kind;
  if (typeof kind !== 'string') return { resume: false, why: 'unknown-reason' };
  if (FINAL_REASONS.has(kind)) return { resume: false, why: `final:${kind}` };

  // A completed turn is only continued when the autonomous loop is explicitly on. Doing it
  // by default would turn every finished answer into another turn.
  if (kind === 'completed' && config.resumeCompletedTurns !== true) {
    return { resume: false, why: 'completed-not-opted-in' };
  }
  if (!(kind in CONTINUATIONS)) return { resume: false, why: `unsupported:${kind}` };

  // Subagents are left alone by default: DSH already retries a child through its own parent
  // protocol, and a child that keeps waking itself up is how a delegation tree runs away.
  if (isSubagent === true && config.resumeSubagents !== true) {
    return { resume: false, why: 'subagent' };
  }

  // The user replying is the strongest signal that automatic continuation should stop: they
  // have taken over the conversation, and a queued continuation would interrupt them.
  if (userTouchedAfter === true) return { resume: false, why: 'user-took-over' };

  const budget = Number.isFinite(config.maxConsecutive) ? config.maxConsecutive : 3;
  if (budget > 0 && attempts >= budget) return { resume: false, why: 'budget-exhausted' };

  const cooldown = cooldownFor(config, attempts);
  if (Number.isFinite(lastAttemptAt) && now - lastAttemptAt < cooldown) {
    return { resume: false, why: 'cooldown', waitMs: cooldown - (now - lastAttemptAt) };
  }

  return { resume: true, why: 'ok', text: CONTINUATIONS[kind], cooldownMs: cooldown };
}

/**
 * Wait before the next attempt, growing with each retry up to the configured ceiling.
 *
 * A fixed delay hammers a provider that is already rate-limiting; a purely exponential one
 * makes the first retry feel slow. This starts at the configured base and only doubles after
 * the first attempt, which matches what the stream layer already does.
 */
export function cooldownFor(config, attempts) {
  const base = Number.isFinite(config?.cooldownMs) ? config.cooldownMs : 45_000;
  const max = Number.isFinite(config?.maxCooldownMs) ? config.maxCooldownMs : 120_000;
  const factor = Number.isFinite(config?.backoffFactor) ? config.backoffFactor : 2;
  if (attempts <= 0) return 0;
  return Math.min(max, Math.round(base * factor ** (attempts - 1)));
}

/** Build the message DSH's own bridges send, so nothing downstream can tell it apart. */
export function continuationMessage(text, randomId) {
  return Object.freeze({
    id: randomId(),
    role: 'user',
    source: Object.freeze({ kind: 'user' }),
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
  });
}

/**
 * Watch every session's turn endings and resume the ones that stopped by accident.
 *
 * One instance per Host. `start()` subscribes; `stop()` unsubscribes and clears pending
 * timers. Callback injection (rather than importing the timer API) keeps this testable with
 * a fake clock and fake agents.
 */
export class AutoContinueEngine {
  #settings;
  #logger;
  #agents;
  #randomId;
  #setTimeout;
  #clearTimeout;
  #now;
  /** sessionId -> { attempts, lastAttemptAt, timer, lastReason } */
  #state = new Map();
  /** sessionId -> true once the user sent anything after the last automatic attempt */
  #userTouched = new Set();
  #disposed = false;
  #stopped = false;

  constructor({ settings, logger, agents, randomId, setTimeout, clearTimeout, now }) {
    this.#settings = settings;
    this.#logger = logger;
    this.#agents = agents;
    this.#randomId = randomId ?? (() => globalThis.crypto.randomUUID());
    this.#setTimeout = setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimeout = clearTimeout ?? ((handle) => clearTimeout(handle));
    this.#now = now ?? (() => Date.now());
  }

  /** Live state for the settings page: what is waiting, and why the last attempt stopped. */
  inspect() {
    const sessions = [];
    for (const [sessionId, entry] of this.#state) {
      sessions.push({
        sessionId,
        attempts: entry.attempts,
        lastAttemptAt: entry.lastAttemptAt,
        lastReason: entry.lastReason,
        pendingInMs: entry.timer === undefined ? null : Math.max(0, entry.dueAt - this.#now()),
      });
    }
    // Newest first: the page shows a short list and the recent sessions are the interesting
    // ones. A session that never had an attempt is not in the map at all.
    sessions.sort((a, b) => (b.lastAttemptAt ?? 0) - (a.lastAttemptAt ?? 0));
    return { watching: this.#state.size, sessions };
  }

  /**
   * Observe one session event.
   *
   * Returns the decision so a caller (a test, or the diagnostics page) can explain why
   * nothing happened. Side effects are limited to scheduling a timer.
   */
  async onSessionEvent(session, event) {
    if (this.#stopped || this.#disposed) return { resume: false, why: 'stopped' };
    if (event?.type !== 'turn/end' && event?.type !== 'user/message') return { resume: false, why: 'ignored' };

    const sessionId = session?.id;
    if (typeof sessionId !== 'string') return { resume: false, why: 'no-session' };

    // Anything the user sends means they are driving again; drop a queued continuation and
    // reset the attempt count so their next failure gets a full budget.
    if (event.type === 'user/message') {
      const entry = this.#state.get(sessionId);
      if (entry?.timer !== undefined) {
        this.#clearTimeout(entry.timer);
        entry.timer = undefined;
        this.#logger?.('debug')?.(`dsh-mydsh: auto-continue cancelled for ${sessionId}: the user replied`);
      }
      this.#userTouched.add(sessionId);
      if (entry !== undefined) {
        entry.attempts = 0;
        entry.lastReason = null;
      }
      return { resume: false, why: 'user-message' };
    }

    const config = await this.#settings.section('retry');
    const entry = this.#state.get(sessionId) ?? { attempts: 0, lastAttemptAt: undefined, lastReason: null };
    this.#state.set(sessionId, entry);

    const isSubagent = session?.header?.origin === 'subagent' || typeof session?.header?.parentSession === 'string';
    const decision = shouldResume({
      reason: event.data?.reason,
      config,
      attempts: entry.attempts,
      lastAttemptAt: entry.lastAttemptAt,
      now: this.#now(),
      isSubagent,
      userTouchedAfter: this.#userTouched.has(sessionId),
    });

    entry.lastReason = typeof event.data?.reason === 'string' ? event.data.reason : event.data?.reason?.kind ?? null;

    if (decision.resume !== true) {
      if (decision.why === 'budget-exhausted') {
        this.#logger?.('warn')?.(`dsh-mydsh: auto-continue gave up on ${sessionId} after ${entry.attempts} attempts`);
      }
      return decision;
    }

    // The first attempt is immediate: the turn just failed and the user is watching. Later
    // attempts wait, so a provider that is down is not hammered.
    const waitMs = entry.attempts === 0 ? 0 : decision.cooldownMs;
    if (entry.timer !== undefined) this.#clearTimeout(entry.timer);
    entry.dueAt = this.#now() + waitMs;
    entry.timer = this.#setTimeout(() => {
      entry.timer = undefined;
      this.#attempt(session, sessionId, entry, decision.text).catch((error) => {
        this.#logger?.('warn')?.(`dsh-mydsh: auto-continue failed for ${sessionId}: ${error?.message ?? error}`);
      });
    }, waitMs);

    return { ...decision, waitMs };
  }

  async #attempt(session, sessionId, entry, text) {
    if (this.#stopped || this.#disposed) return;
    const agent = this.#agents?.get?.(sessionId);
    // A session whose agent has gone away cannot be continued: `followup` would throw, and
    // resuming the agent is the user's decision (it changes what is running on their machine).
    if (agent === undefined) {
      this.#logger?.('debug')?.(`dsh-mydsh: auto-continue skipped ${sessionId}: no live agent`);
      return;
    }
    if (agent.status === 'running') {
      // The turn restarted on its own (a retry upstream, or the user typing again) — sending
      // now would queue a second continuation behind it.
      this.#logger?.('debug')?.(`dsh-mydsh: auto-continue skipped ${sessionId}: already running`);
      return;
    }

    entry.attempts += 1;
    entry.lastAttemptAt = this.#now();
    this.#userTouched.delete(sessionId);
    try {
      agent.followup(continuationMessage(text, this.#randomId));
      this.#logger?.('info')?.(`dsh-mydsh: auto-continue sent to ${sessionId} (attempt ${entry.attempts})`);
    } catch (error) {
      this.#logger?.('warn')?.(`dsh-mydsh: auto-continue could not send to ${sessionId}: ${error?.message ?? error}`);
    }
  }

  /** Drop every pending continuation. Used on Host shutdown and when the module is switched off. */
  stop() {
    this.#stopped = true;
    for (const entry of this.#state.values()) {
      if (entry.timer !== undefined) this.#clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  /** Clear a session's budget, e.g. after the user asks for a fresh start from the panel. */
  reset(sessionId) {
    const entry = this.#state.get(sessionId);
    if (entry === undefined) return false;
    if (entry.timer !== undefined) this.#clearTimeout(entry.timer);
    this.#state.delete(sessionId);
    this.#userTouched.delete(sessionId);
    return true;
  }

  dispose() {
    this.stop();
    this.#disposed = true;
    this.#state.clear();
    this.#userTouched.clear();
  }
}
