/**
 * Attempt-level retry inside the model stream.
 *
 * DSH's `agent/request-error` waterfall can only answer "retry this step" — it
 * carries no delay and no route change. The `llm/stream` waterfall is the seam
 * with the reach this feature needs: it wraps one model call, so a listener can
 * wait, change the destination, and ask again without disturbing the agent loop.
 *
 * Failure handling is deliberately conservative. A wrapper that throws where the
 * platform would have returned a terminal chunk turns a recoverable provider
 * error into a crashed turn, so every unexpected fault falls through to the
 * original stream.
 */
import { backoffDelay, classifyError, resolvePolicy, DEFAULT_POLICY } from './classify.js';

/** Abortable sleep that rejects with an abort error the caller can detect. */
function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Collect one attempt's chunks while remembering whether it failed.
 *
 * The stream protocol reports provider-side failures as a terminal `finish`
 * chunk rather than a throw, so a wrapper must inspect the chunks it forwards.
 */
function describeFinish(chunk) {
  if (chunk?.type !== 'finish') return undefined;
  const reason = chunk.reason;
  if (reason?.kind === 'error' || reason?.kind === 'aborted') {
    return reason.failure ?? { message: 'model request failed', code: reason.kind };
  }
  return undefined;
}

/**
 * Redirect one request to another route.
 *
 * `next()` closes over the original options object, so a route change has to be
 * written onto that same object. Options may be frozen by a caller, in which
 * case the switch is skipped rather than forced.
 */
function redirect(options, target) {
  try {
    if (Object.isFrozen(options)) return false;
    options.provider = target.provider;
    options.model = target.model;
    return true;
  } catch {
    return false;
  }
}

export class StreamRetryEngine {
  #settings;
  #logger;
  #ledger;
  #tracker;
  #routes;

  constructor({ settings, logger, ledger, routes }) {
    this.#settings = settings;
    this.#logger = logger;
    this.#ledger = ledger;
    this.#tracker = new Map();
    this.#routes = routes;
  }

  /**
   * Wrap one model call.
   *
   * @param options the caller's request object (mutated only on a route switch).
   * @param next the original dispatch, still bound to the original route.
   * @param sessionKey identity used to keep attempt counts per conversation.
   */
  wrap(options, next, sessionKey) {
    const engine = this;
    return (async function* retrying() {
      const config = await engine.#settings.section('retry');
      if (config.enabled !== true) {
        yield* next();
        return;
      }

      const policy = {
        maxAttempts: config.maxAttempts ?? DEFAULT_POLICY.maxAttempts,
        initialDelayMs: config.initialDelayMs ?? DEFAULT_POLICY.initialDelayMs,
        maxDelayMs: config.maxDelayMs ?? DEFAULT_POLICY.maxDelayMs,
        jitterRatio: config.jitterRatio ?? DEFAULT_POLICY.jitterRatio,
      };

      const original = { provider: options.provider, model: options.model };
      let attempt = 0;
      let switched = 0;

      for (;;) {
        attempt += 1;
        let failure;
        let emitted = 0;

        try {
          for await (const chunk of next()) {
            const reported = describeFinish(chunk);
            if (reported !== undefined) {
              failure = reported;
              break;
            }
            emitted += 1;
            yield chunk;
          }
        } catch (error) {
          // A throw is the other sanctioned failure path (transport/protocol).
          failure = error?.failure ?? { message: String(error?.message ?? error), code: error?.code };
        }

        if (failure === undefined) return;
        if (options.signal?.aborted === true) {
          throw failure;
        }

        const kind = classifyError(failure);
        const { rule } = resolvePolicy(config.policies, failure);
        const maxAttempts = rule?.maxAttempts ?? policy.maxAttempts;

        // A partially-streamed attempt cannot be replayed: the consumer already
        // observed tokens, so a silent second attempt would duplicate content.
        if (emitted > 0) {
          this.#ledger?.record({
            sessionId: sessionKey, attempt, kind, outcome: 'stopped', reason: 'partial-stream',
          });
          throw failure;
        }
        if (kind === 'cancelled') throw failure;
        if (!this.#isRetryable(kind, rule)) {
          this.#ledger?.record({ sessionId: sessionKey, attempt, kind, outcome: 'stopped', reason: 'not-retryable' });
          throw failure;
        }
        if (attempt >= maxAttempts) {
          this.#ledger?.record({ sessionId: sessionKey, attempt, kind, outcome: 'exhausted' });
          throw failure;
        }

        const hinted = typeof failure?.providerRetryAfterMs === 'number' ? failure.providerRetryAfterMs : 0;
        const delayMs = Math.max(
          backoffDelay(attempt, { ...policy, initialDelayMs: rule?.initialDelayMs ?? policy.initialDelayMs, maxDelayMs: rule?.maxDelayMs ?? policy.maxDelayMs }),
          Math.min(hinted, policy.maxDelayMs),
        );

        // Route switch: only after the plain retries in this chain have failed,
        // because a healthy route usually recovers on its own.
        const switchAfter = rule?.switchAfter ?? 1;
        let target;
        if ((rule?.switchModel === true || rule?.switchProvider === true) && attempt >= switchAfter) {
          const chain = await engine.#routes();
          if (chain.length > 0) {
            target = chain[Math.min(chain.length - 1, switched)];
          }
        }

        try {
          await sleep(delayMs, options.signal);
        } catch {
          throw failure;
        }

        if (target !== undefined && redirect(options, target)) {
          switched += 1;
          this.#logger?.('info')?.(`dsh-mydsh: ${kind} on ${original.provider}/${original.model}; retrying on ${target.provider}/${target.model} after ${delayMs}ms`);
        } else {
          this.#logger?.('info')?.(`dsh-mydsh: ${kind}; retry ${attempt + 1}/${maxAttempts} after ${delayMs}ms`);
        }

        this.#ledger?.record({
          sessionId: sessionKey, attempt, kind, outcome: 'retrying', delayMs, switchedTo: target,
        });
      }
    })();
  }

  #isRetryable(kind, rule) {
    const configured = rule?.errorKinds;
    if (Array.isArray(configured) && configured.length > 0) return configured.includes(kind);
    const allow = rule?.allowedKinds;
    if (Array.isArray(allow) && allow.length > 0) return allow.includes(kind);
    return RETRYABLE.includes(kind);
  }
}

/** Kinds retried when a rule names none; see classify.js for the rationale. */
const RETRYABLE = Object.freeze([
  'rate-limit',
  'overloaded',
  'server-error',
  'timeout',
  'network',
  'model-unavailable',
  'unknown',
]);
