// Compound statements at module and class level (stop-list 196, sprint 41), on real trees (the pinned wasm
// grammar). Expected values come from the spec, never from running the code: python.ts's compoundChildren
// rule and walk.ts's (a compound statement is not a scope: what it holds is its container's, one level
// deeper), decision 92 (a METHOD body is never descended by Pass A; CALL regions and ordinals), decision 95
// (UNKNOWN), C-EXTRACT I3, I7, I11, I17, and the oracle's reading (bin/py-oracle.py: if/try/with/for/while/
// match bodies at module or class level). Rows are 0-based, columns UTF-16, counted by hand from the source.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isWorkspacePath, type WorkspacePath } from '@cpg/model';
import { BUILTIN_LANGUAGES, createLanguageRegistry, createParseService } from '@cpg/parse';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExtractedFile, ExtractOutcome, ExtractRequest, SyntaxNode } from './contract';
import { createExtractor } from './extractor';
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

const lines = (...rows: string[]) => `${rows.join('\n')}\n`;

function wsPath(value: string): WorkspacePath {
  if (!isWorkspacePath(value)) throw new Error(`not a workspace path: ${value}`);
  return value;
}
const PATH = wsPath('m.py');

/** Parses `source` as m.py, hands its root to `use`, and releases the tree whatever happens. */
async function withRoot<T>(source: string, use: (root: SyntaxNode) => T): Promise<T> {
  const parsed = await service.parse({ key: PATH, text: source });
  if (!parsed.ok) throw new Error(parsed.error.message);
  try {
    return use(parsed.handle.root);
  } finally {
    parsed.handle.release();
  }
}

const extractPy = (source: string, budget?: ExtractRequest['budget']): Promise<ExtractOutcome> =>
  withRoot(source, (root) =>
    createExtractor().extract({
      path: PATH,
      grammarId: 'python',
      root,
      revision_id: 'c4'.repeat(32),
      lineCount: source.split('\n').length,
      ...(budget !== undefined ? { budget } : {}),
    }),
  );

