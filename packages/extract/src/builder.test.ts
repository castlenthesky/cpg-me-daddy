// C-EXTRACT's runtime asserts (class R: I5-I10, I19) on ElementBuilder. Expected invariants come from
// the contract's text; each failure row breaks exactly one rule of an otherwise valid file.
import { isWorkspacePath, type WorkspacePath } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import { ElementBuilder, ExtractInvariantError } from './builder';
import type { EdgeElement, EndpointRef, NodeElement, RefSite, SymbolElement } from './contract';

function wsPath(value: string): WorkspacePath {
  if (!isWorkspacePath(value)) throw new Error(`not a workspace path: ${value}`);
  return value;
}

const PATH = wsPath('main.py');
const REV = '9f'.repeat(32);
const MOD = 'file:main.py:MODULE:$root';
const FN = 'file:main.py:METHOD:greet';
const FQN = '`main.py`/';
const RANGE = { startRow: 0, startColumn: 0, endRow: 2, endColumn: 0 };

const node = (over: Partial<NodeElement> = {}): NodeElement => ({
  label: 'MODULE',
  id: MOD,
  file: PATH,
  revision_id: REV,
  tier: 'structural',
  range: RANGE,
  properties: { name: 'main', status: 'ready' },
  ...over,
});
const method = (over: Partial<NodeElement> = {}): NodeElement =>
  node({ label: 'METHOD', id: FN, properties: { name: 'greet' }, ...over });
const symbol = (over: Partial<SymbolElement> = {}): SymbolElement => ({
  fqn: FQN,
  origin: 'local',
  language: 'python',
  properties: { kind: 'module' },
  ...over,
});
const byId = (key: string, label: NodeElement['label'] = 'MODULE'): EndpointRef => ({
  by: 'id',
  label,
  key,
});
const byFqn = (key: string): EndpointRef => ({ by: 'fqn', label: 'SYMBOL', key });
const edge = (over: Partial<EdgeElement> = {}): EdgeElement => ({
  type: 'DEFINES',
  from: byId(MOD),
  to: byFqn(FQN),
  properties: {},
  ...over,
});
const site = (over: Partial<RefSite> = {}): RefSite => ({
  id: 'site:0',
  nodeId: FN,
  filePath: PATH,
  kind: 'call',
  position: { row: 0, column: 4 },
  nameParts: ['greet'],
  ...over,
});

interface Parts {
  readonly nodes?: readonly NodeElement[];
  readonly symbols?: readonly SymbolElement[];
  readonly edges?: readonly EdgeElement[];
  readonly refSites?: readonly RefSite[];
}

/** A valid file (MODULE, its SYMBOL, DEFINES) plus `extra`, built on a fresh builder. */
function buildWith(extra: Parts) {
  const builder = new ElementBuilder(PATH, REV);
  for (const n of [node(), ...(extra.nodes ?? [])]) builder.addNode(n);
  for (const s of [symbol(), ...(extra.symbols ?? [])]) builder.addSymbol(s);
  for (const e of [edge(), ...(extra.edges ?? [])]) builder.addEdge(e);
  for (const r of extra.refSites ?? []) builder.addRefSite(r);
  return builder.build();
}

/** The invariant `run` broke, `none`, or `other: <error>` for anything that is not the builder's error. */
function brokenBy(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (!(error instanceof ExtractInvariantError)) return `other: ${String(error)}`;
    return error.message.startsWith(`C-EXTRACT ${error.invariant}: `)
      ? error.invariant
      : `bad message: ${error.message}`;
  }
  return 'none';
}

const NUL = '\u0000';
const forgedLabel = (label: string): NodeElement => Object.assign(method(), { label });

