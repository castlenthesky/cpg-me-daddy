import type { EdgeElement, RefSite } from '@cpg/extract';
import { validateRowDelta } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import { wsPath } from '../test/chain-contract';
import { declares, defines, extracted, node, seal } from '../test/files';
import { FixtureResolver } from '../test/fixture-resolver';
import { applyResolutions } from './apply';
import { ChainResolver } from './chain';
import type { Resolution, ResolveBatch, ResolveReport, Resolver } from './contract';
import { createDefinitionLookup } from './lookup';
import { NullResolver } from './null';

// ── Rung 06 (fixtures/ladder/06-import): main.py imports helper from util.py and calls it. ──

const MAIN = wsPath('main.py');
const UTIL = wsPath('util.py');
const HELPER = '`util.py`/helper().';
const IMPORT_ID = 'file:main.py:IMPORT:$root:0';
const CALL_ID = 'file:main.py:CALL:main:0';

const importSite: RefSite = {
  id: `${IMPORT_ID}#0`,
  nodeId: IMPORT_ID,
  filePath: MAIN,
  kind: 'import',
  position: { row: 0, column: 17 },
  nameParts: ['helper'],
  importBinding: { module: 'util', relativeDepth: 0, imported: 'helper', local: 'helper' },
};
const callSite: RefSite = {
  id: CALL_ID,
  nodeId: CALL_ID,
  filePath: MAIN,
  kind: 'call',
  position: { row: 4, column: 4 },
  nameParts: ['helper'],
};

const main = extracted(MAIN, {
  nodes: [
    node('MODULE', 'file:main.py:MODULE:$root', MAIN, [0, 0, 5, 0], { name: 'main' }),
    node('IMPORT', IMPORT_ID, MAIN, [0, 0, 0, 23], {
      source_text: 'util',
      imported_names: ['helper'],
    }),
    node('METHOD', 'file:main.py:METHOD:main', MAIN, [3, 0, 4, 12], { name: 'main' }, [3, 4, 3, 8]),
    node('CALL', CALL_ID, MAIN, [4, 4, 4, 12], { callee_name: 'helper', args_count: 0 }),
  ],
  symbols: ['`main.py`/', '`main.py`/main().'],
  edges: [
    defines('MODULE', 'file:main.py:MODULE:$root', '`main.py`/'),
    declares('MODULE', 'file:main.py:MODULE:$root', 'IMPORT', IMPORT_ID),
    declares('MODULE', 'file:main.py:MODULE:$root', 'METHOD', 'file:main.py:METHOD:main'),
    defines('METHOD', 'file:main.py:METHOD:main', '`main.py`/main().'),
  ],
  refSites: [importSite, callSite],
});
const util = extracted(UTIL, {
  nodes: [
    node('MODULE', 'file:util.py:MODULE:$root', UTIL, [0, 0, 2, 0], { name: 'util' }),
    node(
      'METHOD',
      'file:util.py:METHOD:helper',
      UTIL,
      [0, 0, 1, 8],
      { name: 'helper' },
      [0, 4, 0, 10],
    ),
  ],
  symbols: ['`util.py`/', HELPER],
  edges: [
    defines('MODULE', 'file:util.py:MODULE:$root', '`util.py`/'),
    declares('MODULE', 'file:util.py:MODULE:$root', 'METHOD', 'file:util.py:METHOD:helper'),
    defines('METHOD', 'file:util.py:METHOD:helper', HELPER),
  ],
});
const RUNG_06 = seal(main, util);

const AT_HELPER = { filePath: UTIL, position: { row: 0, column: 4 } };

async function resolveMain(links: readonly Resolver[]) {
  const chain = new ChainResolver(links);
  await chain.open({ rootPath: '/ws', definitions: createDefinitionLookup(RUNG_06) });
  const batch = await chain.resolve(MAIN, RUNG_06.files.get(MAIN)?.refSites ?? []);
  return applyResolutions(RUNG_06, [batch]);
}

const ZERO_KINDS = { call: 0, import: 0, receiver: 0, 'receiver-type': 0 };
const EMPTY_KINDS = { call: {}, import: {}, receiver: {}, 'receiver-type': {} };

