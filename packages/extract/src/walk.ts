// The walker (U6a.2-2, U6a.2-3): the MODULE tier and Pass A, the declarations. Adapted from archive
// f18ee71:packages/engine/src/extract/walk.ts (extractDeclarations, walkContainer, emitTypeDecl,
// emitMethod, emitMember, defineSymbol): ids come from `makeNodeId` with the `$root` frame and no
// module frame in children's scopes (decision 92), fqns from `makeSymbolFqn` (decisions 90, 91), and
// resolveCallee is gone (U6a.2 acceptance). Pass B (calls, imports, ref sites) is U6a.2-4.

import { makeNodeId, makeSymbolFqn, MODULE_SCOPE, type SourceRange } from '@cpg/model';
import type { ElementBuilder } from './builder';
import type { ExtractOutcome, ExtractRequest, LanguageAdapter, SyntaxNode } from './contract';

/** The truncation report of an `ExtractOutcome` of kind `truncated`. */
type Truncation = Extract<ExtractOutcome, { kind: 'truncated' }>['truncation'];

export interface WalkResult {
  /** AST nodes the walker visited, the root included. */
  readonly astNodesVisited: number;
  /** Present iff a budget limit stopped the walk (I17). */
  readonly truncation?: Truncation;
}

function nodeRange(node: SyntaxNode): SourceRange {
  return {
    startRow: node.startPosition.row,
    startColumn: node.startPosition.column,
    endRow: node.endPosition.row,
    endColumn: node.endPosition.column,
  };
}

/**
 * Walks `request.root` (already checked: its type is `adapter.moduleRootType`, the budget is valid)
 * into `builder`. Every node is `file` the path, the request's revision_id, tier `structural`.
 *
 * 1. The MODULE: id `makeNodeId({ form: 'scoped', path, kind: 'MODULE', scope: ['$root'] })`, no
 *    nameRange, properties `{ name: adapter.moduleName(path), status: 'ready' }`. Its range is the whole
 *    file: from row 0, column 0 (tree-sitter starts the root after leading blank lines) to the root's
 *    endPosition (ladder README: a two-line file ends at `3:0`, an empty file is `1:0-1:0`). Then its
 *    SYMBOL `` `path`/ `` (origin `local`, language `adapter.language`, properties `{ kind: 'module' }`)
 *    and the DEFINES edge from the MODULE (by id) to it (by fqn). Every edge has properties `{}`.
 * 2. Pass A over containers: the MODULE's children are `root.namedChildren`, a TYPE_DECL's are
 *    `info.body.namedChildren` (none without a body). In order, each child is visited, then:
 *    - type `ERROR` (tree-sitter's, any grammar): one UNKNOWN, never classified or descended (decision
 *      95). Id `UNKNOWN:<s>:<n>` with s = `$root` in the MODULE or the TYPE_DECL's scope, and n = the
 *      count of earlier UNKNOWNs with that same scope in this file. Range: the ERROR's. Properties
 *      `{ reason: 'syntax-error', status: 'ready' }`. No edge, no SYMBOL.
 *    - else `adapter.classify(child, 'MODULE' | 'TYPE_DECL')`; `undefined` emits nothing.
 *    A declaration's scope is its container's scope (`[]` in the MODULE) plus its name, and its range
 *    is the classified child's (a whole `decorated_definition`, decision 107). It gets a DECLARES edge
 *    from its container, a SYMBOL whose descriptors are its container's plus its own (TYPE_DECL `type`,
 *    METHOD `method`, MEMBER `term`), and a DEFINES edge to it:
 *    - TYPE_DECL: properties `{ name, kind, exported, status: 'ready', structural, docstring_head? }`;
 *      SYMBOL kind `class`. Then its body is walked as a container.
 *    - METHOD: properties `{ name, kind, signature, params_count: params.length, exported, async,
 *      status: 'ready', docstring_head? }`, and nameRange = `info.nameNode`'s range when given (decision
 *      113); SYMBOL kind `method` in a TYPE_DECL, `function` in the MODULE. Then one PARAM per param in
 *      order: id `PARAM:<method scope>.<name>`, range the param node's, properties `{ name, ordinal,
 *      type_text?, default? }`, a HAS_PARAM edge from the METHOD, no SYMBOL (decision 91). Its body is
 *      not walked (Pass B; nested named declarations are never descended, decision 92).
 *    - MEMBER: properties `{ name, type_text?, visibility? }`; SYMBOL kind `variable`. Its value is
 *      not walked (Pass B).
 *    A property marked `?` is present only when its info field is.
 *    Duplicates (a redefinition, a property's getter and setter): a TYPE_DECL, METHOD, MEMBER or PARAM
 *    whose ordinal-free id was already minted in this file takes ordinal k for its k-th repeat
 *    (`METHOD:C.label:1`), so I7 holds; it DEFINES the same SYMBOL, emitted once. Its descendants
 *    follow the same rule.
 * 3. Order (I3): nodes in source pre-order (the MODULE; each declaration, then its PARAMs, then its
 *    body's). After a declaration's node: its DECLARES edge, its SYMBOL and DEFINES edge, then each
 *    PARAM node and its HAS_PARAM edge, all before anything of the next one.
 *
 * Budget (no hidden default, I17): the root is depth 0 and always visited; a container's child is one
 * deeper than the container (a top-level child 1, a top-level class's member 2). Before visiting a
 * child, the walk stops if its depth exceeds `maxDepth` (limit `maxDepth`) or if visiting it would make
 * `astNodesVisited` exceed `maxNodes` (limit `maxNodes`), checked in that order. Only container
 * children count as visited (never a parameter or a body). The truncation names the limit, its value,
 * and the child's type and 0-based range; the whole walk stops there and what was built stays.
 */
