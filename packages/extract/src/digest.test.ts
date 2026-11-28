// elementDigest (I18, Q7), interfaceHash (ND-9) and sealExtractedFiles (decision 94; L-20, L-44).
// Known answers were computed by an independent Python script from the projection decision 94 and
// digest.ts's doc spell out (json.dumps sort_keys, FNV-1a over UTF-16 code units, hashlib.sha256);
// never by running this package.
import { isWorkspacePath, type WorkspacePath } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import type { BuiltElements } from './builder';
import type { ExtractedFile, NodeElement, RefSite, SymbolElement } from './contract';
import { elementDigest, interfaceHash, sealExtractedFiles } from './digest';

function wsPath(value: string): WorkspacePath {
  if (!isWorkspacePath(value)) throw new Error(`not a workspace path: ${value}`);
  return value;
}

const PATH = wsPath('main.py');
const MOD = 'file:main.py:MODULE:$root';
const FQN = '`main.py`/';
const NONE: BuiltElements = { nodes: [], symbols: [], edges: [], refSites: [] };

const moduleNode = (over: Partial<NodeElement> = {}): NodeElement => ({
  label: 'MODULE',
  id: MOD,
  file: PATH,
  revision_id: 'a'.repeat(64),
  tier: 'structural',
  range: { startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 },
  properties: { name: 'main', status: 'ready' },
  ...over,
});
const moduleSymbol = (over: Partial<SymbolElement> = {}): SymbolElement => ({
  fqn: FQN,
  origin: 'local',
  language: 'python',
  properties: { kind: 'module' },
  ...over,
});
const DEFINES: BuiltElements['edges'][number] = {
  type: 'DEFINES',
  from: { by: 'id', label: 'MODULE', key: MOD },
  to: { by: 'fqn', label: 'SYMBOL', key: FQN },
  properties: {},
};
const rung01 = (over: Partial<BuiltElements> = {}): BuiltElements => ({
  nodes: [moduleNode()],
  symbols: [moduleSymbol()],
  edges: [DEFINES],
  refSites: [],
  ...over,
});
const site = (id: string, over: Partial<RefSite> = {}): RefSite => ({
  id,
  nodeId: 'file:main.py:CALL:$root:0',
  filePath: PATH,
  kind: 'call',
  position: { row: 1, column: 4 },
  nameParts: ['greet'],
  ...over,
});
const exported = (id: string, properties: NodeElement['properties']): NodeElement =>
  moduleNode({ label: 'METHOD', id, properties });

const SHA_OF_EMPTY_LIST = 'sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';

describe('elementDigest', () => {
  it('is fnv1a32 of the empty text for four empty arrays', () => {
    expect(elementDigest(NONE)).toBe('fnv1a32:811c9dc5');
  });

  it("matches the oracle for rung 01's MODULE, SYMBOL and DEFINES", () => {
    // E:{"from":{"by":"id","key":"file:main.py:MODULE:$root","label":"MODULE"},"properties":{},...}
    // N:{"file":"main.py","id":...,"tier":"structural"}  (no revision_id)
    // S:{"fqn":"`main.py`/","language":"python","origin":"local","properties":{"kind":"module"}}
    expect(elementDigest(rung01())).toBe('fnv1a32:ac9b85e9');
  });

  it('matches the oracle with a ref site, a list and mixed-case keys (r2)', () => {
    // Lines N:, R:, S: in that order; keys by code unit, so "Zed" before "alpha"; lists keep order.
    const nodes = [moduleNode({ properties: { alpha: 'a', Zed: ['b', 'a'], name: 'main' } })];
    const refSites: RefSite[] = [
      site('s1', {
        nodeId: 'file:main.py:IMPORT:$root:0',
        kind: 'import',
        position: { row: 0, column: 5 },
        nameParts: ['os', 'path'],
        importBinding: { module: 'os.path', relativeDepth: 0, imported: 'join', local: 'j' },
      }),
    ];
    // R: after S: would give fnv1a32:3516bbcf.
    expect(elementDigest({ ...NONE, nodes, symbols: [moduleSymbol()], refSites })).toBe(
      'fnv1a32:fba52f35',
    );
  });

  it('hashes UTF-16 code units, not UTF-8 bytes', () => {
    const symbols = [{ ...moduleSymbol({ fqn: '`a.py`/' }), properties: { doc: 'café 😀' } }];
    // UTF-8 bytes would give fnv1a32:eda50417.
    expect(elementDigest({ ...NONE, symbols })).toBe('fnv1a32:5e159c98');
  });

  it('does not change when only revision_id does (I18)', () => {
    const other = rung01({ nodes: [moduleNode({ revision_id: 'b'.repeat(64) })] });
    expect(elementDigest(other)).toBe(elementDigest(rung01()));
  });

  it('ignores the order of elements inside an array and of keys inside an object', () => {
    const second = moduleNode({ label: 'METHOD', id: 'file:main.py:METHOD:f' });
    const flipped = moduleNode({ properties: { status: 'ready', name: 'main' } });
    const a = rung01({ nodes: [moduleNode(), second], refSites: [site('r1'), site('r2')] });
    const b = rung01({ nodes: [second, flipped], refSites: [site('r2'), site('r1')] });
    expect(elementDigest(b)).toBe(elementDigest(a));
  });

  it.each([
    ['a node property', rung01({ nodes: [moduleNode({ properties: { name: 'other' } })] })],
    [
      'a node range',
      rung01({ nodes: [moduleNode({ range: { ...moduleNode().range, endRow: 1 } })] }),
    ],
    ['a node tier', rung01({ nodes: [moduleNode({ tier: 'expression' })] })],
    ['a symbol field', rung01({ symbols: [moduleSymbol({ language: 'typescript' })] })],
    ['an edge property', rung01({ edges: [{ ...DEFINES, properties: { a: 1 } }] })],
    ['an added ref site (Q7)', rung01({ refSites: [site('r1')] })],
    ['a decline reason (Q7)', rung01({ refSites: [site('r1', { declined: 'no-definition' })] })],
    ['a dropped symbol', rung01({ symbols: [] })],
  ])('changes with %s', (_what, changed) => {
    expect(elementDigest(changed)).not.toBe(elementDigest(rung01()));
  });

  it('tells a ref site from a declined copy of it', () => {
    const plain = rung01({ refSites: [site('r1')] });
    const declined = rung01({ refSites: [site('r1', { declined: 'no-definition' })] });
    expect(elementDigest(declined)).not.toBe(elementDigest(plain));
  });
});

