// C-WATCH layer B's debounce window (U4.1.1). SEAT until U4.1.1 lands. Ported from
// e45574f:packages/engine/src/watch/debounce.ts with two departures: the archive's dead `now` is gone
// and the timers come in as one TimerApi (decision 45), and nothing is keyed or merged here (see
// ChangeBatcher).

import type { TimerApi } from './contract';

export interface ChangeBatcherOptions {
  /** Quiet time after the latest add before the window flushes. Default 100 (C-WATCH T1_T2). */
  readonly trailingMs?: number;
  /** Longest a window stays open, counted from its first add. Default 500 (C-WATCH T1_T2). */
  readonly ceilingMs?: number;
  /** Default: the global setTimeout/clearTimeout. A test passes a fake clock. */
  readonly timers?: TimerApi;
}

/**
 * A generic debounce window. `add` puts an item in the open window, opening one if none is open. The
 * window flushes `trailingMs` after its latest add or `ceilingMs` after its first add, whichever comes
 * first, and hands `onFlush` every item in arrival order. The ceiling is the declared cap that keeps a
 * burst from delaying a batch indefinitely (C-WATCH budget_boundary.T1_T2, DQ-05).
 *
 * Nothing is keyed or merged here. The archive kept the last item per key, which is the kind-blind
 * batching the merge table replaced (L-31, D1), and C-WATCH bars domain policy from the generic
 * batcher. The session folds the flushed items through coalesce.
 */
export class ChangeBatcher<T> {
  readonly #onFlush: (items: readonly T[]) => void;
  readonly #options: ChangeBatcherOptions;

  constructor(onFlush: (items: readonly T[]) => void, options: ChangeBatcherOptions = {}) {
    this.#onFlush = onFlush;
    this.#options = options;
  }

  /** Adds `item` to the open window and restarts its trailing timer. Ignored after `dispose`. */
  add(_item: T): void {
    void this.#onFlush;
    void this.#options;
    throw new Error('SEAT: ChangeBatcher.add lands in U4.1.1');
  }

  /** Drops the open window without flushing it and clears its timers. Final: later adds are ignored. */
  dispose(): void {
    throw new Error('SEAT: ChangeBatcher.dispose lands in U4.1.1');
  }
}
