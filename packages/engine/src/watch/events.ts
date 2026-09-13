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
}
