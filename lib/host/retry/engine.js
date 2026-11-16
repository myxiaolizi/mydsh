/**
 * Retry bookkeeping.
 *
 * The decisions themselves live in `stream-retry.js`, which wraps the model
 * stream. This file owns only the record of what happened: a bounded ledger the
 * settings page reads, plus the aggregate counts behind it.
 *
 * Keeping the ledger separate matters for a specific reason. An earlier version
 * of this module also implemented the retry decision against
 * `agent/request-error`, whose action type carries no delay and no model choice —
 * so the engine could not do what this feature promises. That code is gone; what
 * remains is the part that was correct, and the seam that works lives in
 * `stream-retry.js`.
 */
import { backoffDelay } from './classify.js';

/** Number of entries kept for display; older ones are dropped, not counted. */
const DEFAULT_LIMIT = 200;

export class RetryLedger {
  #entries = [];
  #limit;
  #stats = new Map();
  #totals = { retries: 0, recovered: 0, exhausted: 0, stopped: 0 };

  constructor(limit = DEFAULT_LIMIT) {
    this.#limit = Math.max(20, limit);
  }

  /**
   * Record one attempt outcome.
   *
   * Entries are appended in time order and trimmed from the front, so the array
   * never grows past the limit even under a long retry storm.
   */
  record(entry) {
    const record = { ...entry, at: Date.now() };
    this.#entries.push(record);
    if (this.#entries.length > this.#limit) {
      this.#entries.splice(0, this.#entries.length - this.#limit);
    }

    const kind = entry.kind ?? 'unknown';
    const stat = this.#stats.get(kind) ?? { kind, attempts: 0, retrying: 0, succeeded: 0, exhausted: 0, stopped: 0 };
    stat.attempts += 1;
    // `outcome` is the ledger's vocabulary: retrying, succeeded, exhausted,
    // stopped. Anything else is a caller bug and is counted as stopped rather
    // than silently dropped.
    switch (entry.outcome) {
      case 'retrying':
        stat.retrying += 1;
        this.#totals.retries += 1;
        break;
      case 'succeeded':
        stat.succeeded += 1;
        this.#totals.recovered += 1;
        break;
      case 'exhausted':
        stat.exhausted += 1;
        this.#totals.exhausted += 1;
        break;
      default:
        stat.stopped += 1;
        this.#totals.stopped += 1;
        break;
    }
    this.#stats.set(kind, stat);
  }

  /** Most recent entries, newest first. */
  recent(limit = 50) {
    return this.#entries.slice(-limit).reverse();
  }

  /** Per-kind counts, busiest first. */
  stats() {
    return [...this.#stats.values()].sort((a, b) => b.attempts - a.attempts);
  }

  /** Whole-ledger totals, for the panel header. */
  totals() {
    return { ...this.#totals };
  }

  clear() {
    this.#entries = [];
    this.#stats.clear();
    this.#totals = { retries: 0, recovered: 0, exhausted: 0, stopped: 0 };
  }
}

/**
 * Backoff schedule preview.
 *
 * Exposed so the settings panel can show what a policy will actually wait
 * instead of asking the user to compute an exponential series in their head.
 */
export function previewBackoff({ attempts = 5, initialDelayMs = 1000, maxDelayMs = 30_000, jitterRatio = 0.1 } = {}) {
  const schedule = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    schedule.push(Math.round(backoffDelay(attempt, { initialDelayMs, maxDelayMs, jitterRatio, random: () => 0.5 })));
  }
  return schedule;
}
