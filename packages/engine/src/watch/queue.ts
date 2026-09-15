/**
 * Two small, DB-free primitives that close the concurrency and
 * delivery-reliability gaps in the pre-existing watcher:
 *
 *   1. Before this file existed, `ChangeBatcher`'s flush callback in
 *      `watch-workspace.ts` was fire-and-forget — `processBatch(items)` ran
 *      un-awaited, so a slow store write left a window where a second,
 *      overlapping `processBatch` call could mutate the same in-memory
 *      `knownFiles`/`knownDirs` state. `SerialQueue` closes that window: every
 *      enqueued batch runs to completion before the next one starts.
 *   2. A failed `WatchSink.onBatch` call used to become a `console`-style
 *      warning and nothing else — the batch was gone forever, and the graph
 *      silently diverged from disk. `withRetry` gives a transient failure
 *      (a DB reconnect, a momentary network blip) a bounded number of
 *      chances to succeed before the caller has to decide what "give up"
 *      means.
 */

export interface SerialQueueOptions {
  readonly onError?: (error: unknown) => void;
}

/**
 * Runs `process(item)` for each enqueued item strictly one at a time, in
 * submission order. An item submitted while a prior one is still running
 * waits its turn instead of racing it.
 */
export class SerialQueue<T> {
  private readonly pending: T[] = [];
  private draining = false;
  private disposed = false;

  constructor(
    private readonly process: (item: T) => Promise<void>,
    private readonly options: SerialQueueOptions = {},
  ) {}

  enqueue(item: T): void {
    if (this.disposed) {
      return;
    }
    this.pending.push(item);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      for (;;) {
        const item = this.pending.shift();
        if (item === undefined) {
          break;
        }
        try {
          // eslint-disable-next-line no-await-in-loop
          await this.process(item);
        } catch (error) {
          this.options.onError?.(error);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Items waiting, not counting one currently in flight — a cheap backlog signal. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Drops anything not yet started. Does not interrupt an in-flight `process` call. */
  dispose(): void {
    this.disposed = true;
    this.pending.length = 0;
  }
}

export interface RetryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly onRetry?: (attempt: number, error: unknown) => void;
  /** Injectable so a test drives this with no real sleeps. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 200;
const DEFAULT_MAX_DELAY_MS = 5000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls `fn()`, retrying on rejection with bounded exponential backoff
 * (`baseDelayMs * 2^(attempt-1)`, capped at `maxDelayMs`). Rethrows the last
 * error once `maxAttempts` is exhausted — the caller (`watch-workspace.ts`)
 * decides what happens next: mark the batch's paths dirty and warn, rather
 * than pretend the write happened.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; ; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn();
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }
      options.onRetry?.(attempt, error);
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      // eslint-disable-next-line no-await-in-loop
      await sleep(delay);
    }
  }
}