export function walkFile(
  request: ExtractRequest,
  adapter: LanguageAdapter,
  builder: ElementBuilder,
): WalkResult {
  const { path, root, revision_id, budget } = request;
  const moduleId = makeNodeId({ form: 'scoped', path, kind: 'MODULE', scope: [MODULE_SCOPE] });
  const moduleFqn = makeSymbolFqn({ form: 'local', path, descriptors: [] });

  builder.addNode({
    label: 'MODULE',
    id: moduleId,
    file: path,
    revision_id,
    tier: 'structural',
    range: {
      startRow: 0,
      startColumn: 0,
      endRow: root.endPosition.row,
      endColumn: root.endPosition.column,
    },
    properties: {
      name: adapter.moduleName(path),
      status: 'ready',
    },
  });

  builder.addSymbol({
    fqn: moduleFqn,
    origin: 'local',
    language: adapter.language,
    properties: { kind: 'module' },
  });

  builder.addEdge({
    type: 'DEFINES',
    from: { by: 'id', label: 'MODULE', key: moduleId },
    to: { by: 'fqn', label: 'SYMBOL', key: moduleFqn },
    properties: {},
  });

  let astNodesVisited = 1;
  const maxDepth = budget?.maxDepth;
  const maxNodes = budget?.maxNodes;
  const childDepth = 1;

  for (const child of root.namedChildren) {
    if (maxDepth !== undefined && childDepth > maxDepth) {
      return {
        astNodesVisited,
        truncation: {
          limit: 'maxDepth',
          limitValue: maxDepth,
          droppedAtNodeType: child.type,
          droppedRange: nodeRange(child),
        },
      };
    }
    if (maxNodes !== undefined && astNodesVisited + 1 > maxNodes) {
      return {
        astNodesVisited,
        truncation: {
          limit: 'maxNodes',
          limitValue: maxNodes,
          droppedAtNodeType: child.type,
          droppedRange: nodeRange(child),
        },
      };
    }
    astNodesVisited += 1;
    if (child.type === 'ERROR' || adapter.classify(child, 'MODULE') !== undefined) {
      throw new Error('SEAT: Pass A declarations land in U6a.2-3');
    }
  }

  return { astNodesVisited };
}
