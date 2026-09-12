/**
 * The one range format every :CPG node's `range` property uses (PR1: ranges
 * are for navigation, never identity — see `identity/node-id.ts`).
 *
 * `startLine:startCol-endLine:endCol`. Lines are 1-based (editor convention);
 * columns are 0-based (tree-sitter's own convention, and what every grammar's
 * `Point` already reports) — deliberately mixed rather than forcing one
 * convention on both, so a line number matches what a human sees in an editor
 * gutter while a column offset matches what the grammar returns with no
 * translation.
 */

/** A zero-based row/column pair, matching tree-sitter's `Point` shape. */
export interface SourcePoint {
  readonly row: number;
  readonly column: number;
}

/** Formats a `range` property from a pair of tree-sitter points. */
export function formatRange(start: SourcePoint, end: SourcePoint): string {
  return `${start.row + 1}:${start.column}-${end.row + 1}:${end.column}`;
}
