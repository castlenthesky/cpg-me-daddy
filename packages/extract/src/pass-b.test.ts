// Pass B, the calls (U6a.2-4a), on real trees (the pinned wasm grammar) through createExtractor.
// Expected values come from the spec, never from running the code: CALL ids and ordinals from controller
// decision 92 and the schema's ordinal_rule ("inserting an unrelated statement above two identical calls
// in one method changes neither id", a required golden test); CALLS from C-EXTRACT I11 and ladder rungs
// 04 and 08; ref sites from the RefSite contract, I12 and I20 and archive refSites.ts (#recv/#type
// share the CALL's nodeId); REACHING_DEF from the U6a.2 acceptance ("last match wins") and archive
// walk.ts resolveArg; decorators from the U6a.2 acceptance ("a decorated function gets a METHOD and a
// CALL{kind:decorator}"); builtins from archive builtins/python-stdlib.ts; I21 for the order of passes.
// pass-b.ts states the contract these readings make. Rows are 0-based, columns UTF-16, counted by hand.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { formatRange, isWorkspacePath } from '@cpg/model';
import { BUILTIN_LANGUAGES, createLanguageRegistry, createParseService } from '@cpg/parse';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  EdgeElement,
  ExtractedFile,
  ExtractOutcome,
  ExtractRequest,
  RefSite,
} from './contract';
import { createExtractor } from './extractor';

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

const REV = 'ab'.repeat(32);
const lines = (...rows: string[]) => `${rows.join('\n')}\n`;

/** Parses `source` as main.py and extracts it, releasing the tree whatever happens. */
async function extractPy(
  source: string,
  budget?: ExtractRequest['budget'],
): Promise<ExtractOutcome> {
  const path = 'main.py';
  if (!isWorkspacePath(path)) throw new Error('not a workspace path');
  const parsed = await service.parse({ key: path, text: source });
  if (!parsed.ok) throw new Error(parsed.error.message);
  try {
    return createExtractor().extract({
      path,
      grammarId: parsed.handle.language,
      root: parsed.handle.root,
      revision_id: REV,
      lineCount: source.split('\n').length,
      ...(budget !== undefined ? { budget } : {}),
    });
  } finally {
    parsed.handle.release();
  }
}

async function extractOk(source: string): Promise<ExtractedFile> {
  const outcome = await extractPy(source);
  if (outcome.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(outcome)}`);
  return outcome.file;
}

const MOD = 'file:main.py:MODULE:$root';
const call = (scope: string, ordinal: number) => `file:main.py:CALL:${scope}:${String(ordinal)}`;

/** Each CALL as `<id> <callee_name>`, in id order. */
const callsOf = (file: ExtractedFile) =>
  file.nodes
    .filter((n) => n.label === 'CALL')
    .map((n) => `${n.id} ${String(n.properties['callee_name'])}`)
    .toSorted();

/** Each edge of `type` as `<from> -> <to>` plus its property values, sorted. */
const edgesOf = (file: ExtractedFile, type: EdgeElement['type']) =>
  file.edges
    .filter((e) => e.type === type)
    .map((e) => [`${e.from.key} -> ${e.to.key}`, ...Object.values(e.properties)].join(' '))
    .toSorted();

/** UTF-16 code-unit order, independent of the locale. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The ref sites without their ids (whose spelling the contract leaves open), by node id then kind. */
const sitesOf = (file: ExtractedFile): Omit<RefSite, 'id'>[] =>
  file.refSites
    .map(({ id: _id, ...rest }) => rest)
    .toSorted((a, b) => byText(`${a.nodeId} ${a.kind}`, `${b.nodeId} ${b.kind}`));

/** A builtin's SYMBOL (archive builtins/python-stdlib.ts; origin `builtin`, see pass-b.ts). */
const builtinSymbol = (name: string) => ({
  fqn: `site:python-stdlib\`${name}().`,
  origin: 'builtin',
  language: 'python',
  properties: { kind: 'function', scheme: 'site', package: 'python-stdlib' },
});

const RUNG_04 = lines(
  'def helper():',
  '    pass',
  '',
  '',
  'def main():',
  '    helper()',
  '    helper()',
);