describe('applyResolutions: rung 06 through chain(fixture > null)', () => {
  it('writes the rung [resolution] lines: CALLS and IMPORTS to util.py SYMBOL', async () => {
    const fixture = new FixtureResolver([
      {
        kind: 'import',
        from: MAIN,
        row: 0,
        column: 17,
        answer: { status: 'resolved', definition: AT_HELPER, confidence: 1 },
      },
      {
        kind: 'call',
        from: MAIN,
        row: 4,
        column: 4,
        answer: { status: 'resolved', definition: AT_HELPER, confidence: 1 },
      },
    ]);
    const { edges, report } = await resolveMain([fixture, new NullResolver()]);
    expect(edges).toStrictEqual([
      {
        type: 'CALLS',
        from: { by: 'id', label: 'CALL', key: CALL_ID },
        to: { by: 'fqn', label: 'SYMBOL', key: HELPER },
        properties: { status: 'resolved', confidence: 1, resolvedBy: 'fixture' },
      },
      {
        type: 'IMPORTS',
        from: { by: 'id', label: 'IMPORT', key: IMPORT_ID },
        to: { by: 'fqn', label: 'SYMBOL', key: HELPER },
        properties: { status: 'resolved' },
      },
    ]);
    expect(fixture.unmatched()).toEqual([]);
    expect(report).toStrictEqual({
      siteCount: { ...ZERO_KINDS, call: 1, import: 1 },
      statusCount: { ...EMPTY_KINDS, call: { resolved: 1 }, import: { resolved: 1 } },
      reasonCount: {},
      byResolver: { fixture: 2 },
      unresolvedRate: { call: 0, import: 0 },
      degradedBatches: 0,
      backendRestarts: 0,
      edgeCount: 2,
      droppedNoSymbol: 0,
    });
  });

  it('the null control: no edge, every site unresolved no-resolver, counted', async () => {
    const { edges, report } = await resolveMain([new NullResolver()]);
    expect(edges).toEqual([]);
    expect(report).toStrictEqual({
      siteCount: { ...ZERO_KINDS, call: 1, import: 1 },
      statusCount: { ...EMPTY_KINDS, call: { unresolved: 1 }, import: { unresolved: 1 } },
      reasonCount: { 'no-resolver': 2 },
      byResolver: { null: 2 },
      unresolvedRate: { call: 1, import: 1 },
      degradedBatches: 0,
      backendRestarts: 0,
      edgeCount: 0,
      droppedNoSymbol: 0,
    });
  });
});

// ── A synthetic workspace: a.py defines f and holds the print builtin; b.py's sites are answered
// by hand-written batches; c.py has a site and no batch. ──

const A_PY = wsPath('a.py');
const B_PY = wsPath('b.py');
const C_PY = wsPath('c.py');
const F = '`a.py`/f().';
const PRINT = 'site:python-stdlib`print().';
const GHOST = '`a.py`/ghost().';
/** g DEFINES this fqn, but no symbols channel holds it. */
const UNLISTED = '`a.py`/g().';

const a = extracted(A_PY, {
  nodes: [
    node('MODULE', 'file:a.py:MODULE:$root', A_PY, [0, 0, 6, 0], { name: 'a' }),
    node('METHOD', 'file:a.py:METHOD:f', A_PY, [0, 0, 2, 8], { name: 'f' }, [0, 4, 0, 5]),
    node('METHOD', 'file:a.py:METHOD:g', A_PY, [3, 0, 4, 8], { name: 'g' }, [3, 4, 3, 5]),
  ],
  symbols: ['`a.py`/', F],
  builtins: [PRINT],
  edges: [
    defines('MODULE', 'file:a.py:MODULE:$root', '`a.py`/'),
    declares('MODULE', 'file:a.py:MODULE:$root', 'METHOD', 'file:a.py:METHOD:f'),
    defines('METHOD', 'file:a.py:METHOD:f', F),
    declares('MODULE', 'file:a.py:MODULE:$root', 'METHOD', 'file:a.py:METHOD:g'),
    defines('METHOD', 'file:a.py:METHOD:g', UNLISTED),
  ],
});

const callId = (n: number) => `file:b.py:CALL:$root:${String(n)}`;
const importId = (n: number) => `file:b.py:IMPORT:$root:${String(n)}`;

function call(n: number): RefSite {
  const id = callId(n);
  return {
    id,
    nodeId: id,
    filePath: B_PY,
    kind: 'call',
    position: { row: n, column: 0 },
    nameParts: ['f'],
  };
}
function receiver(
  n: number,
  kind: 'receiver' | 'receiver-type',
  declined?: 'receiver-unknown',
): RefSite {
  const suffix = kind === 'receiver' ? 'recv' : 'type';
  return {
    id: `${callId(n)}#${suffix}`,
    nodeId: callId(n),
    filePath: B_PY,
    kind,
    position: { row: n, column: 0 },
    nameParts: ['g'],
    ...(declined === undefined ? {} : { declined }),
  };
}
function binding(n: number, k: number): RefSite {
  return {
    id: `${importId(n)}#${String(k)}`,
    nodeId: importId(n),
    filePath: B_PY,
    kind: 'import',
    position: { row: 20 + n, column: 7 + k },
    nameParts: ['f'],
    importBinding: { module: 'a', relativeDepth: 0, imported: 'f', local: 'f' },
  };
}