async function extractOk(source: string): Promise<ExtractedFile> {
  const outcome = await extractPy(source);
  if (outcome.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(outcome)}`);
  return outcome.file;
}

const short = (key: string) => key.replace('file:m.py:', '');
const fmt = (r: { startRow: number; startColumn: number; endRow: number; endColumn: number }) =>
  `${r.startRow}:${r.startColumn}-${r.endRow}:${r.endColumn}`;
/** Every node in emission order as `<id without file:m.py:> <range>[ name <range>]`. */
const nodeLines = (file: ExtractedFile) =>
  file.nodes.map(
    (n) => `${short(n.id)} ${fmt(n.range)}${n.nameRange ? ` name ${fmt(n.nameRange)}` : ''}`,
  );
const declIds = (file: ExtractedFile) =>
  file.nodes.filter((n) => !['MODULE', 'CALL'].includes(n.label)).map((n) => short(n.id));
const edgesOf = (file: ExtractedFile, type: string) =>
  file.edges
    .filter((e) => e.type === type)
    .map((e) =>
      [`${short(e.from.key)} -> ${short(e.to.key)}`, ...Object.values(e.properties)].join(' '),
    );
const at = (node: SyntaxNode) =>
  `${node.type}@${node.startPosition.row}:${node.startPosition.column}`;

// ── python.ts: what stands in for a compound statement ──

// Every form the pinned grammar has, one top-level statement each (rows on the right).
const FORMS = lines(
  ...[
    ['if a:', '    x = 1', 'elif b:', '    pass', 'else:  # d', '    y = 2'], // 0-5
    ['for i in r:', '    pass', 'else:', '    z = 1'], // 6-9
    ['async for i in r:', '    pass'], // 10-11
    ['while w:', '    # c', '    pass', 'else:', '    pass'], // 12-16
    ['try:', '    pass', 'except E as e:', '    pass', 'except:', '    pass'], // 17-22
    ['else:', '    pass', 'finally:', '    pass'], // 23-26
    ['with a as b, c:', '    pass', 'async with a:', '    pass'], // 27-30
    ['match s:', '    # note', '    case 1 if g:', '        pass', '    case _:', '        pass'], // 31-36
    ['if a:', '    while b:', '        pass'], // 37-39: a nested compound statement stays whole
    ['if a: x = 1', 'else: y = 2'], // 40-41: one-line bodies
    ['if x:', '    )', '    def f(): pass'], // 42-44: an ERROR in the header stays
  ].flat(),
);
const FORM_CHILDREN = [
  'identifier@0:3 expression_statement@1:4 identifier@2:5 pass_statement@3:4 comment@4:7 expression_statement@5:4',
  'identifier@6:4 identifier@6:9 pass_statement@7:4 expression_statement@9:4',
  'identifier@10:10 identifier@10:15 pass_statement@11:4',
  'identifier@12:6 comment@13:4 pass_statement@14:4 pass_statement@16:4',
  'pass_statement@18:4 as_pattern@19:7 pass_statement@20:4 pass_statement@22:4 pass_statement@24:4 pass_statement@26:4',
  'with_clause@27:5 pass_statement@28:4',
  'with_clause@29:11 pass_statement@30:4',
  'identifier@31:6 comment@32:4 case_pattern@33:9 if_clause@33:11 pass_statement@34:8 case_pattern@35:9 pass_statement@36:8',
  'identifier@37:3 while_statement@38:4',
  'identifier@40:3 expression_statement@40:6 expression_statement@41:6',
  'identifier@42:3 ERROR@43:4 function_definition@44:4',
];
const NOT_COMPOUND = lines(
  ...[
    ['x = 1', 'f()', 'def f():', '    pass', 'class C:', '    pass', '@d', 'def g():', '    pass'],
    ['import os', 'pass', 'if a:', '    pass', 'else:', '    pass'],
  ].flat(),
);

/** What the Python adapter's reading of the first statement says its header ERRORs are. */
const headerErrorsOf = (source: string) =>
  withRoot(source, (root) => {
    const info = root.namedChildren[0] && pythonAdapter.classify(root.namedChildren[0], 'MODULE');
    if (info?.declares !== 'TYPE_DECL') return info;
    return 'headerErrors' in info ? info.headerErrors?.map(at) : 'absent';
  });

describe('python.ts compoundChildren (stop-list 196) and headerErrors (decision 117)', () => {
  it('stands in for each compound form with its parts, blocks and clauses opened in place', async () => {
    const got = await withRoot(FORMS, (root) =>
      root.namedChildren.map((s) => pythonAdapter.compoundChildren?.(s)?.map(at).join(' ')),
    );
    expect(got).toEqual(FORM_CHILDREN);
  });

  it('answers undefined for any other statement, and for a clause or a block on its own', async () => {
    const got = await withRoot(NOT_COMPOUND, (root) => {
      const last = root.namedChildren.at(-1);
      const parts = [
        last?.childForFieldName('consequence'),
        last?.childForFieldName('alternative'),
      ];
      return [...root.namedChildren.slice(0, -1), ...parts].map((s) =>
        s
          ? `${at(s)} ${pythonAdapter.compoundChildren?.(s) === undefined ? 'undefined' : 'defined'}`
          : s,
      );
    });
    expect(got).toEqual(
      ['expression_statement@0:0', 'expression_statement@1:0', 'function_definition@2:0']
        .concat(['class_definition@4:0', 'decorated_definition@6:0', 'import_statement@9:0'])
        .concat(['pass_statement@10:0', 'block@12:4', 'else_clause@13:0'])
        .map((s) => `${s} undefined`),
    );
  });

  it("gives a class its header's ERRORs, decorated or not, and no field when there is none", async () => {
    expect(
      await Promise.all(
        [
          'class C(:\n    def m(self): pass\n',
          '@d\nclass C(:\n    def m(self): pass\n',
          'class C:\n def m(self:\n  pass',
          'class C(B):\n    pass\n',
        ].map(headerErrorsOf),
      ),
    ).toEqual([['ERROR@0:7'], ['ERROR@1:7'], ['ERROR@1:1'], 'absent']);
  });
});

// ── the walker: a compound statement's children are its container's ──

const rows = (...groups: (readonly string[])[]) => lines(...groups.flat());
const EVERY_FORM = rows(
  ['if a():', '    @deco', '    def f1(x):', '        return x()', 'elif b():', '    V1 = c()'], // 0-5
  ['else:', '    class K1:', '        if TYPE:', '            def meth(self): pass'], // 6-9
  ['try:', '    import os', 'except errors() as e:', '    V2 = 1', 'else:', '    V3 = 2'], // 10-15
  ['finally:', '    V4 = 3', 'with d() as h:', '    def f2(): pass'], // 16-19
  ['for i in g():', '    V5 = 4', 'else:', '    V6 = 5', 'while w():', '    V7 = 6'], // 20-25
  ['else:', '    V8 = 7', 'match m():', '    case [1, v] if k():', '        V9 = 8'], // 26-30
  ['    case _:', '        def f3(): pass', 'f1(V1)'], // 31-33
);

describe('Pass A through every compound form (stop-list 196)', () => {
  it('declares what each block holds, with the ids a direct declaration has, in pre-order (I3)', async () => {
    const file = await extractOk(EVERY_FORM);
    expect(nodeLines(file).filter((l) => !l.startsWith('CALL'))).toEqual([
      'MODULE:$root 0:0-34:0',
      'METHOD:f1 1:4-3:18 name 2:8-2:10',
      'PARAM:f1.x 2:11-2:12',
      'MEMBER:V1 5:4-5:12',
      'TYPE_DECL:K1 7:4-9:32',
      'METHOD:K1.meth 9:12-9:32 name 9:16-9:20',
      'PARAM:K1.meth.self 9:21-9:25',
      'MEMBER:V2 13:4-13:10',
      'MEMBER:V3 15:4-15:10',
      'MEMBER:V4 17:4-17:10',
      'METHOD:f2 19:4-19:18 name 19:8-19:10',
      'MEMBER:V5 21:4-21:10',
      'MEMBER:V6 23:4-23:10',
      'MEMBER:V7 25:4-25:10',
      'MEMBER:V8 27:4-27:10',
      'MEMBER:V9 30:8-30:14',
      'METHOD:f3 32:8-32:22 name 32:12-32:14',
    ]);
  });

  it('DECLARES each from its container, never from a compound statement, and mints its SYMBOL', async () => {
    const file = await extractOk(EVERY_FORM);
    const declares = edgesOf(file, 'DECLARES');
    expect([declares.length, declares.filter((e) => !e.startsWith('MODULE:$root -> '))]).toEqual([
      14,
      ['TYPE_DECL:K1 -> METHOD:K1.meth'],
    ]);
    const kind = (fqn: string) =>
      file.symbols.find((s) => s.fqn === `\`m.py\`/${fqn}`)?.properties['kind'];
    expect(['f1().', 'V1.', 'K1#', 'K1#meth().', 'f3().'].map(kind)).toEqual(
      'function variable class method function'.split(' '),
    );
  });

  it('leaves every id of a declaration unchanged when it moves into a compound block', async () => {
    const direct = await extractOk(
      lines('def a(p):', '    pass', 'class C:', '    def m(self):', '        pass', 'X = 1'),
    );
    const wrapped = await extractOk(
      rows(
        ['if T:', '    def a(p):', '        pass', 'try:', '    for i in r:', '        class C:'],
        ['            def m(self):', '                pass', 'except E:', '    pass'],
        ['with W:', '    X = 1'],
      ),
    );
    const expected = 'METHOD:a PARAM:a.p TYPE_DECL:C METHOD:C.m PARAM:C.m.self MEMBER:X'.split(' ');
    expect([declIds(direct), declIds(wrapped)]).toEqual([expected, expected]);
    expect(wrapped.symbols.map((s) => s.fqn)).toEqual(direct.symbols.map((s) => s.fqn));
  });

  it('a class-level compound statement holds methods; a redefinition takes the next ordinal (I7)', async () => {
    const file = await extractOk(
      rows(
        ['class K:', '    if PY3:', '        def m(self):', '            pass', '    else:'],
        ['        try:', '            def m(self, legacy):', '                pass'],
        ['        except E:', '            pass'],
      ),
    );
    expect(declIds(file)).toEqual(
      'TYPE_DECL:K METHOD:K.m PARAM:K.m.self METHOD:K.m:1 PARAM:K.m.self:1 PARAM:K.m.legacy'.split(
        ' ',
      ),
    );
    expect([...edgesOf(file, 'DECLARES'), ...edgesOf(file, 'DEFINES').slice(2)]).toEqual([
      'MODULE:$root -> TYPE_DECL:K',
      'TYPE_DECL:K -> METHOD:K.m',
      'TYPE_DECL:K -> METHOD:K.m:1',
      'METHOD:K.m -> `m.py`/K#m().',
      'METHOD:K.m:1 -> `m.py`/K#m().',
    ]);
  });

  it('never descends a compound statement inside a METHOD body (decision 92)', async () => {
    const file = await extractOk(
      rows(
        ['if T:', '    def top():', '        if U:', '            def inner():'],
        ['                pass', '        for i in r:', '            V = 1'],
      ),
    );
    expect(declIds(file)).toEqual(['METHOD:top']);
  });
});

