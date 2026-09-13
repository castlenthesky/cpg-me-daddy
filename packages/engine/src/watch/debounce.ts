/**
 * The watcher's debounce window: 100ms trailing per path, 500ms ceiling
 * since the batch's first event (`40-research.yaml` `adopted_defaults.watcher`).
 * A generic, key-deduplicating batcher — the last `add()` for a given key
 * wins, so a rapid create-then-immediately-edited file collapses to one
 * flush entry, not two.
 *
 * `now`/`setTimeout`/`clearTimeout` are injectable so a unit test drives this
 * with a fake clock and zero real sleeps.
 */

export interface ChangeBatcherOptions {
  readonly trailingMs?: number;
  readonly ceilingMs?: number;
  readonly now?: () => number;
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

const DEFAULT_TRAILING_MS = 100;
const DEFAULT_CEILING_MS = 500;

export class ChangeBatcher<T> {
  private readonly pending = new Map<string, T>();
  private readonly trailingMs: number;
  private readonly ceilingMs: number;
  private readonly nowFn: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private trailingHandle: unknown;
  private ceilingHandle: unknown;
  private batchOpenedAt: number | undefined;

  constructor(
    private readonly onFlush: (items: readonly T[]) => void,
    options: ChangeBatcherOptions = {},
  ) {
    this.trailingMs = options.trailingMs ?? DEFAULT_TRAILING_MS;
    this.ceilingMs = options.ceilingMs ?? DEFAULT_CEILING_MS;
    this.nowFn = options.now ?? (() => Date.now());
    this.setTimeoutFn = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeout ?? ((handle) => clearTimeout(handle as never));
  }

  /** Queues `item` under `key` (a workspace-relative path) — last write per key wins. */
  add(key: string, item: T): void {
    this.pending.set(key, item);

    if (this.batchOpenedAt === undefined) {
      this.batchOpenedAt = this.nowFn();
      this.ceilingHandle = this.setTimeoutFn(() => this.flush(), this.ceilingMs);
    }

    if (this.trailingHandle !== undefined) {
      this.clearTimeoutFn(this.trailingHandle);
    }
    this.trailingHandle = this.setTimeoutFn(() => this.flush(), this.trailingMs);
  }

  private flush(): void {
    if (this.pending.size === 0) {
      return;
    }
    const items = [...this.pending.values()];
    this.pending.clear();
    this.clearTimers();
    this.onFlush(items);
  }

  private clearTimers(): void {
    if (this.trailingHandle !== undefined) {
      this.clearTimeoutFn(this.trailingHandle);
      this.trailingHandle = undefined;
    }
    if (this.ceilingHandle !== undefined) {
      this.clearTimeoutFn(this.ceilingHandle);
      this.ceilingHandle = undefined;
    }
    this.batchOpenedAt = undefined;
  }

  /** Stops pending timers without flushing — for shutdown. */
  dispose(): void {
    this.pending.clear();
    this.clearTimers();
  }
}