const C_SITE: RefSite = {
  ...call(0),
  id: 'file:c.py:CALL:$root:0',
  nodeId: 'file:c.py:CALL:$root:0',
  filePath: C_PY,
};

const b = extracted(B_PY, {
  refSites: [
    call(1),
    receiver(1, 'receiver'),
    receiver(1, 'receiver-type'),
    receiver(10, 'receiver', 'receiver-unknown'),
    call(11),
    call(12),
    ...[2, 3, 4, 5, 6, 7, 8, 9].map(call),
    binding(0, 0),
    binding(0, 1),
    binding(0, 2),
    binding(1, 0),
  ],
});
const c = extracted(C_PY, { refSites: [C_SITE] });
const SET = seal(a, b, c);

const at = (row: number, column: number) => ({ filePath: A_PY, position: { row, column } });
const outside = { filePath: wsPath('site-packages/x.py'), position: { row: 0, column: 0 } };

function r(
  refId: string,
  resolvedBy: string,
  rest: Omit<Resolution, 'refId' | 'resolvedBy'>,
): Resolution {
  return { refId, resolvedBy, ...rest };
}

function batchOf(
  path: string,
  resolutions: readonly Resolution[],
  degraded: boolean,
): ResolveBatch {
  return {
    resolutions,
    diagnostics: {
      resolverId: 'test',
      filePath: wsPath(path),
      siteCount: resolutions.length,
      backend: degraded ? 'degraded' : 'ready',
      degraded,
      elapsedMs: 1,
      timedOutSites: 0,
    },
  };
}

const BATCHES: readonly ResolveBatch[] = [
  batchOf(
    'b.py',
    [
      r(callId(1), 'r1', { status: 'resolved', definition: at(0, 4), confidence: 0.9 }),
      r(`${callId(1)}#recv`, 'r2', { status: 'resolved', definition: at(0, 4), confidence: 1 }),
      r(`${callId(1)}#type`, 'r2', { status: 'resolved', target: { fqn: F }, confidence: 1 }),
      r(callId(2), 'r1', { status: 'ambiguous', definition: at(1, 2), confidence: 0.5 }),
      r(callId(3), 'r1', {
        status: 'resolved',
        target: { fqn: F },
        definition: at(5, 0),
        confidence: 0.8,
      }),
      r(callId(4), 'r1', {
        status: 'resolved',
        target: { fqn: GHOST },
        definition: at(0, 4),
        confidence: 1,
      }),
      r(callId(5), 'r2', {
        status: 'external',
        target: { fqn: PRINT },
        reason: 'builtin',
        confidence: 1,
      }),
      r(callId(6), 'r2', { status: 'external', reason: 'builtin', confidence: 1 }),
      r(callId(7), 'r1', { status: 'resolved', definition: outside, confidence: 1 }),
      r(callId(8), 'r1', { status: 'resolved', definition: at(0, 4), confidence: 1 }),
      r(callId(9), 'r2', { status: 'dynamic', target: { fqn: F }, confidence: 0 }),
      r(callId(12), 'r1', { status: 'resolved', definition: at(3, 4), confidence: 1 }),
      r(`${importId(0)}#0`, 'r1', { status: 'ambiguous', definition: at(1, 2), confidence: 0.5 }),
      r(`${importId(0)}#1`, 'r3', { status: 'resolved', definition: at(0, 4), confidence: 1 }),
      r(`${importId(0)}#2`, 'r2', {
        status: 'external',
        target: { fqn: PRINT },
        reason: 'builtin',
        confidence: 1,
      }),
      r(`${importId(1)}#0`, 'r2', {
        status: 'external',
        target: { fqn: PRINT },
        reason: 'builtin',
        confidence: 1,
      }),
      r('nope', 'r1', { status: 'resolved', target: { fqn: F }, confidence: 1 }),
      r(C_SITE.id, 'r1', { status: 'resolved', target: { fqn: F }, confidence: 1 }),
    ],
    true,
  ),
  batchOf(
    'b.py',
    [r(callId(8), 'r2', { status: 'unresolved', reason: 'no-definition', confidence: 0 })],
    false,
  ),
  batchOf('a.py', [], true),
];

