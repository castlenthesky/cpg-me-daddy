// The Python expression table on real trees (the pinned wasm grammar), U6a.2-4a: what
// `classifyExpression` says about a call, a decorator and the nodes Pass B must not or need not
// descend, and what `localBindings` finds. Expected values come from python.ts's contract (the archive's
// classifyExpressionPy, calleeShape, argInfos and localBindingsPy; subgraph.ts's receiver rule, kept by
// 11-salvage.yaml; the builtin sets of f18ee71 builtins/python-stdlib.ts and 21754b4 pythonPath.ts),
// C-EXTRACT I20 (the ref token is the LAST callee segment) and decision 92. Positions are counted by
// hand from each source string (0-based rows, UTF-16 columns).
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isWorkspacePath, type WorkspacePath } from '@cpg/model';
import { BUILTIN_LANGUAGES, createLanguageRegistry, createParseService } from '@cpg/parse';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExpressionVerdict, SyntaxNode } from './contract';
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

/** A node as `text@row:col`. */
const at = (node: SyntaxNode | undefined) =>
  node === undefined
    ? undefined
    : `${node.text}@${String(node.startPosition.row)}:${String(node.startPosition.column)}`;

/** The first node in pre-order with this type that starts at row:col. */
function find(root: SyntaxNode, type: string, row: number, column: number): SyntaxNode | undefined {
  if (
    root.type === type &&
    root.startPosition.row === row &&
    root.startPosition.column === column
  ) {
    return root;
  }
  for (const child of root.namedChildren) {
    const found = find(child, type, row, column);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** A readable projection of a verdict: tokens as `text@row:col`, args as `[identifier, node]`. */
function summary(verdict: ExpressionVerdict | undefined): unknown {
  if (verdict === undefined || verdict.emits === 'none') return verdict;
  return {
    ...verdict,
    nameNode: at(verdict.nameNode),
    receiverNode: at(verdict.receiverNode),
    args: verdict.args.map((a) => [a.identifier, `${a.node.type}@${at(a.node) ?? ''}`]),
  };
}

/** Parses `source` and runs `use` on its root, releasing the tree whatever happens. */
async function onTree<T>(source: string, use: (root: SyntaxNode) => T): Promise<T> {
  const parsed = await service.parse({ key: MAIN, text: source });
  if (!parsed.ok) throw new Error(parsed.error.message);
  try {
    return use(parsed.handle.root);
  } finally {
    parsed.handle.release();
  }
}

/** classifyExpression on the node of `type` at row:col of `source`, projected. */
function verdictAt(source: string, type: string, row: number, column: number): Promise<unknown> {
  return onTree(source, (root) => {
    const node = find(root, type, row, column);
    if (node === undefined) throw new Error(`no ${type} at ${String(row)}:${String(column)}`);
    return summary(pythonAdapter.classifyExpression?.(node));
  });
}

const call = (over: Record<string, unknown>) => ({
  emits: 'CALL',
  kind: 'call',
  receiverNode: undefined,
  args: [],
  ...over,
});
const builtin = (name: string) => ({
  scheme: 'site',
  package: 'python-stdlib',
  descriptors: [{ kind: 'method', name }],
});

describe('a call', () => {
  it('a bare callee: its name, its token, its chain', async () => {
    expect(await verdictAt('helper()\n', 'call', 0, 0)).toEqual(
      call({ calleeName: 'helper', nameParts: ['helper'], nameNode: 'helper@0:0' }),
    );
  });

  it('a receiver call: the last segment, the receiver as written and its token, every argument', async () => {
    // obj.method(1, p, key=q): `method` at 4, `1` at 11, `p` at 14, `key=q` at 17
    expect(await verdictAt('obj.method(1, p, key=q)\n', 'call', 0, 0)).toEqual(
      call({
        calleeName: 'method',
        receiverText: 'obj',
        nameParts: ['obj', 'method'],
        nameNode: 'method@0:4',
        receiverNode: 'obj@0:0',
        args: [
          [undefined, 'integer@1@0:11'],
          ['p', 'identifier@p@0:14'],
          ['q', 'keyword_argument@key=q@0:17'],
        ],
      }),
    );
  });

  it('a dotted chain: the receiver token is the chain’s last name (subgraph.ts receiverToken)', async () => {
    // a.b.c(): `b` at 2, `c` at 4
    expect(await verdictAt('a.b.c()\n', 'call', 0, 0)).toEqual(
      call({
        calleeName: 'c',
        receiverText: 'a.b',
        nameParts: ['a', 'b', 'c'],
        nameNode: 'c@0:4',
        receiverNode: 'b@0:2',
      }),
    );
  });

  it.each([
    ['f(x).g()\n', 'f(x)', 'g@0:5'],
    ['a[0].g()\n', 'a[0]', 'g@0:5'],
  ])(
    'a computed receiver %j keeps its text and its callee token, and has no receiver token',
    async (source, receiverText, nameNode) => {
      const got = await verdictAt(source, 'call', 0, 0);
      expect(got).toEqual(
        expect.objectContaining({
          emits: 'CALL',
          kind: 'call',
          calleeName: 'g',
          receiverText,
          nameNode,
          receiverNode: undefined,
        }),
      );
    },
  );

  it.each(['print', 'len', 'str', 'isinstance', 'range'])(
    'a bare call to the builtin %s carries the table’s target',
    async (name) => {
      const got = await verdictAt(`${name}(x)\n`, 'call', 0, 0);
      expect(got).toEqual(expect.objectContaining({ calleeName: name, builtin: builtin(name) }));
    },
  );

  it.each([
    ['x.print()\n', 'print'],
    ['dataclass()\n', 'dataclass'],
    ['helper()\n', 'helper'],
  ])(
    '%j carries no builtin (an attribute callee, or a name not in the table)',
    async (source, name) => {
      const got = await onTree(source, (root) => {
        const node = find(root, 'call', 0, 0);
        return node === undefined ? undefined : pythonAdapter.classifyExpression?.(node);
      });
      const info = got?.emits === 'CALL' ? got : undefined;
      expect([info?.calleeName, info?.builtin]).toEqual([name, undefined]);
    },
  );
});

describe('a decorator (U6a.2 acceptance: a CALL of kind decorator)', () => {
  const SRC =
    '@dec\ndef f():\n    pass\n\n\n@a.b\ndef g():\n    pass\n\n\n@property\ndef h():\n    pass\n';

  it('a bare decorator: kind decorator, its name token after the @, no argument written', async () => {
    expect(await verdictAt(SRC, 'decorator', 0, 0)).toEqual(
      call({ kind: 'decorator', calleeName: 'dec', nameParts: ['dec'], nameNode: 'dec@0:1' }),
    );
  });

  it('a dotted decorator: the last segment, and its receiver', async () => {
    // row 5 `@a.b`: `a` at 1, `b` at 3
    expect(await verdictAt(SRC, 'decorator', 5, 0)).toEqual(
      call({
        kind: 'decorator',
        calleeName: 'b',
        receiverText: 'a',
        nameParts: ['a', 'b'],
        nameNode: 'b@5:3',
        receiverNode: 'a@5:1',
      }),
    );
  });

  it('a builtin decorator carries the table’s target (property is in f18ee71’s set)', async () => {
    expect(await verdictAt(SRC, 'decorator', 10, 0)).toEqual(
      call({
        kind: 'decorator',
        calleeName: 'property',
        nameParts: ['property'],
        nameNode: 'property@10:1',
        builtin: builtin('property'),
      }),
    );
  });
});

describe('what Pass B descends (decision 92)', () => {
  const SRC = [
    'def main():',
    '    run = lambda: a()',
    '    def inner():',
    '        pass',
    '    class Local:',
    '        pass',
    '    @dec',
    '    def deco():',
    '        pass',
    '    x = 1',
    '',
  ].join('\n');

  it('a lambda is transparent', async () => {
    // row 1 `    run = lambda: a()`: the lambda at 10
    expect(await verdictAt(SRC, 'lambda', 1, 10)).toEqual({
      emits: 'none',
      descend: 'transparent',
    });
  });

  it.each([
    ['function_definition', 2, 4],
    ['class_definition', 4, 4],
    ['decorated_definition', 6, 4],
  ])('a nested %s is a stop', async (type, row, column) => {
    expect(await verdictAt(SRC, type, row, column)).toEqual({ emits: 'none', descend: 'stop' });
  });

  it.each([
    ['block', 1, 4],
    ['expression_statement', 9, 4],
    ['assignment', 9, 4],
    ['identifier', 9, 4],
    ['integer', 9, 8],
  ])('a %s is descended ordinarily (undefined)', async (type, row, column) => {
    expect(await verdictAt(SRC, type, row, column)).toBeUndefined();
  });
});

describe('localBindings (REACHING_DEF’s shadow set)', () => {
  it('names each plain or typed assignment target in order, outside nested scopes', async () => {
    const src = [
      'def f(p):',
      '    a = 1',
      '    b: int = 2',
      '    c, d = 3, 4',
      '    self.e = 5',
      '    if p:',
      '        g = 6',
      '    h = lambda: (k := 1)',
      '    def inner():',
      '        m = 7',
      '    class K:',
      '        n = 8',
      '',
    ].join('\n');
    const got = await onTree(src, (root) => {
      const body = root.namedChildren[0]?.childForFieldName('body');
      if (body === null || body === undefined) throw new Error('no body');
      return pythonAdapter.localBindings?.(body);
    });
    expect(got).toEqual(['a', 'b', 'g', 'h']);
  });
});
