// The walker skeleton (U6a.2-2): the MODULE, its SYMBOL and DEFINES, and the container shell that
// later passes grow from. Adapted from archive f18ee71:packages/engine/src/extract/walk.ts
// (extractDeclarations): ids come from `makeNodeId` with the `$root` frame (decision 92), fqns from
// `makeSymbolFqn` (decision 90), and resolveCallee is gone (U6a.2 acceptance). SEAT: Pass A
// declarations (U6a.2-3) and Pass B regions (U6a.2-4).

import type { ElementBuilder } from './builder';
import type { ExtractOutcome, ExtractRequest, LanguageAdapter } from './contract';

/** The truncation report of an `ExtractOutcome` of kind `truncated`. */
type Truncation = Extract<ExtractOutcome, { kind: 'truncated' }>['truncation'];

export interface WalkResult {
  /** AST nodes the walker visited, the root included. */
  readonly astNodesVisited: number;
  /** Present iff a budget limit stopped the walk (I17). */
  readonly truncation?: Truncation;
}

/**
 * Walks `request.root` (already checked: its type is `adapter.moduleRootType`, the budget is valid)
 * into `builder`, in this order:
 * 1. the MODULE node: id `makeNodeId({ form: 'scoped', path, kind: 'MODULE', scope: ['$root'] })`,
 *    `file` the path, the request's revision_id, tier `structural`, no nameRange, properties
 *    `{ name: adapter.moduleName(path), status: 'ready' }`. Its range is the whole file: it starts at
 *    row 0, column 0 (tree-sitter starts the root after leading blank lines) and ends at the root's
 *    endPosition (ladder README: a two-line file ends at `3:0`, an empty file is `1:0-1:0`);
 * 2. the module SYMBOL: fqn `makeSymbolFqn({ form: 'local', path, descriptors: [] })` (`` `main.py`/ ``),
 *    origin `local`, language `adapter.language`, properties `{ kind: 'module' }`;
 * 3. the DEFINES edge from the MODULE (by id) to that SYMBOL (by fqn), properties `{}`;
 * 4. the container shell: each of `root.namedChildren` in order is visited (counted) and classified
 *    with `adapter.classify(child, 'MODULE')`. `undefined` emits nothing (its Pass B region is
 *    U6a.2-4). A DeclarationInfo throws `SEAT: Pass A declarations land in U6a.2-3`.
 *
 * Budget (no hidden default, I17): the root is depth 0 and always visited; a top-level child is depth 1.
 * Before visiting a child, the walk stops if its depth exceeds `maxDepth` (limit `maxDepth`) or if
 * visiting it would make `astNodesVisited` exceed `maxNodes` (limit `maxNodes`), checked in that order.
 * The truncation names the limit, its value, and the child's type and 0-based range; what was built
 * before it stays.
 */
export function walkFile(
  _request: ExtractRequest,
  _adapter: LanguageAdapter,
  _builder: ElementBuilder,
): WalkResult {
  throw new Error('SEAT: walkFile lands in U6a.2-2');
}
