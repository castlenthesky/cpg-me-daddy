// The Python adapter, MODULE tier (U6a.2-2). Ported in part from archive
// f18ee71:packages/engine/src/extract/python.ts: the declaration table (Pass A, U6a.2-3) and the
// expression half (Pass B, U6a.2-4) are not here yet, so `classify` has no rows and every other label
// is declared-not-emitted in the coverage table, never silent (I13).

import type {
  ContainerKind,
  CoverageManifest,
  DeclarationInfo,
  LanguageAdapter,
  SyntaxNode,
} from './contract';

/**
 * The dotted module name from the workspace root (rung 07): the `.py` suffix is dropped from the last
 * segment, case-insensitively (C-PARSE routes `SCRIPT.PY` to python); a last segment of `__init__`
 * is dropped too, naming its package, except at the workspace root, where it stays `__init__`;
 * the segments are joined with `.`. `main.py` -> `main`, `shapes/square.py` -> `shapes.square`,
 * `shapes/__init__.py` -> `shapes`. Source roots (`src/`) are the resolver's concern (U6c), not this.
 */
function moduleName(_path: string): string {
  throw new Error('SEAT: pythonAdapter.moduleName lands in U6a.2-2');
}

/** No declaration rows yet: every node is "no node for this" (sparse by design). */
function classify(_node: SyntaxNode, _container: ContainerKind): DeclarationInfo | undefined {
  throw new Error('SEAT: pythonAdapter.classify lands in U6a.2-2');
}

/**
 * Total over the 14 labels and 15 edge types (I13), honest against the ladder both ways (I14). The
 * same frozen object on every call (the nodes and edges records frozen too): compiled in, never
 * configuration.
 */
function coverage(): CoverageManifest {
  throw new Error('SEAT: pythonAdapter.coverage lands in U6a.2-2');
}

export const pythonAdapter: LanguageAdapter = {
  grammarId: 'python',
  language: 'python',
  moduleRootType: 'module',
  moduleName,
  classify,
  coverage,
};
