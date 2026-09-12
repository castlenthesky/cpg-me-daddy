/**
 * The structural seam between the extractor and a concrete parse tree.
 *
 * `ParserBackend<TTree = unknown>` (../parser/backend.ts) keeps `ParsedSource.tree`
 * opaque by design — F4 explicitly deferred queries/extraction to later units.
 * Extending that interface here would be more seam than this unit needs.
 * Instead, `SyntaxNode` is a plain structural interface: `web-tree-sitter`'s
 * `Node` satisfies it with zero runtime cost (no wrapper, no adapter object),
 * and so would any other binding later. It also lets the walker be tested
 * against hand-built fake nodes with no wasm runtime at all — see
 * `test/unit/extract/walk.test.ts`.
 */
export interface SyntaxPoint {
  readonly row: number;
  readonly column: number;
}

export interface SyntaxNode {
  readonly type: string;
  readonly startPosition: SyntaxPoint;
  readonly endPosition: SyntaxPoint;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly namedChildren: readonly SyntaxNode[];
  childForFieldName(fieldName: string): SyntaxNode | null;
  readonly text: string;
}
