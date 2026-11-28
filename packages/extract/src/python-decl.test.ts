// The Python declaration table on real trees (the pinned wasm grammar): what `classify` says about each
// statement, from python.ts's contract (the archive's rules, decisions 107 and 113). Signatures follow the
// archive's format, plus defaults, splat stars and the `*` and `/` separators (stop-list 197, sprint 42);
// docstring heads, kinds, params and exported come from the source as written.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isWorkspacePath, type WorkspacePath } from '@cpg/model';
import { BUILTIN_LANGUAGES, createLanguageRegistry, createParseService } from '@cpg/parse';
import { afterAll, describe, expect, it } from 'vitest';
import type { ContainerKind, DeclarationInfo, SyntaxNode } from './contract';
import { pythonAdapter } from './python';

const WASM_DIR = join(dirname(require.resolve('@vscode/tree-sitter-wasm/package.json')), 'wasm');
const registry = createLanguageRegistry();
for (const r of BUILTIN_LANGUAGES) registry.register(r);
registry.freeze();
const service = createParseService({
  registry,
  source: {
    describe: () => WASM_DIR,
    load: async (ref) => ({
      ok: true,
      bytes: new Uint8Array(await readFile(join(WASM_DIR, ref.wasmFile))),
      origin: ref.wasmFile,
    }),
  },
});
afterAll(() => service.dispose());

function wsPath(value: string): WorkspacePath {
  if (!isWorkspacePath(value)) throw new Error(`not a workspace path: ${value}`);
  return value;
}
const MAIN = wsPath('main.py');

/** A node as its type and `row:col` start. */
const at = (node: SyntaxNode | undefined) =>
  node === undefined
    ? undefined
    : `${node.type}@${String(node.startPosition.row)}:${String(node.startPosition.column)}`;

/** A readable projection of an info: nodes by type and `row:col` start, absent fields left out. */
function summary(info: DeclarationInfo | undefined): unknown {
  if (info === undefined) return undefined;
  if (info.declares === 'METHOD') {
    return {
      ...info,
      nameNode:
        info.nameNode === undefined
          ? undefined
          : `${info.nameNode.text} ${at(info.nameNode) ?? ''}`,
      body: at(info.body),
      params: info.params.map((p) => [p.name, p.typeText, p.defaultText, at(p.node)]),
    };
  }
  if (info.declares === 'TYPE_DECL') return { ...info, body: at(info.body) };
  return { ...info, value: at(info.value) };
}

/**
 * Parses `source` and classifies the statement at `path` (indices into named children: the module's,
 * then a class's body), as a MODULE child at depth 1 and a TYPE_DECL child below.
 */
async function classifyAt(source: string, ...path: number[]): Promise<unknown> {
  const parsed = await service.parse({ key: MAIN, text: source });
  if (!parsed.ok) throw new Error(parsed.error.message);
  try {
    let node: SyntaxNode | undefined = parsed.handle.root;
    let container: ContainerKind = 'MODULE';
    for (const [depth, index] of path.entries()) {
      if (depth > 0) {
        const body: SyntaxNode | null | undefined =
          node?.type === 'decorated_definition'
            ? node.childForFieldName('definition')?.childForFieldName('body')
            : node?.childForFieldName('body');
        node = body ?? undefined;
        container = 'TYPE_DECL';
      }
      node = node?.namedChildren[index];
    }
    if (node === undefined) throw new Error(`no node at ${path.join('.')}`);
    return summary(pythonAdapter.classify(node, container));
  } finally {
    parsed.handle.release();
  }
}

/** An info's docstringHead; undefined when it has none. */
const headOf = (got: unknown): unknown =>
  typeof got === 'object' && got !== null && 'docstringHead' in got ? got.docstringHead : undefined;

/** A hand-built node at 0:0 (sprint 40): `kids` are its named children, `fields` its named fields. */
function fake(
  type: string,
  text: string,
  kids: readonly SyntaxNode[] = [],
  fields: Readonly<Record<string, SyntaxNode>> = {},
): SyntaxNode {
  return {
    type,
    text,
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 0, column: text.length },
    startIndex: 0,
    endIndex: text.length,
    namedChildren: kids,
    childForFieldName: (name) => fields[name] ?? null,
  };
}