const callsEdge = (n: number, to: string, properties: EdgeElement['properties']): EdgeElement => ({
  type: 'CALLS',
  from: { by: 'id', label: 'CALL', key: callId(n) },
  to: { by: 'fqn', label: 'SYMBOL', key: to },
  properties,
});
const importsEdge = (n: number, to: string, status: string): EdgeElement => ({
  type: 'IMPORTS',
  from: { by: 'id', label: 'IMPORT', key: importId(n) },
  to: { by: 'fqn', label: 'SYMBOL', key: to },
  properties: { status },
});

const EXPECTED_EDGES: readonly EdgeElement[] = [
  callsEdge(1, F, { status: 'resolved', confidence: 0.9, resolvedBy: 'r1' }),
  callsEdge(2, F, { status: 'ambiguous', confidence: 0.5, resolvedBy: 'r1' }),
  callsEdge(3, F, { status: 'resolved', confidence: 0.8, resolvedBy: 'r1' }),
  callsEdge(5, PRINT, { status: 'external', reason: 'builtin', confidence: 1, resolvedBy: 'r2' }),
  importsEdge(0, F, 'ambiguous'),
  importsEdge(0, PRINT, 'external'),
  importsEdge(1, PRINT, 'external'),
];

const EXPECTED_REPORT: ResolveReport = {
  siteCount: { call: 11, import: 4, receiver: 2, 'receiver-type': 1 },
  statusCount: {
    call: { resolved: 5, ambiguous: 1, external: 2, unresolved: 2, dynamic: 1 },
    import: { ambiguous: 1, resolved: 1, external: 2 },
    receiver: { resolved: 1, unresolved: 1 },
    'receiver-type': { resolved: 1 },
  },
  reasonCount: { builtin: 4, 'no-definition': 1, 'receiver-unknown': 1, 'no-resolver': 1 },
  byResolver: { r1: 7, r2: 8, r3: 1 },
  unresolvedRate: { call: 2 / 11, import: 0, receiver: 0.5, 'receiver-type': 0 },
  degradedBatches: 2,
  backendRestarts: 0,
  edgeCount: 7,
  droppedNoSymbol: 6,
};

const applied = () => applyResolutions(SET, BATCHES);

describe('applyResolutions: edges', () => {
  it('CALLS carry status, reason, confidence, resolvedBy; IMPORTS status alone; set order; one per (type, from, to)', () => {
    expect(applied().edges).toStrictEqual(EXPECTED_EDGES);
  });

  it('every edge passes the model schema (CALL/IMPORT -> SYMBOL, declared properties only)', () => {
    const rows = applied().edges.map((e) => ({
      type: e.type,
      fromLabel: e.from.label,
      toLabel: e.to.label,
      properties: { ...e.properties },
    }));
    expect(rows).toHaveLength(EXPECTED_EDGES.length);
    expect(validateRowDelta({ nodes: [], edges: rows })).toEqual({ ok: true, problems: [] });
  });

  it('INV-13: the target wins over the definition, and an fqn the set lacks yields no edge', () => {
    const { edges } = applied();
    const from = (n: number) => edges.filter((e) => e.from.key === callId(n)).map((e) => e.to.key);
    expect([from(3), from(4)]).toEqual([[F], []]);
    expect(edges.some((e) => e.to.key === GHOST)).toBe(false);
  });

  it('INV-13: a definition whose definer fqn no symbols channel holds yields no edge', () => {
    const { edges } = applied();
    expect(edges.some((e) => e.from.key === callId(12) || e.to.key === UNLISTED)).toBe(false);
  });

  it('an open answer (rank <= 1) yields no edge even when it names a symbol', () => {
    expect(applied().edges.some((e) => e.from.key === callId(9))).toBe(false);
  });

  it('IMPORTS: one IMPORT reaches two targets; of two sites on one edge the first keeps it', () => {
    const fromImport0 = applied().edges.filter((e) => e.from.key === importId(0));
    expect(fromImport0).toStrictEqual([
      importsEdge(0, F, 'ambiguous'),
      importsEdge(0, PRINT, 'external'),
    ]);
  });

  it('edges follow the set order across files, not the batch order', () => {
    const { edges } = applyResolutions(SET, [
      batchOf(
        'c.py',
        [r(C_SITE.id, 'r1', { status: 'resolved', target: { fqn: F }, confidence: 1 })],
        false,
      ),
      batchOf(
        'b.py',
        [r(callId(1), 'r2', { status: 'resolved', target: { fqn: F }, confidence: 1 })],
        false,
      ),
    ]);
    expect(edges.map((e) => e.from.key)).toEqual([callId(1), C_SITE.nodeId]);
  });

  it('a batch answers only its own file: a stray answer for another file site is dropped there too', () => {
    const { edges, report } = applyResolutions(SET, [
      batchOf(
        'b.py',
        [r(C_SITE.id, 'r1', { status: 'resolved', target: { fqn: F }, confidence: 1 })],
        false,
      ),
      batchOf('c.py', [], false),
    ]);
    expect(edges).toEqual([]);
    expect(report.byResolver).toStrictEqual({});
    expect(report.statusCount.call).toStrictEqual({ unresolved: 12 });
    expect(report.reasonCount).toStrictEqual({ 'no-resolver': 18, 'receiver-unknown': 1 });
  });

  it('a receiver answer yields no edge and leaves its call edge as the call answer said', () => {
    const { edges } = applied();
    expect(edges.filter((e) => e.from.key === callId(1))).toStrictEqual([EXPECTED_EDGES[0]]);
  });

  it('the later batch answer for a site counts; answers for sites outside the batch file are ignored', () => {
    const { edges } = applied();
    expect(edges.some((e) => e.from.key === callId(8))).toBe(false);
    expect(edges.some((e) => e.from.key === C_SITE.nodeId)).toBe(false);
  });
});

