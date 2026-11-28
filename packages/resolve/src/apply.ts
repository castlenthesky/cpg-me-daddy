// SEAT (U6c.1a): applyResolutions, the DQ-03 fold. Adapted from archive
// 21754b4:packages/file-watcher/src/resolvePass.ts: edges only, never a symbol; its counters become
// ResolveReport.
import type { EdgeElement, ExtractedFileSet } from '@cpg/extract';
import type { ResolveBatch, ResolveReport } from './contract';

/**
 * Turns answers into edges. Symbols come from the set (`createDefinitionLookup(set)`); this mints,
 * renames and changes none, and writes no node.
 *
 * Scope: the files the batches answer for (`diagnostics.filePath`). A batch's resolutions are matched
 * to that file's ref sites by `refId`; an answer for a site the file does not hold is ignored, and
 * when several batches answer one site the later batch's answer counts. Sites are visited in the
 * set's `refSites` order, which is also the order of `edges`.
 *
 * Each site of a file in scope counts once in `siteCount[kind]`. Its status and reason are its
 * answer's; with no answer it is `unresolved`, reason its `declined` or else `no-resolver`, and it
 * counts in no `byResolver` entry. `statusCount[kind][status]` and `reasonCount[reason]` count every
 * site (a site with no reason adds no reason count); `byResolver[resolvedBy]` every answered one.
 *
 * An answer of rank >= 2 (resolved, ambiguous, external) names a symbol by `target.fqn` when it has
 * a target (the target wins, never falling back to `definition`), else by
 * `symbolAt(definition.filePath, row, column)`. It yields an edge only when that fqn exists
 * (`hasSymbol`, INV-13) and the site's kind is `call` or `import`; otherwise it counts in
 * `droppedNoSymbol` (INV-26), and its status stays what the answer said. A `receiver` or
 * `receiver-type` answer never yields an edge in v1 (neither edge type is admitted) and never touches
 * a call's edge. An answer of rank <= 1 yields nothing.
 *
 * - call: CALLS from the CALL (`site.nodeId`, by id) to the SYMBOL (by fqn), properties
 *   `{ status, reason?, confidence, resolvedBy }` (reason only when the answer has one).
 * - import: IMPORTS from the IMPORT to the SYMBOL, properties `{ status }` (the schema's only one).
 * - One edge per (type, from, to): the first site's; a later site that lands on it adds no edge and
 *   is not dropped.
 *
 * Report: `siteCount` and `statusCount` carry all four kinds (0 / `{}` when none); `statusCount`'s
 * inner records, `reasonCount` and `byResolver` hold only values seen. `unresolvedRate[kind]` = `statusCount[kind].unresolved` / `siteCount[kind]` for each kind
 * with sites (absent otherwise, INV-21); `degradedBatches` the batches with `diagnostics.degraded`
 * (INV-25); `edgeCount` edges.length; `backendRestarts` 0, since no batch carries a restart count.
 */
export function applyResolutions(
  _set: ExtractedFileSet,
  _batches: readonly ResolveBatch[],
): { readonly edges: readonly EdgeElement[]; readonly report: ResolveReport } {
  throw new Error('SEAT: applyResolutions lands in U6c.1a');
}