describe('ElementBuilder', () => {
  it('returns each array in the order its elements were added', () => {
    const builder = new ElementBuilder(PATH, REV);
    const second = symbol({ fqn: '`main.py`/greet().', properties: { kind: 'function' } });
    builder.addRefSite(site({ id: 'b' }));
    builder.addEdge(edge({ type: 'DEFINES', from: byId(FN, 'METHOD'), to: byFqn(second.fqn) }));
    builder.addNode(method());
    builder.addSymbol(second);
    builder.addEdge(edge());
    builder.addNode(node());
    builder.addSymbol(symbol());
    builder.addRefSite(site({ id: 'a' }));
    const built = builder.build();
    expect(built.nodes.map((n) => n.id)).toEqual([FN, MOD]);
    expect(built.symbols.map((s) => s.fqn)).toEqual([second.fqn, FQN]);
    expect(built.edges.map((e) => e.from.key)).toEqual([FN, MOD]);
    expect(built.refSites.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('keeps a SYMBOL added again with deep-equal fields once, at its first position', () => {
    const tagged = (): SymbolElement =>
      symbol({ fqn: '`main.py`/x.', properties: { t: ['a', 'b'] } });
    const built = buildWith({ symbols: [tagged(), symbol(), tagged()] });
    expect(built.symbols.map((s) => s.fqn)).toEqual([FQN, '`main.py`/x.']);
  });

  it('accepts an edge whose endpoints are added after it, and an empty revision_id', () => {
    const builder = new ElementBuilder(PATH, '');
    builder.addEdge(edge());
    builder.addNode(node({ revision_id: '' }));
    builder.addSymbol(symbol());
    expect(builder.build().edges).toHaveLength(1);
  });

  it('takes the file id from makeNodeId: a colon in the path is escaped', () => {
    const path = wsPath('a:b.py');
    const escaped = 'file:a%3Ab.py:MODULE:$root';
    const make = (id: string) => () => {
      const builder = new ElementBuilder(path, REV);
      builder.addNode(node({ file: path, id }));
      builder.addSymbol(symbol({ fqn: '`a:b.py`/' }));
      builder.addEdge(edge({ from: byId(id), to: byFqn('`a:b.py`/') }));
      return builder.build();
    };
    expect(brokenBy(make(escaped))).toBe('none');
    expect(brokenBy(make('file:a:b.py:MODULE:$root'))).toBe('I6');
  });

  it('builds the valid baseline file', () => {
    expect(brokenBy(() => buildWith({}))).toBe('none');
  });
});

describe('ElementBuilder: each rule fails as its own invariant', () => {
  const fn = method();
  const fnSym = symbol({ fqn: '`main.py`/greet().' });
  const fnDefines = edge({ from: byId(FN, 'METHOD'), to: byFqn(fnSym.fqn) });
  const rows: readonly (readonly [string, Parts, string])[] = [
    ['I5: a node of another file', { nodes: [method({ file: wsPath('other.py') })] }, 'I5'],
    ['I6: an id of another file', { nodes: [method({ id: 'file:other.py:METHOD:greet' })] }, 'I6'],
    [
      'I6: an id whose path only starts like it',
      { nodes: [method({ id: 'file:main.pyc:X:y' })] },
      'I6',
    ],
    ['I6: an id not in makeNodeId form', { nodes: [method({ id: 'main.py:METHOD:greet' })] }, 'I6'],
    ['I6: an id holding the revision_id', { nodes: [method({ id: `${FN}${REV}` })] }, 'I6'],
    ['I7: two nodes with one id', { nodes: [method(), method()] }, 'I7'],
    ['I7: one fqn, other fields', { symbols: [symbol({ language: 'typescript' })] }, 'I7'],
    ['I7: one fqn, other properties', { symbols: [symbol({ properties: { kind: 'x' } })] }, 'I7'],
    ['I7: one fqn, other origin (r2)', { symbols: [symbol({ origin: 'external' })] }, 'I7'],
    ['I8: a FILE in nodes', { nodes: [forgedLabel('FILE')] }, 'I8'],
    ['I8: a SYMBOL in nodes', { nodes: [forgedLabel('SYMBOL')] }, 'I8'],
    ['I8: a DIRECTORY in nodes', { nodes: [forgedLabel('DIRECTORY')] }, 'I8'],
    ['I8: a COMMUNITY in nodes (r2)', { nodes: [forgedLabel('COMMUNITY')] }, 'I8'],
    ['I8: a TAG in nodes (r2)', { nodes: [forgedLabel('TAG')] }, 'I8'],
    ['I8: a META_DATA in nodes (r2)', { nodes: [forgedLabel('META_DATA')] }, 'I8'],
    ['I9: an edge to no node', { edges: [edge({ to: byId(FN, 'METHOD') })] }, 'I9'],
    ['I9: an edge from no node', { edges: [edge({ from: byId(FN, 'METHOD') })] }, 'I9'],
    ['I9: a node under another label', { nodes: [fn], edges: [edge({ from: byId(FN) })] }, 'I9'],
    ['I9: an fqn no SYMBOL has', { edges: [edge({ to: byFqn('`main.py`/nope().') })] }, 'I9'],
    ['I10: an endpoint of another file', { edges: [edge({ to: byId('file:o.py:M:x') })] }, 'I10'],
    [
      'I10: a source of another file (r2)',
      { edges: [edge({ from: byId('file:o.py:M:x') })] },
      'I10',
    ],
    [
      'I10: a path that only starts like it (r2)',
      { edges: [edge({ to: byId('file:main.pyc:M:x') })] },
      'I10',
    ],
    ['I19: NUL in a property', { nodes: [method({ properties: { name: `a${NUL}` } })] }, 'I19'],
    ['I19: NUL in a property key', { nodes: [method({ properties: { [`k${NUL}`]: 1 } })] }, 'I19'],
    ['I19: NUL in a list item', { nodes: [method({ properties: { t: ['a', NUL] } })] }, 'I19'],
    ['I19: NUL in a revision_id', { nodes: [method({ revision_id: NUL })] }, 'I19'],
    ['I19: NUL in a symbol', { symbols: [symbol({ fqn: '`main.py`/n.', language: NUL })] }, 'I19'],
    ['I19: NUL in an edge property', { edges: [edge({ properties: { why: NUL } })] }, 'I19'],
    ['I19: NUL in a site name', { refSites: [site({ nameParts: ['g', `x${NUL}`] })] }, 'I19'],
    ['I19: NUL in a site binding', { refSites: [site({ importBinding: binding(NUL) })] }, 'I19'],
    ['I19: NUL in a node id (r2)', { nodes: [method({ id: `${FN}${NUL}` })] }, 'I19'],
    [
      'I19: NUL in an unused fqn (r2)',
      { symbols: [symbol({ fqn: `\`main.py\`/n${NUL}.` })] },
      'I19',
    ],
    [
      'I19: NUL in a symbol property (r2)',
      { symbols: [symbol({ fqn: 'x', properties: { k: NUL } })] },
      'I19',
    ],
    ['I19: NUL in a site id (r2)', { refSites: [site({ id: `s${NUL}` })] }, 'I19'],
    ['I19: NUL in a site node id (r2)', { refSites: [site({ nodeId: `${FN}${NUL}` })] }, 'I19'],
    [
      'I19: NUL in a binding module (r2)',
      { refSites: [site({ importBinding: { ...binding('j'), module: NUL } })] },
      'I19',
    ],
  ];

  it('the extra method, its SYMBOL and DEFINES are valid on their own', () => {
    expect(brokenBy(() => buildWith({ nodes: [fn], symbols: [fnSym], edges: [fnDefines] }))).toBe(
      'none',
    );
  });

  it.each(rows)('%s', (_name, parts, want) => {
    expect(brokenBy(() => buildWith(parts))).toBe(want);
  });
});

function binding(local: string): NonNullable<RefSite['importBinding']> {
  return { module: 'os.path', relativeDepth: 0, imported: 'join', local };
}
