/**
 * The watcher's own vocabulary — pure types, no I/O, no `@parcel/watcher`
 * import anywhere in this file. `ChangeKind`/`NormalizedChange` are what a
 * caller (`watch-workspace.ts`'s `onBatch` hook, and eventually `cpg watch`'s
 * own console output) actually reasons about; `RawEvent` in `./backend.ts` is
 * the raw, backend-specific shape that gets normalized into this.
 */

export type ChangeKind = "created" | "changed" | "deleted" | "moved";
export type EntryKind = "file" | "directory";

export interface NormalizedChange {
  readonly kind: ChangeKind;
  readonly entry: EntryKind;
  /** Workspace-relative POSIX path — the destination path for a `"moved"` change. */
  readonly path: string;
  /** Only set for `kind: "moved"` — the path before the move. */
  readonly fromPath?: string;
  /**
   * SHA-256 of the file's raw bytes, for `kind: "created" | "changed"` on a
   * `"file"` entry — the watcher already computes this for its own no-op
   * filter and rename pairing. Deliberately the ONLY content-derived field
   * here: no `loc`, no `language`, no bytes. Those are graph vocabulary a
   * consumer (e.g. `indexer/filesystem-projector.ts`) derives itself — this
   * type stays store-ignorant so `watch-workspace.ts` never has to.
   */
  readonly contentHash?: string;
  /** Bytes on disk, same scope as `contentHash`. */
  readonly sizeBytes?: number;
}