// Decision 114 in every param shape: the real grammar gave a MISSING name only as a bare identifier
// (robustness.test.ts), so the other shapes are hand-built, each with an empty-named identifier.
const EMPTY = fake('identifier', '');
const INT = fake('type', 'int');
const ONE = fake('integer', '1');
const HOLES: readonly (readonly [string, SyntaxNode])[] = [
  ['identifier', EMPTY],
  ['typed_parameter', fake('typed_parameter', ': int', [EMPTY, INT], { type: INT })],
  ['default_parameter', fake('default_parameter', '=1', [EMPTY, ONE], { name: EMPTY, value: ONE })],
  [
    'typed_default_parameter',
    fake('typed_default_parameter', ': int=1', [EMPTY, INT, ONE], {
      name: EMPTY,
      type: INT,
      value: ONE,
    }),
  ],
  ['list_splat_pattern', fake('list_splat_pattern', '*', [EMPTY])],
  ['dictionary_splat_pattern', fake('dictionary_splat_pattern', '**', [EMPTY])],
  [
    'typed splat',
    fake('typed_parameter', '*: int', [fake('list_splat_pattern', '*', [EMPTY]), INT], {
      type: INT,
    }),
  ],
];

const fn = (over: Record<string, unknown>) => ({
  declares: 'METHOD',
  kind: 'function',
  exported: true,
  async: false,
  ...over,
});

