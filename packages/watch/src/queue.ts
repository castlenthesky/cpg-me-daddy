// C-WATCH layer B's delivery primitives (U4.1.1). REAL. Ported from
// e45574f:packages/engine/src/watch/queue.ts with the archive's retry bounds; the sleep between
// attempts goes through the injected TimerApi (decision 45). The queue owns INV-21 (at most one batch
// in flight, strictly in order). onDegraded (INV-22) and advancing known state only after confirmed
// delivery are the session's (decision 46).

import type { TimerApi } from './contract';

export interface SerialQueueOptions {
  /** Called with whatever `process` rejected with; the queue then moves on to the next item. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Runs `process(item)` for each enqueued item strictly one at a time, in submission order. An item
 * enqueued while another is running waits its turn instead of racing it.
 */
export class SerialQueue<T> {
  readonly #process: (item: T) => Promise<void>;
  readonly #options: SerialQueueOptions;
  readonly #pending: { readonly item: T }[] = [];
  #draining = false;
  #disposed = false;

  constructor(process: (item: T) => Promise<void>, options: SerialQueueOptions = {}) {
    this.#process = process;
    this.#options = options;
  }

  /** Queues `item` behind everything already queued. Ignored after `dispose`. */
  enqueue(item: T): void {
    if (this.#disposed) return;
    this.#pending.push({ item });
    void this.#drain();
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      for (;;) {
        const next = this.#pending.shift();
        if (next === undefined) break;
        try {
          await this.#process(next.item);
        } catch (error) {
          this.#options.onError?.(error);
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  /** Items waiting, not counting one in flight: a cheap backlog signal. */
  get pendingCount(): number {
    return this.#pending.length;
  }

  /** Drops everything not yet started. Does not interrupt the item in flight. Final. */
  dispose(): void {
    this.#disposed = true;
    this.#pending.length = 0;
  }
}

export interface RetryOptions {
  /** Calls of `fn` in all, the first included. Default 5. */
  readonly maxAttempts?: number;
  /** The wait after the first failure; it doubles after each later one. Default 200. */
  readonly baseDelayMs?: number;
  /** The cap on any one wait. Default 5000. */
  readonly maxDelayMs?: number;
  /** Called after a failed attempt that will be retried, with that attempt's number (from 1). */
  readonly onRetry?: (attempt: number, error: unknown) => void;
  /** Default: the global setTimeout/clearTimeout, looked up at each call. A test passes a fake clock. */
  readonly timers?: TimerApi;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 200;
const DEFAULT_MAX_DELAY_MS = 5000;

function wait(timers: TimerApi, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    timers.setTimeout(resolve, ms);
  });
}

/**
 * Calls `fn`, and on a rejection waits `min(baseDelayMs * 2^(attempt-1), maxDelayMs)` and calls it
 * again, up to `maxAttempts` calls. Resolves with the first success; after the last attempt fails it
 * rejects with that attempt's error, and the caller decides what giving up means.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const timers = options.timers ?? globalThis;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxAttempts) throw error;
      options.onRetry?.(attempt, error);
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await wait(timers, delay);
    }
  }
}
