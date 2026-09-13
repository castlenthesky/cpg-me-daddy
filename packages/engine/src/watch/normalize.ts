import type { FsMove } from "../store/cypher";
/**
 * Pure helpers for turning a settled batch of raw watch events into the
 * filesystem tier's own vocabulary (`FsMove`/`FsRemoval`/`FsFileRow`/
 * `FsDirectoryRow`, `store/cypher.ts`). No I/O here — `watch-workspace.ts`
 * does the stat()/readFile() calls and hands this file plain data.
 *
 * Exclude/include re-filtering: `@parcel/watcher`'s own `ignore` option (used
 * as a coarse, best-effort pre-filter in `watch-workspace.ts`) is never the
 * authoritative boundary — it can't express this project's hand-rolled glob
 * dialect (leading-`/` root anchors, trailing-`/` dir-only forms; see
 * `workspace/glob.ts`'s module doc). `isExcludedPath` re-applies the exact
 * same `compileMatcher` the walker itself uses, so the watch and the walk
 * can never silently disagree about what belongs in the graph.
 */
import type { PathMatcher } from "../workspace/glob";
import { baseName, parentDirPath } from "../workspace/paths";

export interface KnownFile {
  readonly contentHash: string;
  readonly parent: string;
}

export function isExcludedPath(
  relPath: string,
  isDirectory: boolean,
  include: PathMatcher,
  exclude: PathMatcher,
): boolean {
  return exclude.test(relPath, isDirectory) || !include.test(relPath, isDirectory);
}

export interface HashedCreate {
  readonly contentHash: string;
  readonly loc: number;
}

export interface PairFileRenamesResult {
  readonly moves: readonly FsMove[];
  /** File deletes that found no matching create in this batch — real removals. */
  readonly removals: readonly string[];
  /** Creates that found no matching delete — real creates/changes, keyed by destination path. */
  readonly survivingCreates: ReadonlyMap<string, HashedCreate>;
}

/**
 * Pairs a file delete with a same-batch file create sharing the same
 * content hash into a move — the common `git mv` / editor-rename case.
 * Rename pairing by inode+dev (the fuller `40-research.yaml` policy) is
 * deferred to M1.1; content-hash pairing covers the common case with no
 * inode bookkeeping.
 */
export function pairFileRenames(
  fileDeletes: readonly string[],
  hashedCreates: ReadonlyMap<string, HashedCreate>,
  knownFiles: ReadonlyMap<string, KnownFile>,
): PairFileRenamesResult {
  const moves: FsMove[] = [];
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
    moves.push({
      fromPath,
      toPath,
      toName: baseName(toPath),
      toParent: parentDirPath(toPath),
      kind: "file",
    });
    survivingCreates.delete(toPath);
  }

  return { moves, removals, survivingCreates };
}