describe('CALL ids: one ordinal per region, every call counted in pre-order (decision 92)', () => {
  it("tells rung 04's two identical calls apart by ordinal", async () => {
    const file = await extractOk(RUNG_04);
    expect(
      file.nodes.filter((n) => n.label === 'CALL').map((n) => [n.id, formatRange(n.range)]),
    ).toEqual(
      expect.arrayContaining([
        [call('main', 0), '6:4-6:12'],
        [call('main', 1), '7:4-7:12'],
      ]),
    );
    expect(callsOf(file)).toEqual([`${call('main', 0)} helper`, `${call('main', 1)} helper`]);
  });

  it('keeps both ids when unrelated statements are inserted above them (the ordinal_rule golden)', async () => {
    const moved = lines(
      'X = 1',
      '',
      '',
      'def helper():',
      '    pass',
      '',
      '',
      'def main():',
      '    y = 2',
      '    helper()',
      '    helper()',
    );
    expect(callsOf(await extractOk(moved))).toEqual([
      `${call('main', 0)} helper`,
      `${call('main', 1)} helper`,
    ]);
  });

  it('renumbers both when a call is inserted above them, as intended (ladder README Q3)', async () => {
    const inserted = lines(
      'def helper():',
      '    pass',
      '',
      '',
      'def main():',
      '    other()',
      '    helper()',
      '    helper()',
    );
    expect(callsOf(await extractOk(inserted))).toEqual([
      `${call('main', 0)} other`,
      `${call('main', 1)} helper`,
      `${call('main', 2)} helper`,
    ]);
  });

  it("counts another METHOD's calls in that METHOD, not in this one", async () => {
    const two = lines(
      'def helper():',
      '    helper()',
      '',
      '',
      'def main():',
      '    helper()',
      '    helper()',
    );
    expect(callsOf(await extractOk(two))).toEqual([
      `${call('helper', 0)} helper`,
      `${call('main', 0)} helper`,
      `${call('main', 1)} helper`,
    ]);
  });

  it('counts a call before the calls inside it, its callee included, then in source order', async () => {
    const nested = lines('def main():', '    outer(inner(leaf()), other())', '    f(x).g()');
    expect(callsOf(await extractOk(nested))).toEqual([
      `${call('main', 0)} outer`,
      `${call('main', 1)} inner`,
      `${call('main', 2)} leaf`,
      `${call('main', 3)} other`,
      `${call('main', 4)} g`,
      `${call('main', 5)} f`,
    ]);
  });

  it('puts module statements, member initializers and class-level calls in $root, in source order', async () => {
    const src = lines(
      'a()',
      'X = b()',
      '',
      '',
      'def main():',
      '    c()',
      '',
      '',
      'class K:',
      '    Y = d()',
      '',
      '    def m(self):',
      '        f()',
      '',
      '',
      'e()',
    );
    const file = await extractOk(src);
    expect(callsOf(file)).toEqual([
      `${call('$root', 0)} a`,
      `${call('$root', 1)} b`,
      `${call('$root', 2)} d`,
      `${call('$root', 3)} e`,
      `${call('K.m', 0)} f`,
      `${call('main', 0)} c`,
    ]);
    expect(edgesOf(file, 'IN_SCOPE')).toEqual([
      `${call('$root', 0)} -> ${MOD}`,
      `${call('$root', 1)} -> ${MOD}`,
      `${call('$root', 2)} -> ${MOD}`,
      `${call('$root', 3)} -> ${MOD}`,
      `${call('K.m', 0)} -> file:main.py:METHOD:K.m`,
      `${call('main', 0)} -> file:main.py:METHOD:main`,
    ]);
  });

  it("counts a lambda's calls in its METHOD and never descends a nested def or class", async () => {
    const src = lines(
      'def main():',
      '    run = lambda: a()',
      '',
      '    def inner():',
      '        b()',
      '',
      '    class Local:',
      '        c()',
      '',
      '    run()',
    );
    expect(callsOf(await extractOk(src))).toEqual([
      `${call('main', 0)} a`,
      `${call('main', 1)} run`,
    ]);
  });
});

