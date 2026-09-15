/**
 * The seam that makes the watcher store-ignorant. `watchWorkspace` used to
 * take an `IGraphStore` directly and call `writeFilesystem` on it itself —
 * that coupling is exactly what this file removes. A `WatchSink` is anything
 * downstream that wants to know what changed; the watcher never asks what a
 * sink does with a batch, and this file never imports anything from
 * `../store` or `../schema`.
 *
 * `indexer/filesystem-projector.ts` is the first, smallest `WatchSink`
 * implementation — it turns a `ChangeBatch` into a `FilesystemDelta` and
 * writes it. A future AST-tier consumer, or a visualization layer, is just
 * another `WatchSink` over the same stream (see the architecture note in
 * `docs/architecture/service-boundaries.md`).
 */
import type { NormalizedChange } from "./events";

/** Why this batch was emitted — lets a consumer treat a cold-start replay
 *  differently from a live edit without the watcher hardcoding that policy. */
export type BatchCause = "initial" | "live";

export interface ChangeBatch {
  /** Monotonic per `WatchSession`, starting at 0. Lets a consumer notice a
   *  gap (a batch it never saw) or a duplicate delivery. */
  readonly seq: number;
  readonly changes: readonly NormalizedChange[];
  readonly cause: BatchCause;
}

export interface WatchSink {
  /**
   * Delivers one batch. Awaited by the watcher — a rejection means "not
   * delivered": the watcher retries with backoff (see `./queue.ts`) rather
   * than advancing its own known-state past what was actually written.
   * Batches for one workspace are always delivered one at a time, in `seq`
   * order — a sink never needs its own locking to stay consistent.
   */
  onBatch(batch: ChangeBatch): Promise<void>;
}