/** A CALL as `<id> <callee_name> <kind> <range>`. */
const callLine = (n: ExtractedFile['nodes'][number]) =>
  `${short(n.id)} ${String(n.properties['callee_name'])} ${String(n.properties['kind'])} ${fmt(n.range)}`;

describe('Pass B through every compound form (decision 92: no call counted twice)', () => {
  it("counts each call once, the compound statements' own parts in $root, in source order", async () => {
    const file = await extractOk(EVERY_FORM);
    expect(file.nodes.filter((n) => n.label === 'CALL').map(callLine)).toEqual([
      'CALL:$root:0 a call 0:3-0:6',
      'CALL:$root:1 deco decorator 1:4-1:9',
      'CALL:f1:0 x call 3:15-3:18',
      'CALL:$root:2 b call 4:5-4:8',
      'CALL:$root:3 c call 5:9-5:12',
      'CALL:$root:4 errors call 12:7-12:15',
      'CALL:$root:5 d call 18:5-18:8',
      'CALL:$root:6 g call 20:9-20:12',
      'CALL:$root:7 w call 24:6-24:9',
      'CALL:$root:8 m call 28:6-28:9',
      'CALL:$root:9 k call 29:19-29:22',
      'CALL:$root:10 f1 call 33:0-33:6',
    ]);
  });

  it('a def in a compound block is a top-level target, its body its own region; a MEMBER there reaches', async () => {
    const file = await extractOk(EVERY_FORM);
    expect([
      edgesOf(file, 'IN_SCOPE').filter((e) => !e.endsWith('-> MODULE:$root')),
      edgesOf(file, 'CALLS'),
      edgesOf(file, 'REACHING_DEF'),
    ]).toEqual([
      ['CALL:f1:0 -> METHOD:f1'],
      ['CALL:$root:10 -> `m.py`/f1(). resolved'],
      ['MEMBER:V1 -> CALL:$root:10 V1'],
    ]);
  });
});
