// One file's elements, in emission order, checked against C-EXTRACT's runtime invariants (class R)
// before they leave extract. Ported from archive f18ee71:packages/engine/src/extract/delta.ts
// (DeltaBuilder): the output is now ExtractedFile's four arrays, not a GraphDelta of rows.

import type { WorkspacePath } from '@cpg/model';
import type { EdgeElement, NodeElement, RefSite, SymbolElement } from './contract';

/** The runtime invariants `ElementBuilder.build` asserts. */
export type CheckedInvariant = 'I5' | 'I6' | 'I7' | 'I8' | 'I9' | 'I10' | 'I19';

/**
 * A broken C-EXTRACT runtime invariant: a walker or adapter bug, never bad input. `extract` turns it
 * into `failed: internal` (I4). The message starts `C-EXTRACT <invariant>: `.
 */
export class ExtractInvariantError extends Error {
  readonly invariant: CheckedInvariant;

  constructor(invariant: CheckedInvariant, detail: string) {
    super(`C-EXTRACT ${invariant}: ${detail}`);
    this.name = 'ExtractInvariantError';
    this.invariant = invariant;
  }
}

/** ExtractedFile's four arrays. */
export interface BuiltElements {
  readonly nodes: readonly NodeElement[];
  readonly symbols: readonly SymbolElement[];
  readonly edges: readonly EdgeElement[];
  readonly refSites: readonly RefSite[];
}

/**
 * Accumulates one file's elements. `build()` checks everything added, then returns each array in the
 * order its elements were added (I3). It throws `ExtractInvariantError` on the first broken rule:
 * - I5: a node's `file` is not the builder's path.
 * - I6: a node id does not start with the file's id plus `:` (`makeNodeId({ form: 'file', path })`,
 *   so `file:main.py:`), or it contains the revision_id (when the revision_id is non-empty).
 * - I7: two nodes share an id, or two SYMBOLs share an fqn with different fields. A SYMBOL added again
 *   with deep-equal fields is kept once, at its first position.
 * - I8: a node's label is DIRECTORY, FILE, SYMBOL, COMMUNITY, TAG or META_DATA.
 * - I10: a `by: 'id'` endpoint whose key does not start with the file's id plus `:` (another file's
 *   node; cross-file travels only through a SYMBOL fqn). Checked before I9.
 * - I9: a `by: 'id'` endpoint naming no node of this file, or one whose label differs from that
 *   node's; a `by: 'fqn'` endpoint naming no SYMBOL of this file.
 * - I19: any string anywhere in the four arrays (ids, keys, properties, list items, ref-site fields)
 *   contains U+0000.
 */
export class ElementBuilder {
  readonly path: WorkspacePath;
  readonly revisionId: string;

  constructor(path: WorkspacePath, revisionId: string) {
    this.path = path;
    this.revisionId = revisionId;
  }

  addNode(_node: NodeElement): void {
    throw new Error('SEAT: ElementBuilder lands in U6a.2-2');
  }

  addSymbol(_symbol: SymbolElement): void {
    throw new Error('SEAT: ElementBuilder lands in U6a.2-2');
  }

  addEdge(_edge: EdgeElement): void {
    throw new Error('SEAT: ElementBuilder lands in U6a.2-2');
  }

  addRefSite(_site: RefSite): void {
    throw new Error('SEAT: ElementBuilder lands in U6a.2-2');
  }

  build(): BuiltElements {
    throw new Error('SEAT: ElementBuilder lands in U6a.2-2');
  }
}