describe('functions and methods', () => {
  it('a module-level function: name, kind, signature, params, body', async () => {
    expect(await classifyAt('def greet(name, times=1):\n    pass\n', 0)).toEqual(
      fn({
        name: 'greet',
        nameNode: 'greet identifier@0:4',
        signature: 'greet(name, times=1)',
        params: [
          ['name', undefined, undefined, 'identifier@0:10'],
          ['times', undefined, '1', 'default_parameter@0:16'],
        ],
        body: 'block@1:4',
      }),
    );
  });

  it.each([
    ['def __init__(self, name):\n        pass', 'constructor', false, '__init__(self, name)'],
    ['def m(self, x: int) -> str:\n        ...', 'method', true, 'm(self, x: int) -> str'],
    ['def _m(self):\n        pass', 'method', false, '_m(self)'],
  ])('in a class body: %j', async (def, kind, exported, signature) => {
    const got = await classifyAt(`class C:\n    ${def}\n`, 0, 0);
    expect(got).toMatchObject({ declares: 'METHOD', kind, exported, signature });
  });

  it('the same def at module level is a function, whatever its name', async () => {
    expect(await classifyAt('def __init__(self):\n    pass\n', 0)).toMatchObject({
      kind: 'function',
      exported: false,
    });
  });

  it.each([
    ['async def fetch(url):\n    pass\n', true],
    ['async  def fetch(url):\n    pass\n', true],
    ['def asyncfetch(url):\n    pass\n', false],
    ['def fetch(asyncio):\n    pass\n', false],
    ['async\tdef fetch(url):\n    pass\n', true], // r2 (review 11): any whitespace
  ])('async from the keyword: %j', async (source, async) => {
    expect(await classifyAt(source, 0)).toMatchObject({ async });
  });

  it('every parameter shape: typed, defaulted, both, splats, typed splats; separators are no param', async () => {
    const source =
      "def f(a, b: int, c=2, d: str = 'x', /, *args: int, e, **kw):\n    pass\n" +
      'def g(*, k, **opts: dict) -> None:\n    pass\n';
    expect(await classifyAt(source, 0)).toMatchObject({
      signature: "f(a, b: int, c=2, d: str = 'x', /, *args: int, e, **kw)",
      params: [
        ['a', undefined, undefined, 'identifier@0:6'],
        ['b', 'int', undefined, 'typed_parameter@0:9'],
        ['c', undefined, '2', 'default_parameter@0:17'],
        ['d', 'str', "'x'", 'typed_default_parameter@0:22'],
        ['args', 'int', undefined, 'typed_parameter@0:39'],
        ['e', undefined, undefined, 'identifier@0:51'],
        ['kw', undefined, undefined, 'dictionary_splat_pattern@0:54'],
      ],
    });
    expect(await classifyAt(source, 1)).toMatchObject({
      signature: 'g(*, k, **opts: dict) -> None',
      params: [
        ['k', undefined, undefined, 'identifier@2:9'],
        ['opts', 'dict', undefined, 'typed_parameter@2:12'],
      ],
    });
  });

  // Stop-list 197: the signature tells `b`, `*b`, `**b` and `b=1` apart, so interfaceHash does. Each
  // param is normalized (PEP 8 spacing: `b=1` untyped, `b: int = 1` typed); defaults and annotations
  // are their source text, a separator stands where it was written.
  it.each([
    ['def f(b):', 'f(b)'],
    ['def f(*b):', 'f(*b)'],
    ['def f(**b):', 'f(**b)'],
    ['def f(b=1):', 'f(b=1)'],
    ['def f(b = 1):', 'f(b=1)'],
    ['def f(b:int=1):', 'f(b: int = 1)'],
    ['def f(*b: int, **c: str):', 'f(*b: int, **c: str)'],
    ['def f(b:int, * args:int, ** kw):', 'f(b: int, *args: int, **kw)'], // r2 (review 10)
    ['def f(a, /):', 'f(a, /)'],
    ['def f(*, a):', 'f(*, a)'],
    ['def f(a=g(1, 2), b=[]):', 'f(a=g(1, 2), b=[])'],
    ['def f(a={\n    "k": 1,\n}):', 'f(a={\n    "k": 1,\n})'],
  ])('%j has the signature %j', async (def, signature) => {
    expect(await classifyAt(`${def}\n    pass\n`, 0)).toMatchObject({ signature });
  });

  // r2 (review 9): only the six parameter shapes are params; a tuple pattern is none
  it('a tuple-pattern parameter is no param', async () => {
    expect(await classifyAt('def h(a, (b, c)):\n    pass\n', 0)).toMatchObject({
      signature: 'h(a)',
      params: [['a', undefined, undefined, 'identifier@0:6']],
    });
  });

  it('a recovered def with no parameter written (rung 09) has none', async () => {
    expect(await classifyAt('def broken(:\n    pass\n', 0)).toMatchObject({
      name: 'broken',
      signature: 'broken()',
      params: [],
    });
  });

  it.each(HOLES)(
    'an empty name in a %s is no param; the next keeps its position (decision 114)',
    (_shape, hole) => {
      const z = fake('identifier', 'z');
      const parameters = fake('parameters', '', [hole, z]);
      const def = fake('function_definition', 'def f(z):', [], {
        name: fake('identifier', 'f'),
        parameters,
      });
      expect(pythonAdapter.classify(def, 'MODULE')).toMatchObject({
        signature: 'f(z)',
        params: [{ name: 'z', ordinal: 1, node: z }],
      });
    },
  );

  it.each([
    ['"""Say hello.\n\n    More."""', 'Say hello.'],
    ["'''  Padded.  '''", 'Padded.'],
    ['r"""\n    Raw first line.\n    """', 'Raw first line.'],
    ["'single'", 'single'],
    ['""""""', undefined],
    ['"   "', undefined],
    // r2 (review 10): the first line is trimmed again; any prefix letters; only the first statement
    ['"""Head.   \n\n    more"""', 'Head.'],
    ['R"""Raw."""', 'Raw.'],
    ['rf"""Both."""', 'Both.'],
    ['pass\n    """late"""', undefined],
    ['x = "not a docstring"', undefined],
    ['pass', undefined],
  ])('the docstring head of a body opening with %j', async (first, head) => {
    const got = await classifyAt(`def f():\n    ${first}\n`, 0);
    expect(got).toMatchObject({ name: 'f' });
    expect(headOf(got)).toBe(head);
  });
});

describe('classes and members', () => {
  it('a class: kind class, exported by name, structural, its docstring and body', async () => {
    expect(await classifyAt('class Greeter(Base):\n    """A greeter."""\n    x = 1\n', 0)).toEqual({
      declares: 'TYPE_DECL',
      name: 'Greeter',
      kind: 'class',
      exported: true,
      structural: true,
      docstringHead: 'A greeter.',
      body: 'block@1:4',
    });
    expect(await classifyAt('class _Hidden:\n    pass\n', 0)).toMatchObject({
      name: '_Hidden',
      exported: false,
    });
  });

  it.each([
    ['X = 1', { name: 'X', value: 'integer@0:4' }],
    ['X: int = 1', { name: 'X', typeText: 'int', value: 'integer@0:9' }],
    ['X: int', { name: 'X', typeText: 'int' }],
    ['a = b = 1', { name: 'a', value: 'assignment@0:4' }],
  ])('%j is a MEMBER', async (source, want) => {
    expect(await classifyAt(`${source}\n`, 0)).toEqual({ declares: 'MEMBER', ...want });
  });

  it('a class-level assignment is a MEMBER of the class', async () => {
    expect(await classifyAt('class C:\n    greeting = "hello"\n', 0, 0)).toEqual({
      declares: 'MEMBER',
      name: 'greeting',
      value: 'string@1:15',
    });
  });

  it.each([
    'a, b = 1, 2',
    '[a, b] = 1, 2',
    'self.x = 1',
    'x[0] = 1',
    'x += 1',
    'x',
    'print(x)',
    '"""a docstring"""',
  ])('%j is no MEMBER', async (source) => {
    expect(await classifyAt(`${source}\n`, 0)).toBeUndefined();
  });
});