describe('applyResolutions: report', () => {
  it('counts every site of the batched files by kind, status, reason and resolver', () => {
    expect(applied().report).toStrictEqual(EXPECTED_REPORT);
  });

  it('INV-21: unresolvedRate per kind over that kind own sites', () => {
    expect(applied().report.unresolvedRate).toStrictEqual({
      call: 2 / 11,
      import: 0,
      receiver: 0.5,
      'receiver-type': 0,
    });
  });

  it('INV-25: degradedBatches counts each degraded batch, one with no sites included', () => {
    expect(applied().report.degradedBatches).toBe(2);
  });

  it('INV-25: the degraded flag counts, not the backend state', () => {
    const flagged = {
      ...batchOf('b.py', [], true),
      diagnostics: { ...batchOf('b.py', [], true).diagnostics, backend: 'warming' as const },
    };
    const unflagged = {
      ...batchOf('a.py', [], false),
      diagnostics: { ...batchOf('a.py', [], false).diagnostics, backend: 'degraded' as const },
    };
    // Two flagged on a warming backend, one unflagged on a degraded one: 2, where the state gives 1.
    const batches = [flagged, unflagged, flagged];
    expect(applyResolutions(SET, batches).report.degradedBatches).toBe(2);
  });

  it('INV-26: answered-but-edgeless is droppedNoSymbol, keeps its status, never counts as unresolved', () => {
    const { report } = applied();
    expect(report.droppedNoSymbol).toBe(6);
    expect(report.statusCount.call).toStrictEqual(EXPECTED_REPORT.statusCount.call);
    expect(report.unresolvedRate.call).toBe(2 / 11);
  });

  it('a file with no batch is not counted, and a kind with no sites has no rate', () => {
    const only = applyResolutions(SET, [
      batchOf(
        'c.py',
        [r(C_SITE.id, 'r1', { status: 'unresolved', reason: 'module-not-found', confidence: 0 })],
        false,
      ),
    ]);
    expect(only.edges).toEqual([]);
    expect(only.report).toStrictEqual({
      siteCount: { ...ZERO_KINDS, call: 1 },
      statusCount: { ...EMPTY_KINDS, call: { unresolved: 1 } },
      reasonCount: { 'module-not-found': 1 },
      byResolver: { r1: 1 },
      unresolvedRate: { call: 1 },
      degradedBatches: 0,
      backendRestarts: 0,
      edgeCount: 0,
      droppedNoSymbol: 0,
    });
  });

  it('no batches: no edges and an empty report', () => {
    expect(applyResolutions(SET, [])).toStrictEqual({
      edges: [],
      report: {
        siteCount: ZERO_KINDS,
        statusCount: EMPTY_KINDS,
        reasonCount: {},
        byResolver: {},
        unresolvedRate: {},
        degradedBatches: 0,
        backendRestarts: 0,
        edgeCount: 0,
        droppedNoSymbol: 0,
      },
    });
  });
});
