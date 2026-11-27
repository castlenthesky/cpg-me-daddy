// The Python adapter, MODULE tier (U6a.2-2). Ported in part from archive
// f18ee71:packages/engine/src/extract/python.ts: the declaration table (Pass A, U6a.2-3) and the
// expression half (Pass B, U6a.2-4) are not here yet, so `classify` has no rows and every other label
// is declared-not-emitted in the coverage table, never silent (I13).

import type { WorkspacePath } from '@cpg/model';
import type {
  ContainerKind,
  CoverageManifest,
  DeclarationInfo,
  Disposition,
  LanguageAdapter,
  SyntaxNode,
} from './contract';
import { EXTRACT_CONTRACT_VERSION } from './version';

const emits = (...fromNodeTypes: readonly string[]): Disposition =>
  Object.freeze({ state: 'emits', fromNodeTypes: Object.freeze([...fromNodeTypes]) });

const notMine = (
  owner: 'filesystem-tier' | 'resolve-pass' | 'analysis-pass' | 'meta',
): Disposition => Object.freeze({ state: 'not-mine', owner });

const later = (reason: string, trackingId: string): Disposition =>
  Object.freeze({ state: 'declared-not-emitted', reason, trackingId });

const PYTHON_COVERAGE: CoverageManifest = Object.freeze({
  contractVersion: EXTRACT_CONTRACT_VERSION,
  grammarId: 'python',
  nodes: Object.freeze({
    DIRECTORY: notMine('filesystem-tier'),
    FILE: notMine('filesystem-tier'),
    MODULE: emits('module'),
    TYPE_DECL: later('Pass A declarations land in U6a.2-3', 'U6a.2-3'),
    METHOD: later('Pass A declarations land in U6a.2-3', 'U6a.2-3'),
    PARAM: later('Pass A declarations land in U6a.2-3', 'U6a.2-3'),
    MEMBER: later('Pass A declarations land in U6a.2-3', 'U6a.2-3'),
    CALL: later('Pass B calls land in U6a.2-4', 'U6a.2-4'),
    IMPORT: later('Pass B imports land in U6a.2-4', 'U6a.2-4'),
    SYMBOL: emits('module'),
    COMMUNITY: notMine('analysis-pass'),
    TAG: notMine('meta'),
    UNKNOWN: later('syntax-error regions (decision 95) land in U6a.2-3', 'U6a.2-3'),
    META_DATA: notMine('meta'),
  }),
  edges: Object.freeze({
    HAS_ENTRY: notMine('filesystem-tier'),
    DECLARES: later('Pass A declarations land in U6a.2-3', 'U6a.2-3'),
    HAS_PARAM: later('Pass A parameter edges land in U6a.2-3', 'U6a.2-3'),
    DEFINES: emits('module'),
    CALLS: later('Pass B same-file CALLS (decision 93) land in U6a.2-4', 'U6a.2-4'),
    IN_SCOPE: later('Pass B call scopes land in U6a.2-4', 'U6a.2-4'),
    IMPORTS: notMine('resolve-pass'),
    INHERITS_FROM: later(
      'per-file inheritance with a SYMBOL endpoint; no unit scheduled',
      'C-EXTRACT Q3',
    ),
    MEMBER_OF: notMine('analysis-pass'),
    ALIAS_OF: notMine('resolve-pass'),
    TAGGED_BY: notMine('meta'),
    TARGETS: notMine('analysis-pass'),
    DEPENDS_ON: notMine('analysis-pass'),
    REACHING_DEF: later('Pass B sparse data-flow lands in U6a.2-4', 'U6a.2-4'),
    SOURCE_FILE: notMine('filesystem-tier'),
  }),
});

/**
 * The dotted module name from the workspace root (rung 07): the `.py` suffix is dropped from the last
 * segment, case-insensitively (C-PARSE routes `SCRIPT.PY` to python); a last segment of `__init__`
 * is dropped too, naming its package, except at the workspace root, where it stays `__init__`;
 * the segments are joined with `.`. `main.py` -> `main`, `shapes/square.py` -> `shapes.square`,
 * `shapes/__init__.py` -> `shapes`. Source roots (`src/`) are the resolver's concern (U6c), not this.
 */
function moduleName(path: WorkspacePath): string {
  const segments = path.split('/');
  const last = segments.at(-1);
  if (last === undefined) return path;
  const stem = last.replace(/\.py$/i, '');
  segments[segments.length - 1] = stem;
  if (segments.length > 1 && stem === '__init__') {
    segments.pop();
  }
  return segments.join('.');
}

/** No declaration rows yet: every node is "no node for this" (sparse by design). */
function classify(_node: SyntaxNode, _container: ContainerKind): DeclarationInfo | undefined {
  return undefined;
}

/**
 * Total over the 14 labels and 15 edge types (I13), honest against the ladder both ways (I14). The
 * same frozen object on every call (the nodes and edges records frozen too): compiled in, never
 * configuration.
 */
function coverage(): CoverageManifest {
  return PYTHON_COVERAGE;
}

export const pythonAdapter: LanguageAdapter = {
  grammarId: 'python',
  language: 'python',
  moduleRootType: 'module',
  moduleName,
  classify,
  coverage,
};
