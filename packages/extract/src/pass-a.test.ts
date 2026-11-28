// Pass A on hand-built trees (no wasm), through extractFile with a scripted adapter: the walker's own
// rules, whatever the language. Expected values come from walk.ts's contract (decisions 91, 92, 95,
// 107, 113; ids by makeNodeId's rule, fqns by makeSymbolFqn's) and C-EXTRACT I3, I7, I17. The Python
// adapter's table on real trees is python-decl.test.ts; the ladder is ladder.test.ts.
import { isWorkspacePath, type SourceRange, type WorkspacePath } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import type {
  ContainerKind,
  DeclarationInfo,
  ExtractOutcome,
  ExtractRequest,
  LanguageAdapter,
  MemberInfo,
  MethodInfo,
  ParamInfo,
  SyntaxNode,
  TypeDeclInfo,
} from './contract';
import { extractFile } from './extractor';
import { pythonAdapter } from './python';

type At = readonly [row: number, column: number];

/** A tree node with no fields; `kids` are its named children. */
function n(type: string, start: At, end: At, kids: readonly SyntaxNode[] = []): SyntaxNode {
  return {
    type,
    startPosition: { row: start[0], column: start[1] },
    endPosition: { row: end[0], column: end[1] },
    startIndex: 0,
    endIndex: 0,
    text: '',
    namedChildren: kids,
    childForFieldName: () => null,
  };
}

const range = (a: At, b: At): SourceRange => ({
  startRow: a[0],
  startColumn: a[1],
  endRow: b[0],
  endColumn: b[1],
});

const wsPath = (value: string): WorkspacePath => {
  if (!isWorkspacePath(value)) throw new Error(`not a workspace path: ${value}`);
  return value;
};

/** What the scripted adapter says about each node, and every call it got. */
function scripted(table: ReadonlyMap<SyntaxNode, DeclarationInfo>) {
  const calls: [SyntaxNode, ContainerKind][] = [];
  const adapter: LanguageAdapter = {
    ...pythonAdapter,
    language: 'lang',
    classify: (node, container) => {
      calls.push([node, container]);
      return table.get(node);
    },
  };
  return { adapter, calls };
}

/** Runs `make` once, on its first use inside a test, so a failure stays that test's own. */
function lazy<T>(make: () => T): () => T {
  let made: { readonly value: T } | undefined;
  return () => (made ??= { value: make() }).value;
}

const REV = '7e'.repeat(32);
const req = (root: SyntaxNode, over: Partial<ExtractRequest> = {}): ExtractRequest => ({
  path: wsPath('m.py'),
  grammarId: 'python',
  root,
  revision_id: REV,
  lineCount: 9,
  ...over,
});

