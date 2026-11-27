/**
 * The schema's `range` property string (04-schema.yaml MODULE.range; fixtures/ladder/README.md; controller
 * decision 89, ported from archive 27361a3:packages/engine/src/extract/range.ts).
 *
 * `startLine:startCol-endLine:endCol`: lines 1-based (what an editor gutter shows), columns 0-based UTF-16
 * code units (what the parser and `vscode.Position` report), end exclusive. The extractor emits
 * `SourceRange` objects; the store's write op formats them with this. Navigation only, never identity.
 *
 * Throws `Error('invalid source range: <reason>')` when a field is not a non-negative safe integer or the
 * end comes before the start (a producer bug). An empty range (start === end) is valid: an empty file's
 * MODULE is `1:0-1:0`.
 */

/**
 * Formats a 0-based range as the schema's `range` string. Pure; throws on an invalid range. The parameter
 * is `SourceRange`'s shape, spelt out because `../index.ts` (which declares it) imports this module.
 */
export function formatRange(_range: {
  readonly startRow: number;
  readonly startColumn: number;
  readonly endRow: number;
  readonly endColumn: number;
}): string {
  // SEAT: lands in U6a.2-1 (controller decision 89)
  throw new Error('SEAT: formatRange is not built yet (U6a.2-1)');
}