const exportedFn = (name: string): NodeElement =>
  exported(`file:main.py:METHOD:${name}`, {
    exported: true,
    kind: 'function',
    signature: `${name}()`,
  });
const run = (cls: string, signature: string): NodeElement =>
  exported(`file:main.py:METHOD:${cls}.run`, { exported: true, kind: 'method', signature });

describe('interfaceHash', () => {
  it('is sha256 of [] with no exported node', () => {
    expect(interfaceHash([])).toBe(SHA_OF_EMPTY_LIST);
    const notExported = [
      moduleNode(),
      exported('file:main.py:METHOD:_hidden', { exported: false, kind: 'function' }),
      exported('file:main.py:METHOD:loose', { exported: 'true', kind: 'function' }),
    ];
    expect(interfaceHash(notExported)).toBe(SHA_OF_EMPTY_LIST);
  });

  it('matches the oracle for one exported class and one exported function', () => {
    // [["file:main.py:METHOD:greet","function","greet()"],["file:main.py:TYPE_DECL:Greeter","class",null]]
    const cls = moduleNode({
      label: 'TYPE_DECL',
      id: 'file:main.py:TYPE_DECL:Greeter',
      properties: { exported: true, kind: 'class', name: 'Greeter' },
    });
    const fn = exported('file:main.py:METHOD:greet', {
      exported: true,
      kind: 'function',
      signature: 'greet()',
    });
    const want = 'sha256:ba3d4bbf5f4a05b6fcd942b0981dde79fd929da490a544611235654102abe136';
    expect(interfaceHash([cls, fn])).toBe(want);
    expect(interfaceHash([fn, moduleNode(), cls])).toBe(want);
  });

  it('reads a non-string kind or signature as null', () => {
    const asNull = exported('file:main.py:METHOD:f', { exported: true });
    const asNumber = exported('file:main.py:METHOD:f', { exported: true, kind: 3, signature: 4 });
    expect(interfaceHash([asNumber])).toBe(interfaceHash([asNull]));
    expect(interfaceHash([asNull])).not.toBe(SHA_OF_EMPTY_LIST);
  });

  it('changes with a signature, a kind or an id, and with nothing else', () => {
    const base = exported('file:main.py:METHOD:f', {
      exported: true,
      kind: 'function',
      signature: 'f()',
    });
    const h = interfaceHash([base]);
    const props = base.properties;
    expect(interfaceHash([{ ...base, properties: { ...props, signature: 'f(x)' } }])).not.toBe(h);
    expect(interfaceHash([{ ...base, properties: { ...props, kind: 'method' } }])).not.toBe(h);
    expect(interfaceHash([{ ...base, id: 'file:main.py:METHOD:g' }])).not.toBe(h);
    const moved = { ...base, range: { startRow: 9, startColumn: 0, endRow: 12, endColumn: 0 } };
    const redoc = { ...base, properties: { ...props, docstring_head: 'Now documented.' } };
    expect(interfaceHash([{ ...moved, revision_id: 'c'.repeat(64) }])).toBe(h);
    expect(interfaceHash([redoc])).toBe(h);
  });

  it('sorts entries by code unit, not by locale (r2)', () => {
    // [["file:main.py:METHOD:Zeta","function","Zeta()"],["file:main.py:METHOD:alpha","function","alpha()"]]
    const want = 'sha256:303ad47a87032dd589c0ccda84007a46caf34f252ee5e0a65ea8c17d7dc2c79e';
    expect(interfaceHash([exportedFn('alpha'), exportedFn('Zeta')])).toBe(want);
  });

  it('keeps two classes with same-named methods apart', () => {
    const before = [run('A', 'run(self)'), run('B', 'run(self, x)')];
    const swapped = [run('A', 'run(self, x)'), run('B', 'run(self)')];
    expect(interfaceHash(swapped)).not.toBe(interfaceHash(before));
  });
});