describe('a CALL node, its IN_SCOPE, its ref sites (I12, I20)', () => {
  const SRC = lines('def main(p):', '    obj.method(1, p, key=p)');
  const C = call('main', 0);

  it('is a structural node of the file with the schema properties, no nameRange', async () => {
    const file = await extractOk(SRC);
    expect(file.nodes.filter((n) => n.label === 'CALL')).toEqual([
      {
        label: 'CALL',
        id: C,
        file: 'main.py',
        revision_id: REV,
        tier: 'structural',
        range: { startRow: 1, startColumn: 4, endRow: 1, endColumn: 27 },
        properties: {
          callee_name: 'method',
          receiver_text: 'obj',
          args_count: 3,
          kind: 'call',
          status: 'ready',
        },
      },
    ]);
    expect([file.stats.structuralNodes, file.stats.expressionNodes]).toEqual([4, 0]);
  });

  it('is IN_SCOPE its METHOD, and a receiver call gets no CALLS (resolveCallee is gone)', async () => {
    const file = await extractOk(SRC);
    expect(file.edges.filter((e) => e.type === 'IN_SCOPE')).toEqual([
      {
        type: 'IN_SCOPE',
        from: { by: 'id', label: 'CALL', key: C },
        to: { by: 'id', label: 'METHOD', key: 'file:main.py:METHOD:main' },
        properties: {},
      },
    ]);
    expect(edgesOf(file, 'CALLS')).toEqual([]);
  });

  it('has a call site at the last segment and two declined receiver sites at the receiver', async () => {
    const file = await extractOk(SRC);
    const receiver = {
      nodeId: C,
      filePath: 'main.py',
      position: { row: 1, column: 4 },
      nameParts: ['obj'],
      declined: 'receiver-unknown',
    };
    expect(sitesOf(file)).toEqual([
      {
        nodeId: C,
        filePath: 'main.py',
        kind: 'call',
        position: { row: 1, column: 8 },
        nameParts: ['obj', 'method'],
      },
      { ...receiver, kind: 'receiver' },
      { ...receiver, kind: 'receiver-type' },
    ]);
    expect(new Set(file.refSites.map((s) => s.id)).size).toBe(3);
  });

  it("gives rung 08's constructor call and receiver call their sites", async () => {
    const rung08 = lines(
      'class Greeter:',
      '    def greet(self):',
      '        pass',
      '',
      '',
      'def main():',
      '    g = Greeter()',
      '    g.greet()',
    );
    const file = await extractOk(rung08);
    const recv = {
      nodeId: call('main', 1),
      filePath: 'main.py',
      position: { row: 7, column: 4 },
      nameParts: ['g'],
      declined: 'receiver-unknown',
    };
    expect(sitesOf(file)).toEqual([
      {
        nodeId: call('main', 0),
        filePath: 'main.py',
        kind: 'call',
        position: { row: 6, column: 8 },
        nameParts: ['Greeter'],
      },
      {
        nodeId: call('main', 1),
        filePath: 'main.py',
        kind: 'call',
        position: { row: 7, column: 6 },
        nameParts: ['g', 'greet'],
      },
      { ...recv, kind: 'receiver' },
      { ...recv, kind: 'receiver-type' },
    ]);
    expect(new Set(file.refSites.map((s) => s.id)).size).toBe(4);
    // Rung 08 [resolution]: the constructor is a same-file target (?Q4); the receiver call is U8's.
    expect(edgesOf(file, 'CALLS')).toEqual([`${call('main', 0)} -> \`main.py\`/Greeter# resolved`]);
  });

  it('puts a receiver site on the last name of a dotted receiver, and none on a computed one', async () => {
    // `    a.b.c()`: a 4, b 6, c 8; `    f(x).g()`: f 4, g 9; `    a[0].g()`: g 9
    const file = await extractOk(
      lines('def main(a):', '    a.b.c()', '    f(x).g()', '    a[0].g()'),
    );
    expect(
      sitesOf(file).map(
        (s) =>
          `${s.nodeId} ${s.kind} ${String(s.position.row)}:${String(s.position.column)} ${s.declined ?? '-'}`,
      ),
    ).toEqual([
      `${call('main', 0)} call 1:8 -`,
      `${call('main', 0)} receiver 1:6 receiver-unknown`,
      `${call('main', 0)} receiver-type 1:6 receiver-unknown`,
      `${call('main', 1)} call 2:9 -`,
      `${call('main', 2)} call 2:4 -`,
      `${call('main', 3)} call 3:9 -`,
    ]);
    expect(
      sitesOf(file)
        .filter((s) => s.nodeId === call('main', 0) || s.nodeId === call('main', 2))
        .map((s) => s.nameParts),
    ).toEqual([['a', 'b', 'c'], ['a', 'b'], ['a', 'b'], ['f']]);
    expect(new Set(file.refSites.map((s) => s.id)).size).toBe(6);
  });
});

