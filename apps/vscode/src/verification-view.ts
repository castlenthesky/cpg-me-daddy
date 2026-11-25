// SEAT (U3.1.1 part 2, BMO-52): a verify report as data for the editor's two surfaces (08-verification
// §3.3; C-EXT three_surfaces_for_verification). Part 4 gives it to VS Code's StatusBarItem and
// DiagnosticCollection('cpg'); the third surface, the banner, is the page's.

import type { CheckState, VerificationReport, VerifyCheckId, WorkspacePath } from '@cpg/model';

/** The status bar's one glyph: the worst state, and how many checks failed. */
export interface VerificationStatus {
  readonly state: CheckState;
  /** A codicon id: part 4 writes `$(<glyph>)`. */
  readonly glyph: 'check' | 'error' | 'history' | 'question';
  /** Checks in state `fail`; `stale` and `unavailable` are not failures. */
  readonly failing: number;
}

/** One problem on one file the human can open. */
export interface VerificationDiagnostic {
  readonly filePath: WorkspacePath;
  readonly checkId: VerifyCheckId;
  readonly message: string;
}

/** The report's state as `check` (pass), `error` (fail), `history` (stale) or `question` (unavailable). */
export function verificationStatus(_report: VerificationReport): VerificationStatus {
  throw new Error('SEAT: verificationStatus lands with U3.1.1 part 2');
}

/**
 * One entry per offender that is, or is inside, a file, in report order and then `localisedTo` order:
 * - revision-reconciliation names files. Message `<check id>: <detail>`.
 * - id-uniqueness and render-reconciliation name node ids; the file is the one the id is addressed in
 *   (parseNodeId, whose uses include error localisation). Message `<check id>: <detail> (<id>)`. An
 *   id with no file (a DIRECTORY's, or one the id rule does not address) has no entry.
 * - filesystem-reconciliation names directories, and the other two have no offenders before U6c:
 *   no entries. The status bar and the banner still show them.
 *
 * With no detail, the check's state stands in for it. An entry that is not a well-formed workspace
 * path, or is the root, has no entry.
 */
export function verificationDiagnostics(
  _report: VerificationReport,
): readonly VerificationDiagnostic[] {
  throw new Error('SEAT: verificationDiagnostics lands with U3.1.1 part 2');
}
