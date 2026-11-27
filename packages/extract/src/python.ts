// The Python adapter: the MODULE tier (U6a.2-2) and the declaration half (U6a.2-3), ported from archive
// f18ee71:packages/engine/src/extract/python.ts (classifyFunction, classifyClass, classifyAssignment,
// paramInfo, the docstring helpers), plus `decorated_definition` (decision 107). The expression half
// (Pass B) is U6a.2-4; what it adds is declared-not-emitted in the coverage table, never silent (I13).

import type { WorkspacePath } from '@cpg/model';
import type {
  ContainerKind,
  CoverageManifest,
  DeclarationInfo,
  Disposition,
  LanguageAdapter,
  MemberInfo,
  MethodInfo,
  TypeDeclInfo,
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

/**
 * A `function_definition` (`name`, `parameters`, `body`, optional `return_type` fields; undefined
 * without a name or a parameters field):
 * - params: each named child of `parameters` in order: `identifier` (its text); `typed_parameter`
 *   (the name of its first named child, an identifier or a splat, with typeText its `type`);
 *   `default_parameter` and `typed_default_parameter` (`name`, with typeText `type` and defaultText
 *   `value` when present); `list_splat_pattern` and `dictionary_splat_pattern` (the identifier inside,
 *   no stars). Anything else (`/`, `*`, a tuple pattern) is no param.
 * - signature (archive): `<name>(<p>, ...)` with `<p>` = `name` or `name: typeText`, then
 *   ` -> <return_type text>` when there is one: `greet(name: str, times) -> str`.
 * - kind: in a TYPE_DECL `constructor` for `__init__`, else `method`; in the MODULE `function`.
 * - exported: the name has no leading `_`. async: the node's text starts with `async` and whitespace.
 * - docstringHead (archive; a class's too): the body's first named child is an `expression_statement`
 *   whose first named child is a `string`; that text without its prefix letters and matching quotes
 *   (`"""`, `'''`, `"`, `'`), trimmed, then its first line trimmed. None when absent or blank.
 * - nameNode: the `name` field; body: the `body` field.
 * SEAT until U6a.2-3's implementation.
 */
function classifyFunction(_node: SyntaxNode, _container: ContainerKind): MethodInfo | undefined {
  throw new Error('SEAT: python function declarations land in U6a.2-3');
}

/**
 * A `class_definition`: undefined without a `name`; else `{ declares: 'TYPE_DECL', name, kind:
 * 'class', exported (no leading `_`), structural: true, docstringHead?, body: the body field }`.
 * SEAT until U6a.2-3's implementation.
 */
function classifyClass(_node: SyntaxNode): TypeDeclInfo | undefined {
  throw new Error('SEAT: python class declarations land in U6a.2-3');
}

/**
 * An `expression_statement` whose first named child is an `assignment` with an `identifier` `left`
 * (`X = 1`, `X: int = 1`, `X: int`, the first name of `a = b = 1`): a MEMBER named by it, typeText its
 * `type` field, value its `right` field, each when present. A tuple, attribute or augmented
 * assignment, or any other statement, is undefined. SEAT until U6a.2-3's implementation.
 */
function classifyAssignment(node: SyntaxNode): MemberInfo | undefined {
  if (node.namedChildren[0]?.type !== 'assignment') return undefined;
  throw new Error('SEAT: python member declarations land in U6a.2-3');
}

/**
 * The declaration table (sparse by design: anything else is undefined): `function_definition`,
 * `class_definition`, an assignment `expression_statement`, and a `decorated_definition`, which is
 * whatever its `definition` field (a function or a class) classifies as in the same container, so the
 * walker gives it the decorated range (decision 107).
 */
function classify(node: SyntaxNode, container: ContainerKind): DeclarationInfo | undefined {
  switch (node.type) {
    case 'function_definition':
      return classifyFunction(node, container);
    case 'class_definition':
      return classifyClass(node);
    case 'expression_statement':
      return classifyAssignment(node);
    case 'decorated_definition':
      throw new Error('SEAT: python decorated definitions land in U6a.2-3');
    default:
      return undefined;
  }
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