describe('CALLS (I11): resolved only for a same-file target, external only from the builtin table', () => {
  const SRC = lines(
    'def main():',
    '    def inner():',
    '        pass',
    '',
    '    helper()',
    '    Shape()',
    '    missing()',
    '    greet()',
    '    self.greet()',
    '    print(len([]))',
    '    x.print()',
    '    inner()',
    '',
    '',
    'def helper():',
    '    pass',
    '',
    '',
    'class Shape:',
    '    def greet(self):',
    '        pass',
  );

  it('attributes a top-level def or class (forward references included, I21) and a bare builtin', async () => {
    const file = await extractOk(SRC);
    expect(callsOf(file)).toEqual([
      `${call('main', 0)} helper`,
      `${call('main', 1)} Shape`,
      `${call('main', 2)} missing`,
      `${call('main', 3)} greet`,
      `${call('main', 4)} greet`,
      `${call('main', 5)} print`,
      `${call('main', 6)} len`,
      `${call('main', 7)} print`,
      `${call('main', 8)} inner`,
    ]);
    expect(edgesOf(file, 'CALLS')).toEqual([
      `${call('main', 0)} -> \`main.py\`/helper(). resolved`,
      `${call('main', 1)} -> \`main.py\`/Shape# resolved`,
      `${call('main', 5)} -> site:python-stdlib\`print(). external`,
      `${call('main', 6)} -> site:python-stdlib\`len(). external`,
    ]);
    expect(file.edges.find((e) => e.type === 'CALLS')).toEqual({
      type: 'CALLS',
      from: { by: 'id', label: 'CALL', key: call('main', 0) },
      to: { by: 'fqn', label: 'SYMBOL', key: '`main.py`/helper().' },
      properties: { status: 'resolved' },
    });
  });

  it('mints a builtin SYMBOL once each, and no SYMBOL for a name it did not attribute', async () => {
    const file = await extractOk(SRC);
    expect(file.symbols.map((s) => s.fqn).toSorted()).toEqual(
      [
        '`main.py`/',
        '`main.py`/main().',
        '`main.py`/helper().',
        '`main.py`/Shape#',
        '`main.py`/Shape#greet().',
        'site:python-stdlib`print().',
        'site:python-stdlib`len().',
      ].toSorted(),
    );
    expect(
      file.symbols.filter((s) => s.origin !== 'local').toSorted((a, b) => byText(a.fqn, b.fqn)),
    ).toEqual([builtinSymbol('len'), builtinSymbol('print')]);
  });

  it('leaves every call site open for the resolver: none is declined (only receivers are, I12)', async () => {
    const file = await extractOk(SRC);
    expect(file.refSites.filter((s) => s.kind === 'call').map((s) => s.declined)).toEqual(
      Array.from({ length: 9 }, () => undefined),
    );
    // Nine calls, two of them with a receiver (`self.greet()`, `x.print()`): 9 + 2 x 2 sites.
    expect(file.refSites.length).toBe(13);
  });

  it('prefers a same-file def to the builtin of the same name', async () => {
    const file = await extractOk(
      lines('def len(x):', '    return 0', '', '', 'def main():', '    len(1)'),
    );
    expect(edgesOf(file, 'CALLS')).toEqual([`${call('main', 0)} -> \`main.py\`/len(). resolved`]);
    expect(file.symbols.filter((s) => s.origin !== 'local')).toEqual([]);
  });
});

describe('REACHING_DEF: a binding reaches the CALL that takes it as an argument (last match wins)', () => {
  const SRC = lines(
    'X = 1',
    'X = 2',
    '',
    '',
    'def f(a, b):',
    '    b = 3',
    '    g(a, a, b, X)',
    '    h(Y)',
    '    j(key=a)',
    '    g(m(a))',
    '',
    '',
    'Y = 4',
    'print(X, Y)',
  );

  it('from a PARAM or the last earlier module MEMBER; never a locally assigned name; one edge per variable', async () => {
    const file = await extractOk(SRC);
    expect(callsOf(file)).toEqual([
      `${call('$root', 0)} print`,
      `${call('f', 0)} g`,
      `${call('f', 1)} h`,
      `${call('f', 2)} j`,
      `${call('f', 3)} g`,
      `${call('f', 4)} m`,
    ]);
    expect(edgesOf(file, 'REACHING_DEF')).toEqual(
      [
        `file:main.py:PARAM:f.a -> ${call('f', 0)} a`,
        `file:main.py:MEMBER:X:1 -> ${call('f', 0)} X`,
        `file:main.py:PARAM:f.a -> ${call('f', 2)} a`,
        `file:main.py:PARAM:f.a -> ${call('f', 4)} a`,
        `file:main.py:MEMBER:X:1 -> ${call('$root', 0)} X`,
        `file:main.py:MEMBER:Y -> ${call('$root', 0)} Y`,
      ].toSorted(),
    );
  });

  it('is an edge from the declaring node, with the variable', async () => {
    const file = await extractOk(SRC);
    expect(
      file.edges.filter((e) => e.type === 'REACHING_DEF' && e.to.key === call('f', 0)),
    ).toEqual(
      expect.arrayContaining([
        {
          type: 'REACHING_DEF',
          from: { by: 'id', label: 'MEMBER', key: 'file:main.py:MEMBER:X:1' },
          to: { by: 'id', label: 'CALL', key: call('f', 0) },
          properties: { variable: 'X' },
        },
        {
          type: 'REACHING_DEF',
          from: { by: 'id', label: 'PARAM', key: 'file:main.py:PARAM:f.a' },
          to: { by: 'id', label: 'CALL', key: call('f', 0) },
          properties: { variable: 'a' },
        },
      ]),
    );
  });
});

