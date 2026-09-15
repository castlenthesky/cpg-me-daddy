/**
 * The single "does this path belong in the filesystem tier?" predicate,
 * shared by the walker (`walker.ts`, one `Dirent` per call) and the watcher
 * (`watch/watch-workspace.ts`, one `lstat()` result per call) so the two can
 * never silently disagree about excludes, the size limit, or symlinks. Before
 * this file existed, `maxFileSizeBytes` and `followSymlinks` were enforced
 * only in the walker — a file too large for the initial walk would still be
 * read whole and admitted by a live watcher, and a symlink the walker skips
 * by default could be indexed the moment it changed on disk. This predicate
 * makes that divergence structurally impossible rather than merely absent.
 *
 * Binary-content detection is a known gap on BOTH sides, deliberately not
 * resolved here: adding it to only one caller would reintroduce exactly the
 * asymmetry this predicate exists to remove, and a real check needs to read
 * file bytes, which the walker does not otherwise do for every visited file.
 */
import type { PathMatcher } from "./glob";

export interface AdmitMatchers {
  readonly include: PathMatcher;
  readonly exclude: PathMatcher;
}

export interface AdmitLimits {
  readonly maxFileSizeBytes: number;
  readonly followSymlinks: boolean;
}

/**
 * The subset of `fs.Dirent`/`fs.Stats` this predicate needs. Never resolved
 * through a symlink — a walker `Dirent` and a watcher `lstat()` result agree
 * on this by construction — so `isDirectory`/`isRegularFile` describe the
 * entry itself, never a symlink's target.
 */
export interface AdmitStat {
  readonly isSymbolicLink: boolean;
  readonly isDirectory: boolean;
  readonly isRegularFile: boolean;
  /** Bytes on disk. Ignored for directories; treated as `0` if omitted for a file. */
  readonly sizeBytes?: number;
}

export type AdmitReason = "symlink" | "excluded" | "non-regular" | "too-large";

export type AdmitVerdict =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: AdmitReason };

const ADMITTED: AdmitVerdict = { admitted: true };

/**
 * @param relPath POSIX, workspace-relative, no leading slash.
 */
export function admitEntry(
  relPath: string,
  stat: AdmitStat,
  matchers: AdmitMatchers,
  limits: AdmitLimits,
): AdmitVerdict {
  if (stat.isSymbolicLink && !limits.followSymlinks) {
    return { admitted: false, reason: "symlink" };
  }

  if (stat.isDirectory) {
    // Only `exclude` prunes directory descent. Testing `include` here too
    // (as the pre-existing watcher's `isExcludedPath` did) would wrongly
    // prune a directory that doesn't itself match an include pattern but
    // contains files that do — the walker never made that mistake; this
    // predicate now makes it impossible for the watcher to make it either.
    return matchers.exclude.test(relPath, true)
      ? { admitted: false, reason: "excluded" }
      : ADMITTED;
  }

  if (!stat.isRegularFile) {
    return { admitted: false, reason: "non-regular" };
  }

  if (matchers.exclude.test(relPath, false) || !matchers.include.test(relPath, false)) {
    return { admitted: false, reason: "excluded" };
  }

  if ((stat.sizeBytes ?? 0) > limits.maxFileSizeBytes) {
    return { admitted: false, reason: "too-large" };
  }

  return ADMITTED;
}