describe('decorated definitions (decision 107)', () => {
  it('a decorated function is its inner function, name token included', async () => {
    const decorated = await classifyAt('@register\n@other(1)\ndef greet(name):\n    pass\n', 0);
    expect(decorated).toMatchObject({
      declares: 'METHOD',
      name: 'greet',
      nameNode: 'greet identifier@2:4',
      kind: 'function',
      signature: 'greet(name)',
      body: 'block@3:4',
    });
  });

  it('a decorated class is its inner class', async () => {
    expect(await classifyAt('@dataclass\nclass P:\n    x: int\n', 0)).toEqual({
      declares: 'TYPE_DECL',
      name: 'P',
      kind: 'class',
      exported: true,
      structural: true,
      body: 'block@2:4',
    });
  });

  it("keeps the container: a class body's @property and its setter are methods", async () => {
    const source =
      'class C:\n    @property\n    def label(self):\n        return 1\n' +
      '    @label.setter\n    async def label(self, value):\n        pass\n';
    expect(await classifyAt(source, 0, 0)).toMatchObject({
      name: 'label',
      kind: 'method',
      signature: 'label(self)',
      nameNode: 'label identifier@2:8',
    });
    expect(await classifyAt(source, 0, 1)).toMatchObject({
      name: 'label',
      kind: 'method',
      async: true,
      signature: 'label(self, value)',
    });
  });

  it('a decorated method inside a decorated class keeps its own container', async () => {
    const source = '@dataclass\nclass C:\n    @staticmethod\n    def __init__():\n        pass\n';
    expect(await classifyAt(source, 0, 0)).toMatchObject({ kind: 'constructor', name: '__init__' });
  });
});

// r2 (review 14): a header without a name, or a def without parameters, is no declaration. Real parses
// turn such headers into ERROR, so these are hand-built nodes with only the named fields.
function headerOnly(type: string, fields: Readonly<Record<string, SyntaxNode>>): SyntaxNode {
  return {
    type,
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 0, column: 9 },
    startIndex: 0,
    endIndex: 9,
    text: 'def f():',
    namedChildren: Object.values(fields),
    childForFieldName: (name) => fields[name] ?? null,
  };
}
const NAME = headerOnly('identifier', {});
const PARAMS = headerOnly('parameters', {});

describe('a header missing a field', () => {
  it.each([
    [
      'a function without a name',
      headerOnly('function_definition', { parameters: PARAMS }),
      'MODULE',
    ],
    ['a function without parameters', headerOnly('function_definition', { name: NAME }), 'MODULE'],
    [
      'a method without a name',
      headerOnly('function_definition', { parameters: PARAMS }),
      'TYPE_DECL',
    ],
    ['a class without a name', headerOnly('class_definition', {}), 'MODULE'],
  ] as const)('%s is undefined', (_name, node, container) => {
    expect(pythonAdapter.classify(node, container)).toBeUndefined();
  });

  it('the same function with both fields is a METHOD (anti-vacuity)', () => {
    const both = headerOnly('function_definition', { name: NAME, parameters: PARAMS });
    expect(pythonAdapter.classify(both, 'MODULE')).toMatchObject({
      declares: 'METHOD',
      params: [],
    });
  });
});

describe('everything else is no node (sparse by design)', () => {
  it.each([
    'import os',
    'from a import b',
    'if x:\n    def f():\n        pass',
    'for i in x:\n    y = i',
    'while x:\n    pass',
    'try:\n    pass\nexcept E:\n    pass',
    'with x as y:\n    z = y',
    'global g',
    'pass',
    'lambda: 1',
    '# a comment',
    ')',
  ])('%j', async (source) => {
    expect(await classifyAt(`${source}\n`, 0)).toBeUndefined();
  });
});
