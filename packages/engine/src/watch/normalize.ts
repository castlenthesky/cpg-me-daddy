/**
 * Pure helpers for turning a settled batch of raw watch events into
 * `NormalizedChange`s (`./events.ts`) — this module's own vocabulary, never
 * the graph's. It used to import `FsMove` from `../store/cypher`; that was
 * the watcher's last remaining dependency on graph-store types, and it's
 * gone now — `PairedMove` below is entirely local. No I/O here —
 * `watch-workspace.ts` does the stat()/readFile() calls and hands this file
 * plain data.
 *
 * Exclude/include re-filtering: `@parcel/watcher`'s own `ignore` option (used
 * as a coarse, best-effort pre-filter in `watch-workspace.ts`) is never the
 * authoritative boundary — it can't express this project's hand-rolled glob
 * dialect (leading-`/` root anchors, trailing-`/` dir-only forms; see
 * `workspace/glob.ts`'s module doc). `isExcludedPath` re-applies the exact
 * same `compileMatcher` the walker itself uses, so the watch and the walk
 * can never silently disagree about what belongs in the graph.
 */
import { admitEntry, type AdmitLimits, type AdmitMatchers } from "../workspace/admit";
import type { PathMatcher } from "../workspace/glob";

export interface KnownFile {
  readonly contentHash: string;
}

/**
 * The glob-only check, for a path that has already vanished (a delete
 * event) — there is no `lstat()` to read a size or a symlink bit from, so
 * this delegates to `admitEntry` (`workspace/admit.ts`) with limits that
 * pass both through unconditionally. `watch-workspace.ts` calls `admitEntry`
 * directly for create/update events, where a real `lstat()` is available and
 * the size/symlink checks matter.
 */
export function isExcludedPath(
  relPath: string,
  isDirectory: boolean,
  include: PathMatcher,
  exclude: PathMatcher,
): boolean {
  const matchers: AdmitMatchers = { include, exclude };
  const limits: AdmitLimits = { maxFileSizeBytes: Number.POSITIVE_INFINITY, followSymlinks: true };
  const verdict = admitEntry(
    relPath,
    { isSymbolicLink: false, isDirectory, isRegularFile: !isDirectory },
    matchers,
    limits,
  );
  return !verdict.admitted;
}

export interface HashedCreate {
  readonly contentHash: string;
  readonly sizeBytes: number;
}

/** A file rename this batch detected — never a directory (see this
 *  function's own doc: directory moves have no producer here yet). */
export interface PairedMove {
  readonly fromPath: string;
  readonly toPath: string;
  readonly kind: "file";
}

export interface PairFileRenamesResult {
  readonly moves: readonly PairedMove[];
  /** File deletes that found no matching create in this batch — real removals. */
  readonly removals: readonly string[];
  /** Creates that found no matching delete — real creates/changes, keyed by destination path. */
  readonly survivingCreates: ReadonlyMap<string, HashedCreate>;
}

/**
 * Pairs a file delete with a same-batch file create sharing the same
 * content hash into a move — the common `git mv` / editor-rename case.
 * Rename pairing by inode+dev (the fuller `40-research.yaml` policy) is
 * deferred; content-hash pairing covers the common case with no inode
 * bookkeeping.
 */
export function pairFileRenames(
  fileDeletes: readonly string[],
  hashedCreates: ReadonlyMap<string, HashedCreate>,
  knownFiles: ReadonlyMap<string, KnownFile>,
): PairFileRenamesResult {
  const moves: PairedMove[] = [];
  const removals: string[] = [];
  const survivingCreates = new Map(hashedCreates);

  for (const fromPath of fileDeletes) {
    const known = knownFiles.get(fromPath);
    const match =
      known === undefined
        ? undefined
        : [...survivingCreates.entries()].find(([, h]) => h.contentHash === known.contentHash);
    if (match === undefined) {
      removals.push(fromPath);
      continue;
    }
    const [toPath] = match;
    moves.push({ fromPath, toPath, kind: "file" });
    survivingCreates.delete(toPath);
  }

  return { moves, removals, survivingCreates };
}
