// The Python adapter's module names, coverage table and registry (decision 96). Module names come
// from the ladder (rungs 01, 06, 07). The coverage rows come from C-EXTRACT I13 and Q8, decisions 91,
// 93 and 95, and the schema's ownership: what extract emits after Pass A (U6a.2-3), Pass B's calls
// (U6a.2-4a) and its imports (BMO-134) and from which grammar node types, who owns what it never emits,
// and a tracking id for each label or edge a later unit adds. The declaration table is
// python-decl.test.ts, the expression table python-calls.test.ts, the import table
// python-imports.test.ts.
import { isDeepStrictEqual } from 'node:util';
import { EDGE_TYPES, isWorkspacePath, NODE_LABELS } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import type { Disposition } from './contract';
import { pythonAdapter } from './python';
import { ADAPTER_GRAMMARS, adapterFor } from './registry';
import { EXTRACT_CONTRACT_VERSION } from './version';

describe('pythonAdapter', () => {
  it('is the python grammar, rooted at module', () => {
    const { grammarId, language, moduleRootType } = pythonAdapter;
    expect({ grammarId, language, moduleRootType }).toEqual({
      grammarId: 'python',
      language: 'python',
      moduleRootType: 'module',
    });
  });

  it.each([
    ['main.py', 'main'],
    ['util.py', 'util'],
    ['shapes/square.py', 'shapes.square'],
    ['shapes/__init__.py', 'shapes'],
    ['a/b/__init__.py', 'a.b'],
    ['a/b/c.py', 'a.b.c'],
    ['__init__.py', '__init__'],
    ['SCRIPT.PY', 'SCRIPT'],
    ['pkg/__INIT__.Py', 'pkg.__INIT__'],
    ['pkg/x__init__.py', 'pkg.x__init__'],
    ['pkg/__init___.py', 'pkg.__init___'],
    ['tool.py.py', 'tool.py'],
    ['pkg.py/mod.py', 'pkg.py.mod'],
    ['a.pyx', 'a.pyx'],
    ['py.py', 'py'],
  ])('names %s %s', (path, name) => {
    if (!isWorkspacePath(path)) throw new Error(`not a workspace path: ${path}`);
    expect(pythonAdapter.moduleName(path)).toBe(name);
  });
});

const emits = (...fromNodeTypes: string[]) => ({ state: 'emits', fromNodeTypes });
const notMine = (owner: string) => ({ state: 'not-mine', owner });
const LATER = 'declared-not-emitted';

// What a declaration is classified from, and what mints a SYMBOL (python.ts's table, decision 107).
const DECLARED_FROM = ['class_definition', 'function_definition', 'expression_statement'];
const DEFINES_FROM = ['module', ...DECLARED_FROM, 'decorated_definition'];
// U6a.2-4a: what a CALL is classified from (python.ts's expression table); a builtin callee also mints
// its external SYMBOL from one (I11), so SYMBOL comes from these too.
const CALL_FROM = ['call', 'decorator'];
const SYMBOL_FROM = [...DEFINES_FROM, ...CALL_FROM];
// BMO-134: an IMPORT, and the DECLARES to it, come from the three import statements (python.ts).
const IMPORT_FROM = ['import_statement', 'import_from_statement', 'future_import_statement'];