// BMO-134: each re-export is the entry [local, 'reexport', <dots><module>[:<imported>]] (digest.ts).
const reexport = (local: string, module: string, relativeDepth = 0, imported?: string) => ({
  module,
  relativeDepth,
  ...(imported !== undefined ? { imported } : {}),
  local,
});
const ENGINE = reexport('Engine', 'core', 1, 'Engine');

describe('interfaceHash re-exports (decision 94, BMO-134)', () => {
  it('matches the oracle for a from-import beside a function', () => {
    // [["Engine","reexport",".core:Engine"],["file:main.py:METHOD:greet","function","greet()"]]
    const want = 'sha256:be289f406598bd0271574623069205f4a93e7f64f6f77808d0c384365e1bebc2';
    expect(interfaceHash([exportedFn('greet')], [ENGINE])).toBe(want);
  });

  it('spells a whole-module import without `:` and a bare relative module as its dots', () => {
    // [["os","reexport","os"],["x","reexport","..:x"]], sorted whatever the input order
    const want = 'sha256:5520a4a1e3d7fa18da0bcaa7b3dc7d4445747ad5b9e138a0056511701aec322b';
    const os = reexport('os', 'os');
    const x = reexport('x', '', 2, 'x');
    expect([interfaceHash([], [x, os]), interfaceHash([], [os, x])]).toEqual([want, want]);
  });

  it.each([
    ['local', reexport('Motor', 'core', 1, 'Engine')],
    ['module', reexport('Engine', 'engine', 1, 'Engine')],
    ['relativeDepth', reexport('Engine', 'core', 2, 'Engine')],
    ['imported', reexport('Engine', 'core', 1, 'Motor')],
    ['imported absent', reexport('Engine', 'core', 1)],
  ])('changes with its %s', (_what, changed) => {
    expect(interfaceHash([], [changed])).not.toBe(interfaceHash([], [ENGINE]));
  });
});

const fileAt = (path: string, siteIds: readonly string[] = []): ExtractedFile => ({
  path: wsPath(path),
  grammarId: 'python',
  revision_id: 'f'.repeat(64),
  nodes: [],
  symbols: [],
  edges: [],
  refSites: siteIds.map((id) => site(id, { filePath: wsPath(path) })),
  stats: { astNodesVisited: 1, structuralNodes: 0, expressionNodes: 0, lineCount: 0 },
  elementDigest: 'fnv1a32:811c9dc5',
  interfaceHash: SHA_OF_EMPTY_LIST,
});

function* two(): Generator<ExtractedFile> {
  yield fileAt('y.py', ['1']);
  yield fileAt('x.py', ['2']);
}

describe('sealExtractedFiles', () => {
  it('maps each path to its file in path order, ref sites in (path, site id) order', () => {
    const b = fileAt('b.py', ['s2', 's1']);
    const upper = fileAt('B.py', ['z']);
    const a = fileAt('a.py', ['r2', 'r10', 'a1', 'r1', 'Z1']);
    const nested = fileAt('a/x.py', ['q']);
    const outcome = sealExtractedFiles([b, a, upper, nested]);
    if (outcome.kind !== 'ok') throw new Error(`expected ok, got ${outcome.kind}`);
    // UTF-16 code units: 'B' (66) < 'a' (97), and 'a.py' < 'a/x.py' ('.' 46 < '/' 47).
    expect([...outcome.set.files.keys()]).toEqual(['B.py', 'a.py', 'a/x.py', 'b.py']);
    expect(outcome.set.files.get(wsPath('a.py'))).toBe(a);
    expect(outcome.set.refSites.map((s) => `${s.filePath} ${s.id}`)).toEqual([
      'B.py z',
      'a.py Z1',
      'a.py a1',
      'a.py r1',
      'a.py r10',
      'a.py r2',
      'a/x.py q',
      'b.py s1',
      'b.py s2',
    ]);
  });

  it('fails naming each repeated path once, sorted', () => {
    const files = ['c.py', 'b.py', 'a.py', 'b.py', 'c.py', 'b.py'].map((p) => fileAt(p));
    expect(sealExtractedFiles(files)).toEqual({ kind: 'failed', duplicatePaths: ['b.py', 'c.py'] });
    // r2: by code unit, 'B.py' before 'a.py'.
    const mixed = ['a.py', 'B.py', 'a.py', 'B.py'].map((p) => fileAt(p));
    expect(sealExtractedFiles(mixed)).toEqual({ kind: 'failed', duplicatePaths: ['B.py', 'a.py'] });
  });

  it('seals nothing into an empty set, and takes any iterable', () => {
    const empty = sealExtractedFiles([]);
    if (empty.kind !== 'ok') throw new Error('expected ok');
    expect([empty.set.files.size, empty.set.refSites]).toEqual([0, []]);
    const generated = sealExtractedFiles(two());
    if (generated.kind !== 'ok') throw new Error('expected ok');
    expect(generated.set.refSites.map((s) => s.filePath)).toEqual(['x.py', 'y.py']);
  });
});
