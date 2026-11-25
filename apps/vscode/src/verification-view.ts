// REAL (U3.1.1 part 2, BMO-52): a verify report as data for the editor's two surfaces (08-verification
// §3.3; C-EXT three_surfaces_for_verification). Part 4 gives it to VS Code's StatusBarItem and
// DiagnosticCollection('cpg'); the third surface, the banner, is the page's.

import {
  isWorkspacePath,
  parseNodeId,
  WORKSPACE_ROOT,
  type CheckState,
  type VerificationReport,
  type VerifyCheckId,
  type WorkspacePath,
} from '@cpg/model';

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

const GLYPHS: Readonly<Record<CheckState, VerificationStatus['glyph']>> = {
  pass: 'check',
  fail: 'error',
  stale: 'history',
  unavailable: 'question',
};

/** The report's state as `check` (pass), `error` (fail), `history` (stale) or `question` (unavailable). */
export function verificationStatus(report: VerificationReport): VerificationStatus {
  const failing = report.checks.filter((check) => check.state === 'fail').length;
  return { state: report.state, glyph: GLYPHS[report.state], failing };
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
  report: VerificationReport,
): readonly VerificationDiagnostic[] {
  const diagnostics: VerificationDiagnostic[] = [];
  for (const check of report.checks) {
    const detail = check.detail ?? check.state;
    if (check.id === 'revision-reconciliation') {
      for (const entry of check.localisedTo) {
        if (!isWorkspacePath(entry) || entry === WORKSPACE_ROOT) continue;
        diagnostics.push({
          filePath: entry,
          checkId: check.id,
          message: `${check.id}: ${detail}`,
        });
      }
    } else if (check.id === 'id-uniqueness' || check.id === 'render-reconciliation') {
      for (const id of check.localisedTo) {
        const parsed = parseNodeId(id);
        if (parsed === undefined || parsed.form === 'directory') continue;
        diagnostics.push({
          filePath: parsed.path,
          checkId: check.id,
          message: `${check.id}: ${detail} (${id})`,
        });
      }
    }
  }
  return diagnostics;
}

/** The status bar item's text and tooltip. */
export interface StatusBarView {
  readonly text: string;
  readonly tooltip: string;
}

/**
 * The report as the status bar shows it. Text: `$(<glyph>) CPG`, then ` <n>` when n > 0 checks fail.
 * Tooltip: `CPG verify at seq <seq>: <state>`, then a line per check in report order,
 * `<id>: <state>`, with `: <detail>` when it has one.
 */
export function statusBarView(report: VerificationReport): StatusBarView {
  const { glyph, failing } = verificationStatus(report);
  const text = failing > 0 ? `$(${glyph}) CPG ${String(failing)}` : `$(${glyph}) CPG`;
  const lines = [
    `CPG verify at seq ${String(report.seq)}: ${report.state}`,
    ...report.checks.map((check) =>
      check.detail === undefined
        ? `${check.id}: ${check.state}`
        : `${check.id}: ${check.state}: ${check.detail}`,
    ),
  ];
  return { text, tooltip: lines.join('\n') };
}