// One row per label and edge type: 14 + 15 (I13).
const NODE_ROWS: Record<string, object | typeof LATER> = {
  DIRECTORY: notMine('filesystem-tier'),
  FILE: notMine('filesystem-tier'),
  MODULE: emits('module'),
  TYPE_DECL: emits('class_definition', 'decorated_definition'),
  METHOD: emits('function_definition', 'decorated_definition'),
  PARAM: emits(
    'identifier',
    'typed_parameter',
    'default_parameter',
    'typed_default_parameter',
    'list_splat_pattern',
    'dictionary_splat_pattern',
  ),
  MEMBER: emits('expression_statement'),
  CALL: emits(...CALL_FROM),
  IMPORT: emits(...IMPORT_FROM),
  SYMBOL: emits(...SYMBOL_FROM),
  COMMUNITY: notMine('analysis-pass'),
  TAG: notMine('meta'),
  UNKNOWN: emits('ERROR'),
  META_DATA: notMine('meta'),
};
const EDGE_ROWS: Record<string, object | typeof LATER> = {
  HAS_ENTRY: notMine('filesystem-tier'),
  DECLARES: emits(...DECLARED_FROM, 'decorated_definition', ...IMPORT_FROM),
  HAS_PARAM: emits('function_definition', 'decorated_definition'),
  DEFINES: emits(...DEFINES_FROM),
  CALLS: emits(...CALL_FROM),
  IN_SCOPE: emits(...CALL_FROM),
  IMPORTS: notMine('resolve-pass'),
  INHERITS_FROM: LATER,
  MEMBER_OF: notMine('analysis-pass'),
  ALIAS_OF: notMine('resolve-pass'),
  TAGGED_BY: notMine('meta'),
  TARGETS: notMine('analysis-pass'),
  DEPENDS_ON: notMine('analysis-pass'),
  REACHING_DEF: emits(...CALL_FROM),
  SOURCE_FILE: notMine('filesystem-tier'),
};

/** Rows that differ from the table, as `<key>: <actual>`. */
function mismatches(
  actual: Readonly<Record<string, Disposition>>,
  want: Record<string, object | typeof LATER>,
): string[] {
  const problems: string[] = [];
  for (const [key, row] of Object.entries(want)) {
    const got = actual[key];
    const ok =
      row === LATER
        ? got?.state === LATER && got.reason.trim() !== '' && got.trackingId.trim() !== ''
        : isDeepStrictEqual({ ...got }, row);
    if (!ok) problems.push(`${key}: ${JSON.stringify(got)}`);
  }
  return problems;
}

describe('the python CoverageManifest (I13)', () => {
  const manifest = pythonAdapter.coverage();

  it('is total over the 14 labels and the 15 edge types, and names nothing else', () => {
    expect(Object.keys(manifest.nodes).toSorted()).toEqual(
      NODE_LABELS.map((n) => n.label).toSorted(),
    );
    expect(Object.keys(manifest.edges).toSorted()).toEqual(
      EDGE_TYPES.map((e) => e.type).toSorted(),
    );
    expect([Object.keys(manifest.nodes).length, Object.keys(manifest.edges).length]).toEqual([
      14, 15,
    ]);
  });

  it('carries the contract version and its grammar', () => {
    expect([manifest.contractVersion, manifest.grammarId]).toEqual([
      EXTRACT_CONTRACT_VERSION,
      'python',
    ]);
  });

  it('says what the MODULE tier, Pass A and Pass B emit, who owns the rest, and tracks every later row', () => {
    expect(mismatches(manifest.nodes, NODE_ROWS)).toEqual([]);
    expect(mismatches(manifest.edges, EDGE_ROWS)).toEqual([]);
  });

  it('is one frozen table, not configuration', () => {
    expect(pythonAdapter.coverage()).toBe(manifest);
    expect([manifest, manifest.nodes, manifest.edges].map((o) => Object.isFrozen(o))).toEqual([
      true,
      true,
      true,
    ]);
  });
});

describe('the adapter registry (decision 96)', () => {
  it('has the python adapter and lists only it', () => {
    expect(adapterFor('python')).toBe(pythonAdapter);
    expect(ADAPTER_GRAMMARS).toEqual(['python']);
  });

  it.each([
    'typescript',
    'tsx',
    'javascript',
    'ruby',
    '',
    'toString',
    '__proto__',
    'hasOwnProperty',
  ])('has no adapter for %j', (grammarId) => {
    expect(adapterFor(grammarId)).toBeUndefined();
  });
});
