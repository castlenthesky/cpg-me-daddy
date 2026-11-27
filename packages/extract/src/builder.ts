// One file's elements, in emission order, checked against C-EXTRACT's runtime invariants (class R)
// before they leave extract. Ported from archive f18ee71:packages/engine/src/extract/delta.ts
// (DeltaBuilder): the output is now ExtractedFile's four arrays, not a GraphDelta of rows.

import { makeNodeId, type WorkspacePath } from '@cpg/model';
import type { EdgeElement, EndpointRef, NodeElement, RefSite, SymbolElement } from './contract';

const FORBIDDEN_NODE_LABELS: ReadonlySet<string> = new Set([
  'DIRECTORY',
  'FILE',
  'SYMBOL',
  'COMMUNITY',
  'TAG',
  'META_DATA',
]);
const NUL = '\u0000';

function propertyValuesEqual(
  a: SymbolElement['properties'][string] | undefined,
  b: SymbolElement['properties'][string] | undefined,
): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => item === b[index]);
  }
  return Object.is(a, b);
}

function symbolsEqual(a: SymbolElement, b: SymbolElement): boolean {
  if (a.fqn !== b.fqn || a.origin !== b.origin || a.language !== b.language) return false;
  const aEntries = Object.entries(a.properties);
  const bKeys = Object.keys(b.properties);
  if (aEntries.length !== bKeys.length) return false;
  return aEntries.every(
    ([key, value]) =>
      Object.hasOwn(b.properties, key) && propertyValuesEqual(value, b.properties[key]),
  );
}

function containsNul(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(NUL);
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsNul);
  for (const [key, entry] of Object.entries(value)) {
    if (key.includes(NUL) || containsNul(entry)) return true;
  }
  return false;
}

function checkEndpointScope(endpoint: EndpointRef, filePrefix: string, edgeType: string): void {
  if (endpoint.by === 'id' && !endpoint.key.startsWith(filePrefix)) {
    throw new ExtractInvariantError(
      'I10',
      `${edgeType} endpoint id ${JSON.stringify(endpoint.key)} does not start with ${JSON.stringify(filePrefix)}`,
    );
  }
}

function checkEndpointTarget(
  endpoint: EndpointRef,
  edgeType: string,
  nodeLabelsById: ReadonlyMap<string, string>,
  symbolsByFqn: ReadonlyMap<string, SymbolElement>,
): void {
  if (endpoint.by === 'id') {
    const actualLabel = nodeLabelsById.get(endpoint.key);
    if (actualLabel === undefined) {
      throw new ExtractInvariantError(
        'I9',
        `${edgeType} endpoint id ${JSON.stringify(endpoint.key)} names no node of this file`,
      );
    }
    if (actualLabel !== endpoint.label) {
      throw new ExtractInvariantError(
        'I9',
        `${edgeType} endpoint id ${JSON.stringify(endpoint.key)} has label ${endpoint.label}, expected ${actualLabel}`,
      );
    }
    return;
  }
  if (!symbolsByFqn.has(endpoint.key)) {
    throw new ExtractInvariantError(
      'I9',
      `${edgeType} endpoint fqn ${JSON.stringify(endpoint.key)} names no SYMBOL of this file`,
    );
  }
}

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
  private readonly nodes: NodeElement[] = [];
  private readonly symbols: SymbolElement[] = [];
  private readonly edges: EdgeElement[] = [];
  private readonly refSites: RefSite[] = [];

  constructor(path: WorkspacePath, revisionId: string) {
    this.path = path;
    this.revisionId = revisionId;
  }

  addNode(node: NodeElement): void {
    this.nodes.push(node);
  }

  addSymbol(symbol: SymbolElement): void {
    this.symbols.push(symbol);
  }

  addEdge(edge: EdgeElement): void {
    this.edges.push(edge);
  }

  addRefSite(site: RefSite): void {
    this.refSites.push(site);
  }

  build(): BuiltElements {
    const filePrefix = `${makeNodeId({ form: 'file', path: this.path })}:`;

    // I5: every node's `file` is this builder's path.
    for (const node of this.nodes) {
      if (node.file !== this.path) {
        throw new ExtractInvariantError(
          'I5',
          `node ${JSON.stringify(node.id)} has file ${JSON.stringify(node.file)}, expected ${JSON.stringify(this.path)}`,
        );
      }
    }

    // I6: every node id starts with the file id plus `:` and never embeds revision_id.
    for (const node of this.nodes) {
      if (!node.id.startsWith(filePrefix)) {
        throw new ExtractInvariantError(
          'I6',
          `node id ${JSON.stringify(node.id)} does not start with ${JSON.stringify(filePrefix)}`,
        );
      }
      if (this.revisionId !== '' && node.id.includes(this.revisionId)) {
        throw new ExtractInvariantError(
          'I6',
          `node id ${JSON.stringify(node.id)} contains revision_id`,
        );
      }
    }

    // I7: unique node ids; SYMBOLs deduped by fqn when deep-equal, conflicting otherwise.
    const nodeLabelsById = new Map<string, string>();
    for (const node of this.nodes) {
      if (nodeLabelsById.has(node.id)) {
        throw new ExtractInvariantError('I7', `duplicate node id ${JSON.stringify(node.id)}`);
      }
      nodeLabelsById.set(node.id, node.label);
    }

    const symbolsByFqn = new Map<string, SymbolElement>();
    const dedupedSymbols: SymbolElement[] = [];
    for (const symbol of this.symbols) {
      const existing = symbolsByFqn.get(symbol.fqn);
      if (existing === undefined) {
        symbolsByFqn.set(symbol.fqn, symbol);
        dedupedSymbols.push(symbol);
      } else if (!symbolsEqual(existing, symbol)) {
        throw new ExtractInvariantError(
          'I7',
          `conflicting SYMBOL fields for fqn ${JSON.stringify(symbol.fqn)}`,
        );
      }
    }

    // I8: file-owned nodes only.
    for (const node of this.nodes) {
      if (FORBIDDEN_NODE_LABELS.has(node.label)) {
        throw new ExtractInvariantError(
          'I8',
          `node ${JSON.stringify(node.id)} has forbidden label ${node.label}`,
        );
      }
    }

    // I10: `by: 'id'` endpoints stay within this file (checked before I9).
    for (const edge of this.edges) {
      checkEndpointScope(edge.from, filePrefix, edge.type);
      checkEndpointScope(edge.to, filePrefix, edge.type);
    }

    // I9: every endpoint names a node (matching label) or SYMBOL of this file.
    for (const edge of this.edges) {
      checkEndpointTarget(edge.from, edge.type, nodeLabelsById, symbolsByFqn);
      checkEndpointTarget(edge.to, edge.type, nodeLabelsById, symbolsByFqn);
    }

    // I19: no U+0000 anywhere in the four arrays.
    for (const [name, list] of [
      ['nodes', this.nodes],
      ['symbols', dedupedSymbols],
      ['edges', this.edges],
      ['refSites', this.refSites],
    ] as const) {
      if (containsNul(list)) {
        throw new ExtractInvariantError('I19', `${name} contains U+0000`);
      }
    }

    return {
      nodes: [...this.nodes],
      symbols: dedupedSymbols,
      edges: [...this.edges],
      refSites: [...this.refSites],
    };
  }
}