describe('decorators: a decorated function gets a METHOD and a CALL of kind decorator', () => {
  const SRC = lines(
    'def dec(fn):',
    '    return fn',
    '',
    '',
    '@dec',
    'def f():',
    '    pass',
    '',
    '',
    '@dec',
    'class K:',
    '    @dec',
    '    def m(self):',
    '        pass',
    '',
    '    @m.setter',
    '    def m(self, v):',
    '        pass',
  );

  it('counts each decorator in $root, in source order, IN_SCOPE the MODULE, range the decorator', async () => {
    const file = await extractOk(SRC);
    expect(
      file.nodes
        .filter((n) => n.label === 'CALL')
        .map((n) =>
          [
            n.id,
            n.properties['callee_name'],
            n.properties['kind'],
            n.properties['args_count'],
            n.properties['receiver_text'] ?? '-',
            formatRange(n.range),
          ].join(' '),
        )
        .toSorted(),
    ).toEqual([
      `${call('$root', 0)} dec decorator 0 - 5:0-5:4`,
      `${call('$root', 1)} dec decorator 0 - 10:0-10:4`,
      `${call('$root', 2)} dec decorator 0 - 12:4-12:8`,
      `${call('$root', 3)} setter decorator 0 m 16:4-16:13`,
    ]);
    expect(edgesOf(file, 'IN_SCOPE')).toEqual(
      [0, 1, 2, 3].map((n) => `${call('$root', n)} -> ${MOD}`),
    );
    expect(file.nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining(['file:main.py:METHOD:f', 'file:main.py:TYPE_DECL:K']),
    );
  });

  it('resolves a decorator bound in the file, and gives a dotted one a declined receiver', async () => {
    const file = await extractOk(SRC);
    expect(edgesOf(file, 'CALLS')).toEqual(
      [0, 1, 2].map((n) => `${call('$root', n)} -> \`main.py\`/dec(). resolved`),
    );
    const sites = sitesOf(file);
    expect(sites.filter((s) => s.nodeId === call('$root', 0))).toEqual([
      {
        nodeId: call('$root', 0),
        filePath: 'main.py',
        kind: 'call',
        position: { row: 4, column: 1 },
        nameParts: ['dec'],
      },
    ]);
    const recv = {
      nodeId: call('$root', 3),
      filePath: 'main.py',
      position: { row: 15, column: 5 },
      nameParts: ['m'],
      declined: 'receiver-unknown',
    };
    expect(sites.filter((s) => s.nodeId === call('$root', 3))).toEqual([
      {
        nodeId: call('$root', 3),
        filePath: 'main.py',
        kind: 'call',
        position: { row: 15, column: 6 },
        nameParts: ['m', 'setter'],
      },
      { ...recv, kind: 'receiver' },
      { ...recv, kind: 'receiver-type' },
    ]);
  });
});

describe('Pass B runs after Pass A has completed the file (I21)', () => {
  const SRC = lines('def main():', '    helper()', '', '', 'def helper():', '    pass');

  it('resolves a call to a def further down', async () => {
    expect(edgesOf(await extractOk(SRC), 'CALLS')).toEqual([
      `${call('main', 0)} -> \`main.py\`/helper(). resolved`,
    ]);
  });

  it('does not run on a file the budget truncated: no CALL, no Pass B edge, no ref site', async () => {
    // maxNodes 2: the root and `main` are visited; `helper` would be the third (walk.ts budget rule).
    const outcome = await extractPy(SRC, { maxNodes: 2 });
    if (outcome.kind !== 'truncated') throw new Error(`expected truncated, got ${outcome.kind}`);
    expect(outcome.file.nodes.map((n) => n.id)).toEqual([MOD, 'file:main.py:METHOD:main']);
    expect(outcome.file.edges.map((e) => e.type).toSorted()).toEqual([
      'DECLARES',
      'DEFINES',
      'DEFINES',
    ]);
    expect(outcome.file.refSites).toEqual([]);
  });
});
