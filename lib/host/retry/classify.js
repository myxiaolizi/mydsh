/**
 * Domain classification for retry policy.
 *
 * A retry decision needs two independent facts about a failure: what kind of
 * failure it is (so a policy can name it) and whether retrying could possibly
 * help (so an obviously hopeless failure does not burn attempts and money).
 *
 * Classification is string-based on purpose. DSH surfaces failures from many
 * adapters — HTTP providers, local runtimes, subprocess bridges — and each one
 * spells its codes differently. Matching on normalized text keeps a new
 * adapter's failure retryable without a code change here.
 */

/** Failure kinds a policy can target, in display order. */
export const ERROR_KINDS = Object.freeze([
  'rate-limit',
  'overloaded',
  'server-error',
  'timeout',
  'network',
  'auth',
  'quota',
  'context-overflow',
  'invalid-request',
  'content-filter',
  'model-unavailable',
  'cancelled',
  'unknown',
]);

/**
 * Normalized failure kind for one error.
 *
 * `code` and `status` come from DSH's `LlmFailure` when available; `message`
 * backs them up for adapters that only produce prose.
 */
export function classifyError({ code, status, message } = {}) {
  const text = `${code ?? ''} ${message ?? ''}`.toLowerCase();

  // Explicit cancellation is never a failure to retry: the user asked to stop.
  if (/abort|cancel/.test(text)) return 'cancelled';

  // Context-window exhaustion needs a different remedy (compaction), not a
  // blind resend of the same oversized request.
  if (/context.{0,12}(length|window|limit|overflow)|too many tokens|maximum context/.test(text)) {
    return 'context-overflow';
  }

  if (/rate.?limit|too many requests|429/.test(text) || status === 429) return 'rate-limit';

  // Overload is distinct from rate limiting: the provider is healthy but full,
  // and the useful wait is usually longer.
  if (/overload|capacity|503/.test(text) || status === 503) return 'overloaded';

  if (/quota|insufficient.{0,12}(balance|credit|funds)|billing|payment required/.test(text) || status === 402) {
    return 'quota';
  }

  if (/unauthorized|forbidden|invalid.{0,8}(api.?key|token)|authentication|401|403/.test(text) || status === 401 || status === 403) {
    return 'auth';
  }

  if (/timeout|timed out|etimedout|deadline exceeded/.test(text)) return 'timeout';

  if (/network|econnreset|econnrefused|enotfound|socket hang up|fetch failed|dns/.test(text)) return 'network';

  if (/content.?filter|safety|blocked by|moderation/.test(text)) return 'content-filter';

  if (/model.{0,16}(not found|unavailable|does not exist|decommission)|no such model|404/.test(text)) {
    return 'model-unavailable';
  }

  if (/invalid.{0,12}(request|parameter|argument)|bad request|400|validation/.test(text)) {
    return 'invalid-request';
  }

  if (typeof status === 'number' && status >= 500) return 'server-error';

  return 'unknown';
}

/**
 * Whether a failure kind can plausibly succeed on retry with no change.
 *
 * Auth, quota, and malformed requests cannot: retrying spends latency and
 * sometimes money for a guaranteed identical failure. They stay out of the
 * default allowlist, while a policy may still add them explicitly.
 */
export const RETRYABLE_BY_DEFAULT = Object.freeze([
  'rate-limit',
  'overloaded',
  'server-error',
  'timeout',
  'network',
  'model-unavailable',
  'unknown',
]);

/** Kinds that switching model or provider can resolve but a plain retry cannot. */
export const SWITCHABLE = Object.freeze([
  'rate-limit',
  'overloaded',
  'quota',
  'model-unavailable',
  'auth',
]);

/** Human-facing label keys; the Client localizes them. */
export const ERROR_KIND_LABELS = Object.freeze({
  'rate-limit': 'retry.kind.rateLimit',
  'overloaded': 'retry.kind.overloaded',
  'server-error': 'retry.kind.serverError',
  'timeout': 'retry.kind.timeout',
  'network': 'retry.kind.network',
  'auth': 'retry.kind.auth',
  'quota': 'retry.kind.quota',
  'context-overflow': 'retry.kind.contextOverflow',
  'invalid-request': 'retry.kind.invalidRequest',
  'content-filter': 'retry.kind.contentFilter',
  'model-unavailable': 'retry.kind.modelUnavailable',
  'cancelled': 'retry.kind.cancelled',
  'unknown': 'retry.kind.unknown',
});

/**
 * Compute the delay before attempt `attempt` (1-based) under a backoff spec.
 *
 * Exponential growth with a cap and symmetric jitter: jitter matters because a
 * fleet of clients retrying a rate limit in lockstep keeps the limit tripped.
 */
export function backoffDelay(attempt, { initialDelayMs = 1000, maxDelayMs = 30_000, jitterRatio = 0.2, random = Math.random } = {}) {
  const exponent = Math.max(0, attempt - 1);
  const raw = Math.min(maxDelayMs, initialDelayMs * 2 ** exponent);
  const jitter = raw * jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(raw + jitter));
}

/**
 * Resolve the effective policy for one failure from an ordered rule list.
 *
 * First matching rule wins, so a user can put a specific error kind above a
 * catch-all. `undefined` means no rule claimed it and the built-in default
 * applies.
 */
export function resolvePolicy(rules, failure) {
  const kind = classifyError(failure);
  for (const rule of rules ?? []) {
    if (rule?.enabled === false) continue;
    const kinds = rule?.errorKinds;
    if (Array.isArray(kinds) && kinds.length > 0 && !kinds.includes(kind)) continue;
    return { rule, kind };
  }
  return { rule: undefined, kind };
}

/** Default policy used when no rule matches, so retry works out of the box. */
export const DEFAULT_POLICY = Object.freeze({
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  jitterRatio: 0.2,
  switchModel: false,
  switchProvider: false,
});
