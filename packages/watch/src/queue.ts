// C-WATCH layer B's delivery primitives (U4.1.1). SEAT until U4.1.1 lands. Ported from
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

  constructor(process: (item: T) => Promise<void>, options: SerialQueueOptions = {}) {
    this.#process = process;
    this.#options = options;
  }

  /** Queues `item` behind everything already queued. Ignored after `dispose`. */
  enqueue(_item: T): void {
    void this.#process;
    void this.#options;
    throw new Error('SEAT: SerialQueue.enqueue lands in U4.1.1');
  }

  /** Items waiting, not counting one in flight: a cheap backlog signal. */
  get pendingCount(): number {
    throw new Error('SEAT: SerialQueue.pendingCount lands in U4.1.1');
  }

  /** Drops everything not yet started. Does not interrupt the item in flight. Final. */
  dispose(): void {
    throw new Error('SEAT: SerialQueue.dispose lands in U4.1.1');
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
  /** Default: the global setTimeout/clearTimeout. A test passes a fake clock. */
  readonly timers?: TimerApi;
}

/**
 * Calls `fn`, and on a rejection waits `min(baseDelayMs * 2^(attempt-1), maxDelayMs)` and calls it
 * again, up to `maxAttempts` calls. Resolves with the first success; after the last attempt fails it
 * rejects with that attempt's error, and the caller decides what giving up means.
 */
export async function withRetry<T>(_fn: () => Promise<T>, _options?: RetryOptions): Promise<T> {
  await Promise.resolve();
  throw new Error('SEAT: withRetry lands in U4.1.1');
}
