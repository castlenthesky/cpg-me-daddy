// The walker's admission rule as one predicate (U4.2.1, controller decision 61), so `cpg index` and
// `cpg watch` can never disagree about what belongs in the graph. The walker counts its stats from
// `check`; the watch session's `admit` is `admits`, which also refuses a path under an excluded
// directory, because a live event can name a path the walk never reaches.

import type { WorkspacePath } from '@cpg/model';

export interface AdmissionOptions {
  /** Default DEFAULT_INCLUDES. Applies to files only: a directory is never refused by `include`. */
  readonly include?: readonly string[];
  /** Default DEFAULT_EXCLUDES. A given list replaces the defaults. */
  readonly exclude?: readonly string[];
  /** Default DEFAULT_MAX_FILE_SIZE_BYTES. A file of exactly this size is admitted. */
  readonly maxFileSizeBytes?: number;
}

/** What the walker found at a path: lstat semantics, so a symlink is never a file or a directory. */
export type AdmissionEntry = 'file' | 'directory' | 'symlink';

export type AdmissionVerdict = 'admitted' | 'excluded' | 'too-large' | 'symlink';

export interface Admission {
  /**
   * The verdict for one entry of a directory the walk entered, in the walker's order:
   * - a symlink is `'symlink'`, whatever its path (never followed, never admitted);
   * - a directory is `'excluded'` when `exclude` matches it (`compileMatcher(...).test(path, true)`),
   *   else `'admitted'`; `include` and `sizeBytes` are ignored for a directory;
   * - a file is `'excluded'` when `exclude` matches it or `include` does not, then `'too-large'` when
   *   `sizeBytes` is given and over `maxFileSizeBytes`, else `'admitted'`.
   * Ancestors are not looked at: the walker never enters an excluded directory.
   */
  check(path: WorkspacePath, entry: AdmissionEntry, sizeBytes?: number): AdmissionVerdict;
  /**
   * True when `check` is `'admitted'` and no proper ancestor directory of `path` is excluded (an
   * excluded directory is never entered). The watch session's `admit`.
   */
  admits(path: WorkspacePath, entry: AdmissionEntry, sizeBytes?: number): boolean;
}

export function createAdmission(_options: AdmissionOptions): Admission {
  // SEAT: U4.2.1 part a
  throw new Error('SEAT: createAdmission lands with U4.2.1 part a');
}