function ok(outcome: ExtractOutcome) {
  if (outcome.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(outcome)}`);
  return outcome.file;
}

const param = (name: string, node: SyntaxNode, more: Partial<ParamInfo> = {}): ParamInfo => ({
  name,
  node,
  ordinal: 0,
  ...more,
});
const method = (name: string, more: Partial<MethodInfo> = {}): MethodInfo => ({
  declares: 'METHOD',
  name,
  kind: 'function',
  signature: `${name}()`,
  exported: true,
  async: false,
  params: [],
  ...more,
});
const typeDecl = (name: string, body?: SyntaxNode, more: Partial<TypeDeclInfo> = {}) =>
  ({
    declares: 'TYPE_DECL',
    name,
    kind: 'class',
    exported: true,
    structural: true,
    body,
    ...more,
  }) as const;
const member = (name: string, more: Partial<MemberInfo> = {}): MemberInfo => ({
  declares: 'MEMBER',
  name,
  ...more,
});

const MOD = 'file:m.py:MODULE:$root';
const id = (kind: string, scope: string) => `file:m.py:${kind}:${scope}`;
const sym = (descriptors: string) => `\`m.py\`/${descriptors}`;
const edgeLines = (file: ReturnType<typeof ok>) =>
  file.edges.map((e) => `${e.type} ${e.from.key} -> ${e.to.key}`).toSorted();

// One function `f(a, b=1)` at module level, written over rows 0-1, its name at 0:4-0:5.
const F_NAME = n('identifier', [0, 4], [0, 5]);
const A = n('identifier', [0, 6], [0, 7]);
const B = n('default_parameter', [0, 9], [0, 12]);
const F = n('function_definition', [0, 0], [1, 8], [F_NAME]);
const F_INFO = method('f', {
  nameNode: F_NAME,
  signature: 'f(a, b)',
  params: [param('a', A), param('b', B, { ordinal: 1, defaultText: '1', typeText: 'int' })],
});

describe('a METHOD and its PARAMs (decisions 91, 92, 113)', () => {
  const root = n('module', [0, 0], [2, 0], [F]);
  const file = lazy(() => ok(extractFile(req(root), scripted(new Map([[F, F_INFO]])).adapter)));

  it('emits the METHOD with its range, nameRange and properties, then one PARAM per param', () => {
    // r2 (review 13): a parameter is never a visited node, only the root and the def
    expect(file().stats.astNodesVisited).toBe(2);
    expect(file().nodes.map((x) => [x.label, x.id])).toEqual([
      ['MODULE', MOD],
      ['METHOD', id('METHOD', 'f')],
      ['PARAM', id('PARAM', 'f.a')],
      ['PARAM', id('PARAM', 'f.b')],
    ]);
    expect(file().nodes[1]).toStrictEqual({
      label: 'METHOD',
      id: id('METHOD', 'f'),
      file: 'm.py',
      revision_id: REV,
      tier: 'structural',
      range: range([0, 0], [1, 8]),
      nameRange: range([0, 4], [0, 5]),
      properties: {
        name: 'f',
        kind: 'function',
        signature: 'f(a, b)',
        params_count: 2,
        exported: true,
        async: false,
        status: 'ready',
      },
    });
  });

  it('gives a PARAM its ordinal as a property, never in its id, and its own range', () => {
    expect(file().nodes.slice(2)).toStrictEqual([
      {
        label: 'PARAM',
        id: id('PARAM', 'f.a'),
        file: 'm.py',
        revision_id: REV,
        tier: 'structural',
        range: range([0, 6], [0, 7]),
        properties: { name: 'a', ordinal: 0 },
      },
      {
        label: 'PARAM',
        id: id('PARAM', 'f.b'),
        file: 'm.py',
        revision_id: REV,
        tier: 'structural',
        range: range([0, 9], [0, 12]),
        properties: { name: 'b', ordinal: 1, type_text: 'int', default: '1' },
      },
    ]);
  });

  // Sprint 40 (decision 114): the ordinal is the adapter's, never the param's index in the list, so a
  // position the adapter left empty (a MISSING name) stays empty; params_count counts the PARAMs.
  it("writes each param's own ordinal, gaps included (decision 114)", () => {
    const info = method('f', {
      params: [param('a', A, { ordinal: 1 }), param('b', B, { ordinal: 3 })],
    });
    const gaps = ok(extractFile(req(root), scripted(new Map([[F, info]])).adapter));
    expect(gaps.nodes.filter((x) => x.label === 'PARAM').map((x) => x.properties)).toStrictEqual([
      { name: 'a', ordinal: 1 },
      { name: 'b', ordinal: 3 },
    ]);
    expect(gaps.nodes[1]?.properties).toMatchObject({ params_count: 2 });
  });

  it('DECLARES it from the MODULE, DEFINES its SYMBOL, HAS_PARAM each PARAM; no PARAM SYMBOL', () => {
    expect(edgeLines(file())).toEqual(
      [
        `DEFINES ${MOD} -> ${sym('')}`,
        `DECLARES ${MOD} -> ${id('METHOD', 'f')}`,
        `DEFINES ${id('METHOD', 'f')} -> ${sym('f().')}`,
        `HAS_PARAM ${id('METHOD', 'f')} -> ${id('PARAM', 'f.a')}`,
        `HAS_PARAM ${id('METHOD', 'f')} -> ${id('PARAM', 'f.b')}`,
      ].toSorted(),
    );
    expect(file().symbols).toStrictEqual([
      { fqn: sym(''), origin: 'local', language: 'lang', properties: { kind: 'module' } },
      { fqn: sym('f().'), origin: 'local', language: 'lang', properties: { kind: 'function' } },
    ]);
    expect(file().edges.every((e) => Object.keys(e.properties).length === 0)).toBe(true);
    expect(file().edges.find((e) => e.type === 'DECLARES')).toStrictEqual({
      type: 'DECLARES',
      from: { by: 'id', label: 'MODULE', key: MOD },
      to: { by: 'id', label: 'METHOD', key: id('METHOD', 'f') },
      properties: {},
    });
    expect(file().edges.find((e) => e.to.key === sym('f().'))).toStrictEqual({
      type: 'DEFINES',
      from: { by: 'id', label: 'METHOD', key: id('METHOD', 'f') },
      to: { by: 'fqn', label: 'SYMBOL', key: sym('f().') },
      properties: {},
    });
  });

  // r2 (review 2): DECLARES, then DEFINES, then each HAS_PARAM, in that order
  it("orders a METHOD's edges: DECLARES, DEFINES, then HAS_PARAM per param", () => {
    expect(file().edges.map((e) => `${e.type} ${e.to.key}`)).toEqual([
      `DEFINES ${sym('')}`,
      `DECLARES ${id('METHOD', 'f')}`,
      `DEFINES ${sym('f().')}`,
      `HAS_PARAM ${id('PARAM', 'f.a')}`,
      `HAS_PARAM ${id('PARAM', 'f.b')}`,
    ]);
  });

  it('writes docstring_head and the METHOD kind, signature, exported and async the adapter gives', () => {
    const G = n('function_definition', [3, 0], [4, 8]);
    const info = method('g', {
      kind: 'lambda_named',
      signature: 'g() -> int',
      exported: false,
      async: true,
      docstringHead: 'Head.',
    });
    const got = ok(
      extractFile(req(n('module', [0, 0], [5, 0], [G])), scripted(new Map([[G, info]])).adapter),
    );
    expect(got.nodes[1]?.properties).toStrictEqual({
      name: 'g',
      kind: 'lambda_named',
      signature: 'g() -> int',
      params_count: 0,
      exported: false,
      async: true,
      status: 'ready',
      docstring_head: 'Head.',
    });
    expect(got.nodes[1]).not.toHaveProperty('nameRange');
    // r2 (review 1): the SYMBOL's kind comes from the container (MODULE: function), not info.kind
    expect(got.symbols.map((s) => s.properties)).toStrictEqual([
      { kind: 'module' },
      { kind: 'function' },
    ]);
  });
});

// class C: x = 1; def m(self); class D: y. Rows 0-6, with distinct ranges per node.
const X = n('expression_statement', [1, 4], [1, 9]);
const SELF = n('identifier', [2, 10], [2, 14]);
const M = n('decorated_definition', [2, 4], [3, 12]);
const Y = n('expression_statement', [5, 8], [5, 14]);
const D_BODY = n('block', [5, 8], [5, 14], [Y]);
const D = n('class_definition', [4, 4], [5, 14], [D_BODY]);
const C_BODY = n('block', [1, 4], [5, 14], [X, M, D]);
const C = n('class_definition', [0, 0], [5, 14], [C_BODY]);
const CLASS_TABLE = new Map<SyntaxNode, DeclarationInfo>([
  [C, typeDecl('C', C_BODY, { docstringHead: 'A C.' })],
  [X, member('x', { typeText: 'int', visibility: 'public' })],
  // r2 (reviews 1, 3): kinds the walker must pass through, not default
  [M, method('m', { kind: 'constructor', params: [param('self', SELF)] })],
  [D, typeDecl('D', D_BODY, { kind: 'protocol', exported: false, structural: false })],
  [Y, member('y')],
]);

describe('a TYPE_DECL and its body (decisions 92, 107)', () => {
  const root = n('module', [0, 0], [6, 0], [C]);
  const { adapter, calls } = scripted(CLASS_TABLE);
  const file = lazy(() => ok(extractFile(req(root), adapter)));

  it('scopes every member by the class names, never by the module', () => {
    expect(file().nodes.map((x) => x.id)).toEqual([
      MOD,
      id('TYPE_DECL', 'C'),
      id('MEMBER', 'C.x'),
      id('METHOD', 'C.m'),
      id('PARAM', 'C.m.self'),
      id('TYPE_DECL', 'C.D'),
      id('MEMBER', 'C.D.y'),
    ]);
  });

  it('classifies the body children as TYPE_DECL children, after the class itself', () => {
    file();
    expect(
      calls.map(([node, container]) => [node.type, node.startPosition.row, container]),
    ).toEqual([
      ['class_definition', 0, 'MODULE'],
      ['expression_statement', 1, 'TYPE_DECL'],
      ['decorated_definition', 2, 'TYPE_DECL'],
      ['class_definition', 4, 'TYPE_DECL'],
      ['expression_statement', 5, 'TYPE_DECL'],
    ]);
  });

  it('takes each range from the node it classified (a whole decorated_definition)', () => {
    expect(file().nodes.map((x) => x.range)).toEqual([
      range([0, 0], [6, 0]),
      range([0, 0], [5, 14]),
      range([1, 4], [1, 9]),
      range([2, 4], [3, 12]),
      range([2, 10], [2, 14]),
      range([4, 4], [5, 14]),
      range([5, 8], [5, 14]),
    ]);
  });

  it('writes the TYPE_DECL and MEMBER properties the adapter gives, and no nameRange', () => {
    expect(file().nodes.map((x) => x.properties)).toStrictEqual([
      { name: 'm', status: 'ready' },
      {
        name: 'C',
        kind: 'class',
        exported: true,
        status: 'ready',
        structural: true,
        docstring_head: 'A C.',
      },
      { name: 'x', type_text: 'int', visibility: 'public' },
      {
        name: 'm',
        kind: 'constructor',
        signature: 'm()',
        params_count: 1,
        exported: true,
        async: false,
        status: 'ready',
      },
      { name: 'self', ordinal: 0 },
      { name: 'D', kind: 'protocol', exported: false, status: 'ready', structural: false },
      { name: 'y' },
    ]);
    expect(file().nodes.filter((x) => 'nameRange' in x)).toEqual([]);
    // r2 (review 3): every node is this file's, at this revision, structural
    expect(
      file().nodes.filter(
        (x) => x.file !== 'm.py' || x.revision_id !== REV || x.tier !== 'structural',
      ),
    ).toEqual([]);
  });

  it('DECLARES each member from its own container and DEFINES one SYMBOL per declaration', () => {
    expect(edgeLines(file())).toEqual(
      [
        `DEFINES ${MOD} -> ${sym('')}`,
        `DECLARES ${MOD} -> ${id('TYPE_DECL', 'C')}`,
        `DEFINES ${id('TYPE_DECL', 'C')} -> ${sym('C#')}`,
        `DECLARES ${id('TYPE_DECL', 'C')} -> ${id('MEMBER', 'C.x')}`,
        `DEFINES ${id('MEMBER', 'C.x')} -> ${sym('C#x.')}`,
        `DECLARES ${id('TYPE_DECL', 'C')} -> ${id('METHOD', 'C.m')}`,
        `DEFINES ${id('METHOD', 'C.m')} -> ${sym('C#m().')}`,
        `HAS_PARAM ${id('METHOD', 'C.m')} -> ${id('PARAM', 'C.m.self')}`,
        `DECLARES ${id('TYPE_DECL', 'C')} -> ${id('TYPE_DECL', 'C.D')}`,
        `DEFINES ${id('TYPE_DECL', 'C.D')} -> ${sym('C#D#')}`,
        `DECLARES ${id('TYPE_DECL', 'C.D')} -> ${id('MEMBER', 'C.D.y')}`,
        `DEFINES ${id('MEMBER', 'C.D.y')} -> ${sym('C#D#y.')}`,
      ].toSorted(),
    );
    expect(file().symbols.map((s) => [s.fqn, s.properties['kind']])).toEqual([
      [sym(''), 'module'],
      [sym('C#'), 'class'],
      [sym('C#x.'), 'variable'],
      [sym('C#m().'), 'method'],
      [sym('C#D#'), 'class'],
      [sym('C#D#y.'), 'variable'],
    ]);
    // r2 (review 3): each SYMBOL is local, in the adapter's language
    expect(file().symbols.filter((x) => x.origin !== 'local' || x.language !== 'lang')).toEqual([]);
    const declares = file().edges.find((e) => e.to.key === id('MEMBER', 'C.D.y'));
    expect(declares?.from).toStrictEqual({
      by: 'id',
      label: 'TYPE_DECL',
      key: id('TYPE_DECL', 'C.D'),
    });
  });

  it("keeps each declaration's edges and SYMBOL with it: built in source pre-order", () => {
    // r2 (review 2): the whole list, a METHOD's HAS_PARAM included
    expect(file().edges.map((e) => `${e.type} ${e.to.key}`)).toEqual([
      `DEFINES ${sym('')}`,
      `DECLARES ${id('TYPE_DECL', 'C')}`,
      `DEFINES ${sym('C#')}`,
      `DECLARES ${id('MEMBER', 'C.x')}`,
      `DEFINES ${sym('C#x.')}`,
      `DECLARES ${id('METHOD', 'C.m')}`,
      `DEFINES ${sym('C#m().')}`,
      `HAS_PARAM ${id('PARAM', 'C.m.self')}`,
      `DECLARES ${id('TYPE_DECL', 'C.D')}`,
      `DEFINES ${sym('C#D#')}`,
      `DECLARES ${id('MEMBER', 'C.D.y')}`,
      `DEFINES ${sym('C#D#y.')}`,
    ]);
  });

  // r2 (review 8): ids and fqns are minted by makeNodeId and makeSymbolFqn, escapes included
  it('escapes a path and names the way makeNodeId and makeSymbolFqn do', () => {
    const p = n('identifier', [1, 8], [1, 11]);
    const fn = n('function_definition', [1, 0], [1, 20]);
    const mem = n('expression_statement', [3, 4], [3, 9]);
    const body = n('block', [3, 4], [3, 9], [mem]);
    const cls = n('class_definition', [2, 0], [3, 9], [body]);
    const table = new Map<SyntaxNode, DeclarationInfo>([
      [fn, method('a.b', { params: [param('p.q', p)] })],
      [cls, typeDecl('T`1', body)],
      [mem, member('m')],
    ]);
    const odd = n('module', [0, 0], [4, 0], [fn, cls]);
    const got = ok(extractFile(req(odd, { path: wsPath('x:y.py') }), scripted(table).adapter));
    expect(got.nodes.map((x) => x.id)).toEqual([
      'file:x%3Ay.py:MODULE:$root',
      'file:x%3Ay.py:METHOD:a%2Eb',
      'file:x%3Ay.py:PARAM:a%2Eb.p%2Eq',
      'file:x%3Ay.py:TYPE_DECL:T`1',
      'file:x%3Ay.py:MEMBER:T`1.m',
    ]);
    expect(got.symbols.map((x) => x.fqn)).toEqual([
      '`x:y.py`/',
      '`x:y.py`/`a.b`().',
      '`x:y.py`/`T``1`#',
      '`x:y.py`/`T``1`#m.',
    ]);
  });
});

describe('what Pass A does not descend (decision 92)', () => {
  it('never visits a METHOD body or a MEMBER value, and counts only container children', () => {
    const inner = n('function_definition', [1, 4], [1, 20]);
    const body = n('block', [1, 4], [1, 20], [inner]);
    const value = n('call', [3, 4], [3, 9], [n('class_definition', [3, 4], [3, 9])]);
    const fn = n('function_definition', [0, 0], [1, 20], [body]);
    const assign = n('expression_statement', [3, 0], [3, 9], [value]);
    const table = new Map<SyntaxNode, DeclarationInfo>([
      [fn, method('f', { body })],
      [inner, method('inner')],
      [assign, member('v', { value })],
      [value.namedChildren[0] ?? value, typeDecl('Nope')],
    ]);
    const { adapter, calls } = scripted(table);
    const file = ok(extractFile(req(n('module', [0, 0], [4, 0], [fn, assign])), adapter));
    expect(calls.map(([node]) => node)).toEqual([fn, assign]);
    expect(file.nodes.map((x) => x.id)).toEqual([MOD, id('METHOD', 'f'), id('MEMBER', 'v')]);
    expect(file.stats.astNodesVisited).toBe(3);
  });

  it('a TYPE_DECL with no body declares nothing more', () => {
    const k = n('class_definition', [0, 0], [0, 9], [n('identifier', [0, 6], [0, 7])]);
    const { adapter, calls } = scripted(new Map([[k, typeDecl('K')]]));
    const file = ok(extractFile(req(n('module', [0, 0], [1, 0], [k])), adapter));
    expect([file.nodes.length, calls.length, file.stats.astNodesVisited]).toEqual([2, 1, 2]);
  });
});

describe('ERROR regions (decision 95)', () => {
  // module: E0, class C { E, x }, E1. C's ERROR holds a child the adapter would declare.
  const E0 = n('ERROR', [0, 0], [0, 1]);
  const HIDDEN = n('function_definition', [2, 4], [2, 9]);
  const EC = n('ERROR', [2, 4], [2, 9], [HIDDEN]);
  const CX = n('expression_statement', [3, 4], [3, 9]);
  const CB = n('block', [2, 4], [3, 9], [EC, CX]);
  const CC = n('class_definition', [1, 0], [3, 9], [CB]);
  const E1 = n('ERROR', [4, 0], [4, 3]);
  const table = new Map<SyntaxNode, DeclarationInfo>([
    [CC, typeDecl('C', CB)],
    [CX, member('x')],
    [HIDDEN, method('hidden')],
    [E0, member('never')],
  ]);
  const { adapter, calls } = scripted(table);
  const file = lazy(() => ok(extractFile(req(n('module', [0, 0], [5, 0], [E0, CC, E1])), adapter)));
  const unknowns = () => file().nodes.filter((x) => x.label === 'UNKNOWN');

  it('gives each ERROR directly under a container one UNKNOWN, numbered per scope in source order', () => {
    expect(unknowns()).toStrictEqual([
      {
        label: 'UNKNOWN',
        id: id('UNKNOWN', '$root:0'),
        file: 'm.py',
        revision_id: REV,
        tier: 'structural',
        range: range([0, 0], [0, 1]),
        properties: { reason: 'syntax-error', status: 'ready' },
      },
      {
        label: 'UNKNOWN',
        id: id('UNKNOWN', 'C:0'),
        file: 'm.py',
        revision_id: REV,
        tier: 'structural',
        range: range([2, 4], [2, 9]),
        properties: { reason: 'syntax-error', status: 'ready' },
      },
      {
        label: 'UNKNOWN',
        id: id('UNKNOWN', '$root:1'),
        file: 'm.py',
        revision_id: REV,
        tier: 'structural',
        range: range([4, 0], [4, 3]),
        properties: { reason: 'syntax-error', status: 'ready' },
      },
    ]);
  });

  it('never classifies or descends an ERROR, and gives an UNKNOWN no edge and no SYMBOL', () => {
    file();
    expect(calls.map(([node]) => node)).toEqual([CC, CX]);
    expect(file().nodes.map((x) => x.id)).not.toContain(id('METHOD', 'C.hidden'));
    const keys = file().edges.flatMap((e) => [e.from.key, e.to.key]);
    expect(unknowns().filter((u) => keys.includes(u.id))).toEqual([]);
    expect(file().symbols.map((s) => s.fqn)).toEqual([sym(''), sym('C#'), sym('C#x.')]);
    // the root, three module children, two in C's body
    expect(file().stats.astNodesVisited).toBe(6);
  });

  // r2 (review 4): the scope is the whole class chain, not the innermost name
  it('scopes an ERROR in a nested class by the whole chain', () => {
    const err = n('ERROR', [2, 8], [2, 9]);
    const inner = n('block', [2, 8], [2, 9], [err]);
    const d = n('class_definition', [1, 4], [2, 9], [inner]);
    const outer = n('block', [1, 4], [2, 9], [d]);
    const c = n('class_definition', [0, 0], [2, 9], [outer]);
    const nested = new Map<SyntaxNode, DeclarationInfo>([
      [c, typeDecl('C', outer)],
      [d, typeDecl('D', inner)],
    ]);
    const got = ok(extractFile(req(n('module', [0, 0], [3, 0], [c])), scripted(nested).adapter));
    expect(got.nodes.filter((x) => x.label === 'UNKNOWN').map((x) => x.id)).toEqual([
      id('UNKNOWN', 'C.D:0'),
    ]);
  });
});

describe('duplicate names in one file (I7)', () => {
  // def f(a); def f(a); def f(); class C { x }; class C { x, E }: a redefinition, a property's
  // getter and setter, a repeated class.
  const fa1 = n('identifier', [0, 6], [0, 7]);
  const fa2 = n('identifier', [1, 6], [1, 7]);
  const F1 = n('function_definition', [0, 0], [0, 12]);
  const F2 = n('decorated_definition', [1, 0], [1, 12]);
  const F3 = n('function_definition', [2, 0], [2, 11]);
  const X1 = n('expression_statement', [4, 4], [4, 9]);
  const B1 = n('block', [4, 4], [4, 9], [X1]);
  const C1 = n('class_definition', [3, 0], [4, 9], [B1]);
  const X2 = n('expression_statement', [6, 4], [6, 9]);
  const E2 = n('ERROR', [7, 4], [7, 5]);
  const B2 = n('block', [6, 4], [7, 5], [X2, E2]);
  const C2 = n('class_definition', [5, 0], [7, 5], [B2]);
  const E3 = n('ERROR', [8, 0], [8, 1]);
  const B3 = n('block', [10, 4], [10, 5], [E3]);
  const C3 = n('class_definition', [9, 0], [10, 5], [B3]);
  const table = new Map<SyntaxNode, DeclarationInfo>([
    [F1, method('f', { params: [param('a', fa1)] })],
    [F2, method('f', { params: [param('a', fa2)], signature: 'f(a) -> None' })],
    [F3, method('f')],
    [C1, typeDecl('C', B1)],
    [X1, member('x')],
    [C2, typeDecl('C', B2)],
    [X2, member('x')],
    [C3, typeDecl('C', B3)],
  ]);
  const root = n('module', [0, 0], [11, 0], [F1, F2, F3, C1, C2, C3]);
  const outcome = extractFile(req(root), scripted(table).adapter);
  const file = lazy(() => ok(outcome));

  it('numbers the k-th repeat of an id k, its descendants too, and the first not at all', () => {
    expect(file().nodes.map((x) => x.id)).toEqual([
      MOD,
      id('METHOD', 'f'),
      id('PARAM', 'f.a'),
      id('METHOD', 'f:1'),
      id('PARAM', 'f.a:1'),
      id('METHOD', 'f:2'),
      id('TYPE_DECL', 'C'),
      id('MEMBER', 'C.x'),
      id('TYPE_DECL', 'C:1'),
      id('MEMBER', 'C.x:1'),
      id('UNKNOWN', 'C:0'),
      id('TYPE_DECL', 'C:2'),
      id('UNKNOWN', 'C:1'),
    ]);
  });

  it('emits each SYMBOL once and DEFINES it from every declaration of the name', () => {
    expect(file().symbols.map((s) => s.fqn)).toEqual([
      sym(''),
      sym('f().'),
      sym('C#'),
      sym('C#x.'),
    ]);
    const into = (fqn: string) =>
      file()
        .edges.filter((e) => e.to.key === fqn)
        .map((e) => e.from.key);
    expect(into(sym('f().'))).toEqual([
      id('METHOD', 'f'),
      id('METHOD', 'f:1'),
      id('METHOD', 'f:2'),
    ]);
    expect(into(sym('C#x.'))).toEqual([id('MEMBER', 'C.x'), id('MEMBER', 'C.x:1')]);
  });

  it("keeps each repeat's own edges: DECLARES from its own class, HAS_PARAM to its own PARAM", () => {
    const lines = edgeLines(file());
    expect(lines).toContain(`DECLARES ${id('TYPE_DECL', 'C:1')} -> ${id('MEMBER', 'C.x:1')}`);
    expect(lines).toContain(`HAS_PARAM ${id('METHOD', 'f:1')} -> ${id('PARAM', 'f.a:1')}`);
    expect(lines).toContain(`DECLARES ${MOD} -> ${id('TYPE_DECL', 'C:2')}`);
    expect(file().nodes.find((x) => x.id === id('METHOD', 'f:1'))?.properties['signature']).toBe(
      'f(a) -> None',
    );
  });

  // r2 (review 5): a repeat is the same label and scope; one name under three labels repeats nothing
  it('gives one name under three labels in one container three ordinal-free ids', () => {
    const xm = n('expression_statement', [0, 0], [0, 5]);
    const xf = n('function_definition', [1, 0], [1, 12]);
    const xc = n('class_definition', [2, 0], [2, 12]);
    const same = new Map<SyntaxNode, DeclarationInfo>([
      [xm, member('x')],
      [xf, method('x')],
      [xc, typeDecl('x')],
    ]);
    const got = ok(
      extractFile(req(n('module', [0, 0], [3, 0], [xm, xf, xc])), scripted(same).adapter),
    );
    expect(got.nodes.map((x) => x.id)).toEqual([
      MOD,
      id('MEMBER', 'x'),
      id('METHOD', 'x'),
      id('TYPE_DECL', 'x'),
    ]);
    expect(got.symbols.map((x) => x.fqn)).toEqual([sym(''), sym('x.'), sym('x().'), sym('x#')]);
  });

  it('is deterministic with repeats (I3)', () => {
    expect(outcome.kind).toBe('ok');
    expect(JSON.stringify(extractFile(req(root), scripted(table).adapter))).toBe(
      JSON.stringify(outcome),
    );
  });
});

describe('the budget across containers (I17)', () => {
  // module: class C { x, m }, then g. C's members are depth 2.
  const CX = n('expression_statement', [1, 4], [1, 9]);
  const CM = n('function_definition', [2, 4], [2, 20]);
  const CB = n('block', [1, 4], [2, 20], [CX, CM]);
  const CC = n('class_definition', [0, 0], [2, 20], [CB]);
  const G = n('function_definition', [3, 0], [3, 9]);
  const table = new Map<SyntaxNode, DeclarationInfo>([
    [CC, typeDecl('C', CB)],
    [CX, member('x')],
    [CM, method('m')],
    [G, method('g')],
  ]);
  const root = n('module', [0, 0], [4, 0], [CC, G]);
  const run = (budget: ExtractRequest['budget']) => {
    const { adapter, calls } = scripted(table);
    return {
      outcome: extractFile(req(root, budget === undefined ? {} : { budget }), adapter),
      calls,
    };
  };

  it('visits the root, every container child and every body child', () => {
    expect(ok(run(undefined).outcome).stats.astNodesVisited).toBe(5);
    expect(ok(run({ maxDepth: 2, maxNodes: 5 }).outcome).nodes.map((x) => x.id)).toEqual([
      MOD,
      id('TYPE_DECL', 'C'),
      id('MEMBER', 'C.x'),
      id('METHOD', 'C.m'),
      id('METHOD', 'g'),
    ]);
  });

  it('stops at a class member deeper than maxDepth, and the whole walk with it', () => {
    const { outcome, calls } = run({ maxDepth: 1 });
    expect(outcome.kind).toBe('truncated');
    if (outcome.kind !== 'truncated') return;
    expect(outcome.truncation).toEqual({
      limit: 'maxDepth',
      limitValue: 1,
      droppedAtNodeType: 'expression_statement',
      droppedRange: range([1, 4], [1, 9]),
    });
    expect(outcome.file.nodes.map((x) => x.id)).toEqual([MOD, id('TYPE_DECL', 'C')]);
    expect(outcome.file.stats.astNodesVisited).toBe(2);
    expect(calls.map(([node]) => node)).toEqual([CC]);
  });

  it('stops inside a body when maxNodes is reached, never visiting what follows the class', () => {
    const { outcome, calls } = run({ maxNodes: 3 });
    if (outcome.kind !== 'truncated') throw new Error(`expected truncated, got ${outcome.kind}`);
    expect(outcome.truncation).toEqual({
      limit: 'maxNodes',
      limitValue: 3,
      droppedAtNodeType: 'function_definition',
      droppedRange: range([2, 4], [2, 20]),
    });
    expect(outcome.file.nodes.map((x) => x.id)).toEqual([
      MOD,
      id('TYPE_DECL', 'C'),
      id('MEMBER', 'C.x'),
    ]);
    expect(calls.map(([node]) => node)).toEqual([CC, CX]);
    expect(outcome.file.stats.astNodesVisited).toBe(3);
  });

  it('checks maxDepth before maxNodes on the same child', () => {
    const { outcome } = run({ maxDepth: 1, maxNodes: 2 });
    expect(outcome.kind === 'truncated' && outcome.truncation.limit).toBe('maxDepth');
  });

  // r2 (review 6): a nested class's member is depth 3
  it('puts a nested class member one deeper than its class: depth 3 under maxDepth 2', () => {
    const { adapter } = scripted(CLASS_TABLE);
    const outcome = extractFile(
      req(n('module', [0, 0], [6, 0], [C]), { budget: { maxDepth: 2 } }),
      adapter,
    );
    if (outcome.kind !== 'truncated') throw new Error(`expected truncated, got ${outcome.kind}`);
    expect(outcome.truncation).toEqual({
      limit: 'maxDepth',
      limitValue: 2,
      droppedAtNodeType: 'expression_statement',
      droppedRange: range([5, 8], [5, 14]),
    });
    expect(outcome.file.nodes.map((x) => x.id)).toEqual([
      MOD,
      id('TYPE_DECL', 'C'),
      id('MEMBER', 'C.x'),
      id('METHOD', 'C.m'),
      id('PARAM', 'C.m.self'),
      id('TYPE_DECL', 'C.D'),
    ]);
  });

  // r2 (review 7): the budget is checked before an ERROR is handled
  it('stops at an ERROR over maxNodes without its UNKNOWN', () => {
    const e = n('ERROR', [0, 0], [0, 1]);
    const outcome = extractFile(
      req(n('module', [0, 0], [1, 0], [e]), { budget: { maxNodes: 1 } }),
      scripted(table).adapter,
    );
    if (outcome.kind !== 'truncated') throw new Error(`expected truncated, got ${outcome.kind}`);
    expect([outcome.truncation.droppedAtNodeType, outcome.file.nodes.map((x) => x.label)]).toEqual([
      'ERROR',
      ['MODULE'],
    ]);
  });

  it('counts an ERROR as visited, against maxNodes too', () => {
    const e = n('ERROR', [0, 0], [0, 1]);
    const { adapter } = scripted(table);
    const outcome = extractFile(
      req(n('module', [0, 0], [4, 0], [e, G]), { budget: { maxNodes: 2 } }),
      adapter,
    );
    if (outcome.kind !== 'truncated') throw new Error(`expected truncated, got ${outcome.kind}`);
    expect([outcome.truncation.droppedAtNodeType, outcome.file.nodes.map((x) => x.label)]).toEqual([
      'function_definition',
      ['MODULE', 'UNKNOWN'],
    ]);
  });
});
