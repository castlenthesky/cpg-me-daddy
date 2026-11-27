// MemoryStore's code-tier writes, replace-file and delete-file, from C-STORE INV-3, INV-8, INV-10..14,
// INV-20, DQ-01, C-MODEL I-15 and controller decisions 97, 98 and 104 (the readings are named in
// file-writes.ts). Rows are written by hand the way toWriteOp writes them.

import type { EdgeType, GraphEdge, GraphNode, NodeLabel, WorkspacePath } from '@cpg/model';
import { isWorkspacePath } from '@cpg/model';
import type { EdgeRow, NodeRow, Properties, WriteOp } from '@cpg/store';
import { storeErrorCode, toWriteOp } from '@cpg/store';
import { describe, expect, it } from 'vitest';
import { makeDelta } from './delta';
import type { MemoryStore } from './memory-store';
import { createMemoryStore } from './memory-store';

function wp(s: string): WorkspacePath {
  if (!isWorkspacePath(s)) throw new Error(`not a WorkspacePath: ${s}`);
  return s;
}
const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const REV_A = 'a1'.repeat(32);
const REV_A2 = 'a2'.repeat(32);
const REV_B = 'b1'.repeat(32);
const RANGE = '1:0-3:0';

// ── the filesystem tier ──
const dirRow = (path: string): NodeRow => ({
  label: 'DIRECTORY',
  key: path,
  properties: { path, name: base(path), status: 'ready' },
});
const fsFile = (path: string, rev: string): NodeRow => ({
  label: 'FILE',
  key: path,
  properties: { path, name: base(path), language: 'python', content_hash: rev, revision_id: rev },
});
const fsLink = (from: string, toLabel: NodeLabel, to: string): EdgeRow => ({
  type: 'HAS_ENTRY',
  fromLabel: 'DIRECTORY',
  fromKey: from,
  toLabel,
  toKey: to,
  properties: {},
});
const mergeFiles = (files: readonly NodeRow[], removals: readonly string[] = []): WriteOp => ({
  kind: 'merge-filesystem',
  directories: [],
  files,
  links: [],
  moves: [],
  removals: removals.map(wp),
});
const TREE: WriteOp = {
  kind: 'merge-filesystem',
  directories: [dirRow('.'), dirRow('pkg')],
  files: [fsFile('a.py', REV_A), fsFile('pkg/b.py', REV_B)],
  links: [
    fsLink('.', 'DIRECTORY', 'pkg'),
    fsLink('.', 'FILE', 'a.py'),
    fsLink('pkg', 'FILE', 'pkg/b.py'),
  ],
  moves: [],
  removals: [],
};

// ── the code tier ──
const code = (label: NodeLabel, id: string, file: string, rev: string, name: string): NodeRow => ({
  label,
  key: id,
  properties: { name, file, revision_id: rev, range: RANGE },
});
const sym = (fqn: string, kind: string): NodeRow => ({
  label: 'SYMBOL',
  key: fqn,
  properties: { fqn, language: 'python', kind },
});
const codeHalf = (path: string, properties: Properties): NodeRow => ({
  label: 'FILE',
  key: path,
  properties,
});
const e = (
  type: EdgeType,
  [fromLabel, fromKey]: readonly [NodeLabel, string],
  [toLabel, toKey]: readonly [NodeLabel, string],
  properties: Properties = {},
): EdgeRow => ({ type, fromLabel, fromKey, toLabel, toKey, properties });
type ReplaceOp = Extract<WriteOp, { kind: 'replace-file' }>;
const replace = (
  file: string,
  seq: number,
  rev: string,
  nodes: readonly NodeRow[],
  edges: readonly EdgeRow[] = [],
): ReplaceOp => ({ kind: 'replace-file', file: wp(file), seq, revision_id: rev, nodes, edges });
const del = (file: string, seq: number): WriteOp => ({ kind: 'delete-file', file: wp(file), seq });

const A_MOD = 'file:a.py:MODULE:$root';
const A_F = 'file:a.py:METHOD:f';
const A_G = 'file:a.py:METHOD:g';
const S_A = '`a.py`/';
const S_F = '`a.py`/f().';
const S_G = '`a.py`/g().';
const B_MOD = 'file:pkg/b.py:MODULE:$root';
const B_CALL = 'file:pkg/b.py:CALL:$root:0';
const S_B = '`pkg/b.py`/';
const S_H = '`pkg/b.py`/h().';
const MOD = (key: string): readonly [NodeLabel, string] => ['MODULE', key];
const METHOD = (key: string): readonly [NodeLabel, string] => ['METHOD', key];
const SYM = (key: string): readonly [NodeLabel, string] => ['SYMBOL', key];
const FILE = (key: string): readonly [NodeLabel, string] => ['FILE', key];
const CALL = (key: string): readonly [NodeLabel, string] => ['CALL', key];

const aCode = (rev: string): NodeRow[] => [
  code('MODULE', A_MOD, 'a.py', rev, 'a'),
  code('METHOD', A_F, 'a.py', rev, 'f'),
  sym(S_A, 'module'),
  sym(S_F, 'function'),
];
const A_FILE_ROW = codeHalf('a.py', { interface_hash: 'i1', loc: 3 });
const aRows = (rev: string): NodeRow[] => [...aCode(rev), A_FILE_ROW];
const A_DECLARES = e('DECLARES', MOD(A_MOD), METHOD(A_F));
const A_EDGES: readonly EdgeRow[] = [
  A_DECLARES,
  e('DEFINES', MOD(A_MOD), SYM(S_A)),
  e('DEFINES', METHOD(A_F), SYM(S_F)),
  e('SOURCE_FILE', MOD(A_MOD), FILE('a.py')),
];
const writeA = (seq: number, rev = REV_A): WriteOp =>
  replace('a.py', seq, rev, aRows(rev), A_EDGES);
// b.py calls a.py's f through its SYMBOL: the only cross-file shape (L-03).
const writeB = (seq: number): WriteOp =>
  replace(
    'pkg/b.py',
    seq,
    REV_B,
    [
      code('MODULE', B_MOD, 'pkg/b.py', REV_B, 'b'),
      code('CALL', B_CALL, 'pkg/b.py', REV_B, 'f'),
      sym(S_B, 'module'),
      codeHalf('pkg/b.py', { interface_hash: 'i2', loc: 1 }),
    ],
    [
      e('DEFINES', MOD(B_MOD), SYM(S_B)),
      e('IN_SCOPE', CALL(B_CALL), MOD(B_MOD)),
      e('CALLS', CALL(B_CALL), SYM(S_F), { status: 'resolved' }),
      e('SOURCE_FILE', MOD(B_MOD), FILE('pkg/b.py')),
    ],
  );

// ── the rejection table (seeded: a.py and pkg/b.py at seq 1; each op is a.py at seq 2) ──
const W = 'WRITE_SHAPE_VIOLATION';
const O = 'OWNERSHIP_VIOLATION';
const aOp = (nodes: readonly NodeRow[], edges: readonly EdgeRow[] = A_EDGES): WriteOp =>
  replace('a.py', 2, REV_A2, nodes, edges);
// Each identity and FILE value differs from the seeded one, so a merge that touched the graph
// before refusing would show.
const CODE2 = [
  code('MODULE', A_MOD, 'a.py', REV_A2, 'a'),
  code('METHOD', A_F, 'a.py', REV_A2, 'f'),
  sym(S_A, 'namespace'),
  sym(S_F, 'method'),
];
const ROWS2 = [...CODE2, codeHalf('a.py', { interface_hash: 'i9', loc: 30 })];
const NO_F = ROWS2.filter((row) => row.key !== A_F);
const plus = (...more: readonly NodeRow[]): WriteOp => aOp([...ROWS2, ...more]);
const plusEdge = (edge: EdgeRow): WriteOp => aOp(ROWS2, [...A_EDGES, edge]);
const ODD = code('METHOD', 'file:a.py:METHOD:z', 'a.py', REV_A2, 'z');
const oddWith = (over: Partial<NodeRow>): WriteOp => plus({ ...ODD, ...over });
const fileHalf = (properties: Properties): WriteOp => aOp([...CODE2, codeHalf('a.py', properties)]);
/** An op naming a path that is not a WorkspacePath. */
const forged = (op: WriteOp, file: string): WriteOp => Object.assign(structuredClone(op), { file });
/** A row whose label is outside the schema; `Object.assign` keeps the NodeRow type. */
const relabel = (row: NodeRow, label: string): NodeRow =>
  Object.assign(structuredClone(row), { label });
const BOGUS_EDGE: EdgeRow = Object.assign(structuredClone(A_DECLARES), { type: 'BOGUS' });
const alias = (properties: Properties): EdgeRow => e('ALIAS_OF', SYM(S_A), SYM(S_B), properties);

async function opened(): Promise<MemoryStore> {
  const store = createMemoryStore({ now: () => 7 });
  await store.open();
  return store;
}
/** TREE, then a.py at seq 1, then pkg/b.py at seq 1. */
async function seeded(): Promise<MemoryStore> {
  const store = await opened();
  await store.write(TREE);
  await store.write(writeA(1));
  await store.write(writeB(1));
  return store;
}
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (error) {
    return storeErrorCode(error) ?? 'not a StoreError';
  }
}
async function everything(store: MemoryStore): Promise<unknown> {
  return {
    graph: await store.readAll(),
    files: await store.fileStates(),
    audit: store.auditLog(),
  };
}
const order = (a: string, b: string): number => Number(a > b) - Number(a < b);
const byKey = (rows: readonly NodeRow[]): NodeRow[] => rows.toSorted((x, y) => order(x.key, y.key));
const edgeLine = (r: EdgeRow): string => `${r.type} ${r.fromKey} -> ${r.toKey}`;
const edgeLines = (rows: readonly EdgeRow[]): string[] => rows.map(edgeLine).toSorted(order);
const receipt = (nodesWritten: number, edgesWritten: number, nodesDeleted: number) => ({
  nodesWritten,
  edgesWritten,
  nodesDeleted,
  statementCount: 1,
  durationMs: 0,
});
const applied = (nodes: number, edges: number, deleted: number) => ({
  applied: true,
  ...receipt(nodes, edges, deleted),
});
const notApplied = (reason: unknown) => ({
  applied: false,
  notApplied: reason,
  ...receipt(0, 0, 0),
});
const A_FILE_FS = {
  path: 'a.py',
  name: 'a.py',
  language: 'python',
  content_hash: REV_A,
  revision_id: REV_A,
};

describe('MemoryStore replace-file', () => {
  it('writes a file as one statement and reads it back (INV-3, INV-8, INV-15)', async () => {
    const store = await opened();
    await store.write(TREE);
    expect(await store.write(writeA(3))).toEqual(applied(5, 4, 0));
    const { nodes, edges } = await store.readFile(wp('a.py'));
    expect(byKey(nodes)).toEqual([
      {
        label: 'FILE',
        key: 'a.py',
        properties: { ...A_FILE_FS, interface_hash: 'i1', loc: 3, status: 'ready', version: 1 },
      },
      code('METHOD', A_F, 'a.py', REV_A, 'f'),
      code('MODULE', A_MOD, 'a.py', REV_A, 'a'),
    ]);
    expect(edgeLines(edges)).toEqual([
      `DECLARES ${A_MOD} -> ${A_F}`,
      `DEFINES ${A_F} -> ${S_F}`,
      `DEFINES ${A_MOD} -> ${S_A}`,
      `SOURCE_FILE ${A_MOD} -> a.py`,
    ]);
    expect((await store.nodeKeys('SYMBOL')).toSorted(order)).toEqual([S_A, S_F]);
    expect(await store.stats()).toEqual({ nodeCount: 8, edgeCount: 7, beyondMeasuredScale: false });
    expect(await store.fileStates()).toEqual([
      { file: 'a.py', seq: 3, revision_id: REV_A, nodeCount: 2 },
      { file: 'pkg/b.py', seq: -1, revision_id: REV_B, nodeCount: 0 },
    ]);
    expect(store.auditLog()).toEqual([
      { at: 7, scope: { kind: 'file', file: 'a.py' }, nodesDeleted: 0, calledBy: 'replace-file' },
    ]);
    // The GraphSink half's seq is not the write seq (decision 98).
    expect((await store.inspect()).highWaterSeq).toBe(-1);
  });

  it('needs an open store, and times the write on the clock', async () => {
    const closed = createMemoryStore();
    expect([
      await rejection(closed.write(writeA(1))),
      await rejection(closed.write(del('a.py', 1))),
    ]).toEqual(['STORE_NOT_OPEN', 'STORE_NOT_OPEN']);
    let tick = 100;
    const store = createMemoryStore({ now: () => (tick += 5) });
    await store.open();
    await store.write(TREE);
    expect((await store.write(writeA(1))).durationMs).toBeGreaterThan(0);
    expect((await store.write(del('a.py', 2))).durationMs).toBeGreaterThan(0);
  });

  it('replaces the old subgraph; SYMBOLs and the edges into them survive (INV-12, I-15)', async () => {
    const store = await seeded();
    const next = [
      code('MODULE', A_MOD, 'a.py', REV_A2, 'a'),
      code('METHOD', A_G, 'a.py', REV_A2, 'g'),
    ];
    const declares = e('DECLARES', MOD(A_MOD), METHOD(A_G));
    expect(await store.write(replace('a.py', 2, REV_A2, next, [declares]))).toEqual(
      applied(2, 1, 2),
    );
    expect(await store.nodeKeys('METHOD')).toEqual([A_G]);
    expect((await store.nodeKeys('SYMBOL')).toSorted(order)).toEqual(
      [S_A, S_F, S_B].toSorted(order),
    );
    const a = await store.readFile(wp('a.py'));
    expect(edgeLines(a.edges)).toEqual([`DECLARES ${A_MOD} -> ${A_G}`]);
    expect(a.nodes.find((n) => n.label === 'FILE')?.properties['version']).toBe(2);
    // b.py's CALLS into a.py's old SYMBOL is b.py's: it stays.
    expect(edgeLines((await store.readFile(wp('pkg/b.py'))).edges)).toContain(
      `CALLS ${B_CALL} -> ${S_F}`,
    );
    expect(store.auditLog().map((x) => [x.scope, x.nodesDeleted, x.calledBy])).toEqual([
      [{ kind: 'file', file: 'a.py' }, 0, 'replace-file'],
      [{ kind: 'file', file: 'pkg/b.py' }, 0, 'replace-file'],
      [{ kind: 'file', file: 'a.py' }, 2, 'replace-file'],
    ]);
  });

  it("never changes another file's nodes or edges (INV-12)", async () => {
    const store = await seeded();
    const before = await store.readFile(wp('pkg/b.py'));
    await store.write(writeA(5, REV_A2));
    await store.write(del('a.py', 6));
    await store.write(writeA(7));
    expect(await store.readFile(wp('pkg/b.py'))).toEqual(before);
  });

  it('merges identity rows and the FILE code half without nulling a property (INV-11)', async () => {
    const store = await seeded();
    await store.write(
      replace(
        'pkg/b.py',
        2,
        REV_A2,
        [
          code('MODULE', B_MOD, 'pkg/b.py', REV_A2, 'b'),
          {
            label: 'SYMBOL',
            key: S_F,
            properties: { fqn: S_F, kind: null, language: undefined, package: 'p1' },
          },
          { label: 'SYMBOL', key: S_H, properties: { fqn: S_H, kind: null, language: undefined } },
          codeHalf('pkg/b.py', { interface_hash: null, loc: 4 }),
        ],
        [e('DEFINES', MOD(B_MOD), SYM(S_H), { note: null, by: undefined })],
      ),
    );
    const graph = await store.readAll();
    const data = (id: string): unknown => graph.nodes.find((n) => n.id === id)?.data;
    expect([data(S_F), data(S_H)]).toStrictEqual([
      { fqn: S_F, language: 'python', kind: 'function', package: 'p1' },
      { fqn: S_H },
    ]);
    const defines = graph.edges.find((x) => x.target === S_H);
    expect(defines).toStrictEqual({ source: B_MOD, target: S_H, type: 'DEFINES' });
    const b = await store.readFile(wp('pkg/b.py'));
    expect(b.nodes.find((n) => n.label === 'FILE')?.properties).toMatchObject({
      interface_hash: 'i2',
      loc: 4,
    });
  });

  it('keeps the FILE filesystem half; the store owns status and version (DQ-01)', async () => {
    const store = await opened();
    await store.write(TREE);
    await store.write(writeA(1));
    await store.write(
      replace('a.py', 2, REV_A2, [
        ...aCode(REV_A2),
        codeHalf('a.py', { status: 'indexing', version: 9, loc: 8 }),
      ]),
    );
    const fileProps = async (): Promise<unknown> =>
      (await store.readFile(wp('a.py'))).nodes.find((n) => n.label === 'FILE')?.properties;
    const expected = { ...A_FILE_FS, interface_hash: 'i1', loc: 8, status: 'ready', version: 2 };
    expect(await fileProps()).toEqual(expected);
    // The filesystem tier re-merges the FILE: the code half survives it.
    await store.write(mergeFiles([fsFile('a.py', REV_A2)]));
    expect(await fileProps()).toEqual({
      ...expected,
      content_hash: REV_A2,
      revision_id: REV_A2,
    });
  });

  it('starts version at 1 and needs no FILE row', async () => {
    const store = await opened();
    await store.write(TREE);
    const sourceFile = e('SOURCE_FILE', MOD(B_MOD), FILE('pkg/b.py'));
    const op = replace(
      'pkg/b.py',
      0,
      REV_B,
      [code('MODULE', B_MOD, 'pkg/b.py', REV_B, 'b')],
      [sourceFile],
    );
    expect(await store.write(op)).toEqual(applied(1, 1, 0));
    const b = await store.readFile(wp('pkg/b.py'));
    expect(b.nodes.find((n) => n.label === 'FILE')?.properties).toMatchObject({
      status: 'ready',
      version: 1,
    });
    expect(edgeLines(b.edges)).toEqual([`SOURCE_FILE ${B_MOD} -> pkg/b.py`]);
  });

  it('answers a write at or below the file seq with stale-seq and changes nothing (INV-13)', async () => {
    const store = await opened();
    await store.write(TREE);
    await store.write(writeA(5));
    const before = await everything(store);
    const late = [
      await store.write(writeA(5, REV_A2)),
      await store.write(writeA(4, REV_A2)),
      await store.write(del('a.py', 5)),
      await store.write(writeA(5)),
    ];
    expect(late).toEqual(Array(4).fill(notApplied({ reason: 'stale-seq', current: 5 })));
    expect(await everything(store)).toEqual(before);
    // The seq is per file: b.py's first write at a lower seq applies.
    expect((await store.write(writeB(2))).applied).toBe(true);
    // delete-file moves the seq too.
    await store.write(del('a.py', 8));
    expect(await store.write(writeA(8, REV_A2))).toEqual(
      notApplied({ reason: 'stale-seq', current: 8 }),
    );
  });

  it('answers an unchanged code revision with revision-unchanged; its seq still counts', async () => {
    const store = await opened();
    await store.write(TREE);
    await store.write(writeA(3));
    const before = await store.readAll();
    const auditBefore = store.auditLog();
    expect(
      await store.write(replace('a.py', 4, REV_A, [code('MODULE', A_MOD, 'a.py', REV_A, 'other')])),
    ).toEqual(notApplied({ reason: 'revision-unchanged', revision_id: REV_A }));
    expect([await store.readAll(), store.auditLog()]).toEqual([before, auditBefore]);
    expect((await store.fileStates()).find((s) => s.file === 'a.py')?.seq).toBe(4);
    expect(await store.write(writeA(4, REV_A2))).toEqual(
      notApplied({ reason: 'stale-seq', current: 4 }),
    );
    // The record still holds REV_A.
    expect(await store.write(writeA(5))).toEqual(
      notApplied({ reason: 'revision-unchanged', revision_id: REV_A }),
    );
    expect((await store.write(writeA(6, REV_A2))).applied).toBe(true);
  });

  it("keys revision-unchanged on the code tier's last revision, never the FILE's", async () => {
    const store = await opened();
    await store.write(TREE);
    // The FILE already says REV_A; the code tier has written nothing.
    expect((await store.write(writeA(0))).applied).toBe(true);
    // After delete-file the file has no code revision: the same revision writes again.
    await store.write(del('a.py', 1));
    expect(await store.write(writeA(2))).toMatchObject({ applied: true, nodesDeleted: 0 });
    expect(await store.nodeKeys('MODULE')).toEqual([A_MOD]);
  });

  it('reads back the revision each tier wrote; code nodes go stale against their FILE (INV-14)', async () => {
    const store = await opened();
    await store.write(TREE);
    await store.write(writeA(1));
    const revisions = async (): Promise<unknown[]> =>
      (await store.readFile(wp('a.py'))).nodes
        .filter((n) => n.label !== 'FILE')
        .map((n) => n.properties['revision_id']);
    expect(await revisions()).toEqual([REV_A, REV_A]);
    // The disk moves on before the code tier does: both code nodes are stale, no SYMBOL is.
    await store.write(mergeFiles([fsFile('a.py', REV_A2)]));
    expect((await store.fileStates()).find((s) => s.file === 'a.py')?.revision_id).toBe(REV_A2);
    expect(await store.staleNodes()).toEqual([
      { id: A_F, file: 'a.py', node_revision: REV_A, file_revision: REV_A2 },
      { id: A_MOD, file: 'a.py', node_revision: REV_A, file_revision: REV_A2 },
    ]);
    await store.write(writeA(2, REV_A2));
    expect([await store.staleNodes(), await revisions()]).toEqual([[], [REV_A2, REV_A2]]);
  });

  it('leaves the prior subgraph exactly as it was when a write is rejected (INV-20)', async () => {
    const store = await seeded();
    const before = await everything(store);
    const torn = replace('a.py', 2, REV_A2, ROWS2, [
      ...A_EDGES,
      e('DEFINES', METHOD(A_F), SYM('`zz.py`/gone().')),
    ]);
    expect(await rejection(store.write(torn))).toBe('WRITE_SHAPE_VIOLATION');
    expect(await everything(store)).toEqual(before);
    // The rejected write took no seq.
    expect((await store.write(writeA(2, REV_A2))).applied).toBe(true);
  });

  it('merges every edge on (source, type, target)', async () => {
    const store = await seeded();
    const edgesBefore = (await store.stats()).edgeCount;
    const twice = [...A_EDGES, A_DECLARES, alias({ via: 'x' })];
    expect(await store.write(replace('a.py', 2, REV_A2, aRows(REV_A2), twice))).toEqual(
      applied(5, 6, 2),
    );
    const again = [...A_EDGES, alias({ via: null, weight: 2 })];
    expect(await store.write(replace('a.py', 3, REV_A, aRows(REV_A), again))).toEqual(
      applied(5, 5, 2),
    );
    expect((await store.stats()).edgeCount).toBe(edgesBefore + 1);
    const aliasEdges = (await store.readAll()).edges.filter((x) => x.type === 'ALIAS_OF');
    expect(aliasEdges).toEqual([
      { source: S_A, target: S_B, type: 'ALIAS_OF', data: { via: 'x', weight: 2 } },
    ]);
  });

  it('retains nothing of the op and mutates none of it', async () => {
    const store = await opened();
    await store.write(TREE);
    const names = ['path'];
    const importRow: NodeRow = {
      label: 'IMPORT',
      key: 'file:a.py:IMPORT:$root:0',
      properties: { file: 'a.py', revision_id: REV_A, range: RANGE, imported_names: names },
    };
    const op = replace('a.py', 1, REV_A, [...aRows(REV_A), importRow], A_EDGES);
    const frozen = structuredClone(op);
    deepFreeze(frozen);
    expect((await store.write(frozen)).applied).toBe(true);
    await store.write(del('a.py', 2));
    await store.write({ ...op, seq: 3 });
    names.push('sep');
    const written = (await store.readFile(wp('a.py'))).nodes.find((n) => n.label === 'IMPORT');
    expect(written?.properties['imported_names']).toEqual(['path']);
  });

  it('deletes unknown-label nodes of the file, and no other label that carries a file', async () => {
    const store = await opened();
    await store.write(TREE);
    const kept = ['SYMBOL', 'TAG', 'COMMUNITY', 'DIRECTORY', 'FILE', 'META_DATA'];
    const planted: GraphNode[] = kept.map((type) => ({
      id: `x:${type}`,
      type,
      data: { file: 'a.py' },
    }));
    await plant(store, [
      ...planted,
      { id: 'file:a.py:STMT:$root:0', type: 'STMT', data: { file: 'a.py' } },
    ]);
    expect(await store.write(writeA(1))).toMatchObject({ applied: true, nodesDeleted: 1 });
    expect(await store.write(del('a.py', 2))).toMatchObject({ applied: true, nodesDeleted: 2 });
    const ids = (await store.readAll()).nodes.map((n) => n.id);
    expect(kept.filter((type) => !ids.includes(`x:${type}`))).toEqual([]);
    expect(ids.includes('file:a.py:STMT:$root:0')).toBe(false);
  });

  it("removes every edge into the file's old nodes, wherever it starts (I-8)", async () => {
    const store = await seeded();
    const into: GraphEdge = { source: B_CALL, target: A_F, type: 'TARGETS' };
    const targets = async (): Promise<unknown[]> =>
      (await store.readAll()).edges.filter((x) => x.type === 'TARGETS');
    await plant(store, [], [into]);
    await store.write(writeA(2, REV_A2));
    expect(await targets()).toEqual([]);
    await plant(store, [], [into]);
    await store.write(del('a.py', 3));
    expect(await targets()).toEqual([]);
  });

  it('merges TAG rows on their name and keeps them past the file (identity)', async () => {
    const store = await seeded();
    const tag: NodeRow = { label: 'TAG', key: 'deprecated', properties: { name: 'deprecated' } };
    const tagged = e('TAGGED_BY', SYM(S_F), ['TAG', 'deprecated']);
    expect(
      await store.write(replace('a.py', 2, REV_A2, [...aRows(REV_A2), tag], [...A_EDGES, tagged])),
    ).toEqual(applied(6, 5, 2));
    await store.write(del('a.py', 3));
    expect(await store.nodeKeys('TAG')).toEqual(['deprecated']);
    expect((await store.readAll()).edges).toContainEqual({
      source: S_F,
      target: 'deprecated',
      type: 'TAGGED_BY',
    });
  });

  it("escapes the file's path in its ids: a ':' path (makeNodeId)", async () => {
    const store = await opened();
    await store.write(mergeFiles([fsFile('a:b.py', REV_A)]));
    const mod = 'file:a%3Ab.py:MODULE:$root';
    const sourceFile = e('SOURCE_FILE', MOD(mod), FILE('a:b.py'));
    const op = replace(
      'a:b.py',
      0,
      REV_A,
      [code('MODULE', mod, 'a:b.py', REV_A, 'a')],
      [sourceFile],
    );
    expect(await store.write(op)).toEqual(applied(1, 1, 0));
    expect(edgeLines((await store.readFile(wp('a:b.py'))).edges)).toEqual([
      `SOURCE_FILE ${mod} -> a:b.py`,
    ]);
    const raw = replace('a:b.py', 1, REV_A2, [
      code('MODULE', 'file:a:b.py:MODULE:$root', 'a:b.py', REV_A2, 'a'),
    ]);
    expect(await rejection(store.write(raw))).toBe('OWNERSHIP_VIOLATION');
  });

  it("keeps a file's seq past the removal and return of its FILE (INV-13)", async () => {
    const store = await opened();
    await store.write(TREE);
    await store.write(writeA(5));
    await store.write(mergeFiles([], ['a.py']));
    await store.write(mergeFiles([fsFile('a.py', REV_A2)]));
    expect(await store.write(writeA(3, REV_A2))).toEqual(
      notApplied({ reason: 'stale-seq', current: 5 }),
    );
  });

  it("refuses a row whose id another file's node holds (INV-12)", async () => {
    const store = await opened();
    await store.write(TREE);
    const ghost = 'file:a.py:METHOD:ghost';
    await plant(store, [
      { id: ghost, type: 'METHOD', data: { file: 'pkg/b.py', revision_id: REV_B } },
    ]);
    const before = await everything(store);
    const op = replace('a.py', 1, REV_A, [
      ...aRows(REV_A),
      code('METHOD', ghost, 'a.py', REV_A, 'g'),
    ]);
    expect(await rejection(store.write(op))).toBe('OWNERSHIP_VIOLATION');
    expect(await everything(store)).toEqual(before);
  });

  it.each([
    ['a negative seq', replace('a.py', -1, REV_A2, ROWS2), W],
    ['a fractional seq', replace('a.py', 2.5, REV_A2, ROWS2), W],
    ['a NaN seq', replace('a.py', Number.NaN, REV_A2, ROWS2), W],
    ['the root as its file', replace('.', 2, REV_A2, []), W],
    ['a delete-file at a negative seq', del('a.py', -1), W],
    ['a delete-file of the root', del('.', 2), W],
    ['a delete-file of a path outside the workspace', forged(del('a.py', 2), '/a.py'), W],
    ['an unsafe integer seq', replace('a.py', Number.MAX_SAFE_INTEGER + 1, REV_A2, ROWS2), W],
    ['a file with no FILE node', replace('zz.py', 0, REV_A2, []), W],
    ['an unknown label', plus(relabel(ODD, 'BOGUS')), W],
    ['two rows with one key', plus(code('METHOD', A_F, 'a.py', REV_A2, 'f2')), W],
    ['two SYMBOL rows with one key', plus(sym(S_A, 'other')), W],
    ['two FILE rows', plus(codeHalf('a.py', { loc: 1 })), W],
    [
      'a TAG whose name is not its key',
      plus({ label: 'TAG', key: 't1', properties: { name: 't2' } }),
      W,
    ],
    ['a SYMBOL whose fqn is not its key', plus({ ...sym(S_F, 'x'), key: S_G }), W],
    ['an edge onto no node', plusEdge(e('DEFINES', METHOD(A_F), SYM('`zz.py`/no().'))), W],
    ['an endpoint of the wrong label', plusEdge(e('DECLARES', MOD(A_MOD), METHOD(A_MOD))), W],
    [
      'an edge onto a node this write deletes',
      aOp(NO_F, [e('DECLARES', MOD(A_MOD), METHOD(A_F))]),
      W,
    ],
    ['an unknown edge type', plusEdge(BOGUS_EDGE), W],
    ['a row of another file', oddWith({ properties: { ...ODD.properties, file: 'pkg/b.py' } }), O],
    ["a key with another file's prefix", oddWith({ key: 'file:pkg/b.py:METHOD:z' }), O],
    ['a key that only starts like the file id', oddWith({ key: 'file:a.pyx:METHOD:z' }), O],
    ["another file's FILE row", plus(codeHalf('pkg/b.py', { loc: 9 })), O],
    ['a filesystem-owned FILE property', fileHalf({ revision_id: REV_A2 }), O],
    ["the FILE's name", fileHalf({ loc: 2, name: 'x.py' }), O],
    ['a FILE property outside the schema', fileHalf({ bogus: 1 }), O],
    ['a DIRECTORY row', plus(dirRow('pkg')), O],
    ['a COMMUNITY row (INV-10)', plus({ label: 'COMMUNITY', key: 'c1', properties: {} }), O],
    ['a META_DATA row', plus({ label: 'META_DATA', key: 'meta', properties: {} }), O],
    ['an overlay edge (INV-10)', plusEdge(e('DEPENDS_ON', FILE('a.py'), FILE('a.py'))), O],
    ['a HAS_ENTRY edge', plusEdge(e('HAS_ENTRY', ['DIRECTORY', '.'], FILE('a.py'))), O],
    ["an edge from another file's node", plusEdge(e('CALLS', CALL(B_CALL), SYM(S_A))), O],
    ["an edge onto another file's node", plusEdge(e('DECLARES', MOD(A_MOD), CALL(B_CALL))), O],
    ["SOURCE_FILE onto b.py's FILE", plusEdge(e('SOURCE_FILE', MOD(A_MOD), FILE('pkg/b.py'))), O],
    ['an edge onto a DIRECTORY', plusEdge(e('DECLARES', MOD(A_MOD), ['DIRECTORY', 'pkg'])), O],
  ])('refuses %s and changes nothing', async (_label, op, expected) => {
    const store = await seeded();
    const before = await everything(store);
    expect(await rejection(store.write(op))).toBe(expected);
    expect(await everything(store)).toEqual(before);
  });
});

// Post-implementation (named in the PR): sabotage #26 survived (no test read GraphNode.name),
// and the review of the implementation found an edge merge that collapsed other files' duplicates.
describe('MemoryStore replace-file, after the implementation', () => {
  it("names a created node from its name property and keeps a merged node's name", async () => {
    const store = await opened();
    await store.write(TREE);
    await plant(store, [{ id: S_F, type: 'SYMBOL', name: 'f', data: { fqn: S_F } }]);
    await store.write(writeA(1));
    const { nodes } = await store.readAll();
    expect([A_MOD, A_F, S_F].map((id) => nodes.find((n) => n.id === id)?.name)).toEqual([
      'a',
      'f',
      'f',
    ]);
  });

  it("leaves another file's duplicate edges as they are (INV-12)", async () => {
    const store = await seeded();
    const twin: GraphEdge = { source: B_CALL, target: S_B, type: 'TARGETS' };
    const twins = async (): Promise<unknown[]> =>
      (await store.readAll()).edges.filter((x) => x.type === 'TARGETS');
    // The GraphSink half concatenates edges (stop-list 50), so both land.
    await plant(store, [], [twin, twin]);
    expect(await twins()).toEqual([twin, twin]);
    await store.write(writeA(2, REV_A2));
    expect(await twins()).toEqual([twin, twin]);
  });
});

describe('MemoryStore delete-file', () => {
  it('deletes the file-owned subgraph only: the FILE and every SYMBOL stay (decision 104)', async () => {
    const store = await seeded();
    const fileBefore = (await store.readFile(wp('a.py'))).nodes.find((n) => n.label === 'FILE');
    expect(await store.write(del('a.py', 9))).toEqual(applied(0, 0, 2));
    expect(await store.readFile(wp('a.py'))).toEqual({ nodes: [fileBefore], edges: [] });
    expect((await store.nodeKeys('SYMBOL')).toSorted(order)).toEqual(
      [S_A, S_F, S_B].toSorted(order),
    );
    expect(edgeLines((await store.readFile(wp('pkg/b.py'))).edges)).toContain(
      `CALLS ${B_CALL} -> ${S_F}`,
    );
    // b.py's 4 code edges and the 3 HAS_ENTRY remain.
    expect(await store.stats()).toMatchObject({ nodeCount: 9, edgeCount: 7 });
    expect((await store.inspect()).highWaterSeq).toBe(-1);
    expect((await store.fileStates()).find((s) => s.file === 'a.py')).toEqual({
      file: 'a.py',
      seq: 9,
      revision_id: REV_A,
      nodeCount: 0,
    });
    expect(store.auditLog().at(-1)).toEqual({
      at: 7,
      scope: { kind: 'file', file: 'a.py' },
      nodesDeleted: 2,
      calledBy: 'delete-file',
    });
  });

  it('needs no FILE: it clears the code nodes a removed FILE left behind', async () => {
    const store = await opened();
    await store.write(TREE);
    await store.write(writeA(1));
    // merge-filesystem removes the FILE only; the engine follows with delete-file (decision 101).
    await store.write(mergeFiles([], ['a.py']));
    expect(await store.nodeKeys('MODULE')).toEqual([A_MOD]);
    expect(await store.write(del('a.py', 2))).toMatchObject({ applied: true, nodesDeleted: 2 });
    expect(await store.nodeKeys('MODULE')).toEqual([]);
    expect(await store.write(del('never.py', 0))).toMatchObject({ applied: true, nodesDeleted: 0 });
    expect(store.auditLog().at(-1)).toEqual({
      at: 7,
      scope: { kind: 'file', file: 'never.py' },
      nodesDeleted: 0,
      calledBy: 'delete-file',
    });
  });
});

describe('toWriteOp into MemoryStore', () => {
  const REV = 'c9'.repeat(32);
  const MAIN_MOD = 'file:main.py:MODULE:$root';
  // Rung 01 as the extractor hands it over: the store accepts what toWriteOp builds.
  const extracted: Parameters<typeof toWriteOp>[0] = {
    path: wp('main.py'),
    grammarId: 'python',
    revision_id: REV,
    nodes: [
      {
        label: 'MODULE',
        id: MAIN_MOD,
        file: wp('main.py'),
        revision_id: REV,
        tier: 'structural',
        range: { startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 },
        properties: { name: 'main', status: 'ready' },
      },
    ],
    symbols: [
      { fqn: '`main.py`/', origin: 'local', language: 'python', properties: { kind: 'module' } },
    ],
    edges: [
      {
        type: 'DEFINES',
        from: { by: 'id', label: 'MODULE', key: MAIN_MOD },
        to: { by: 'fqn', label: 'SYMBOL', key: '`main.py`/' },
        properties: {},
      },
    ],
    refSites: [],
    stats: { astNodesVisited: 1, structuralNodes: 1, expressionNodes: 0, lineCount: 0 },
    elementDigest: 'fnv1a32:00c0ffee',
    interfaceHash: 'e5'.repeat(32),
  };

  it('writes what toWriteOp builds, plus the engine-attached SOURCE_FILE', async () => {
    const store = await opened();
    await store.write(mergeFiles([fsFile('main.py', REV)]));
    const op = toWriteOp(extracted, [], 4);
    const sourceFile = e('SOURCE_FILE', MOD(MAIN_MOD), FILE('main.py'));
    expect(await store.write({ ...op, edges: [...op.edges, sourceFile] })).toEqual(
      applied(3, 2, 0),
    );
    const { nodes, edges } = await store.readFile(wp('main.py'));
    expect(byKey(nodes)).toEqual([
      {
        label: 'MODULE',
        key: MAIN_MOD,
        properties: {
          name: 'main',
          status: 'ready',
          file: 'main.py',
          revision_id: REV,
          range: '1:0-1:0',
        },
      },
      {
        label: 'FILE',
        key: 'main.py',
        properties: {
          ...fsFile('main.py', REV).properties,
          interface_hash: 'e5'.repeat(32),
          loc: 0,
          status: 'ready',
          version: 1,
        },
      },
    ]);
    expect(edgeLines(edges)).toEqual([
      `DEFINES ${MAIN_MOD} -> \`main.py\`/`,
      `SOURCE_FILE ${MAIN_MOD} -> main.py`,
    ]);
    expect(await store.nodeKeys('SYMBOL')).toEqual(['`main.py`/']);
    expect(await store.fileStates()).toEqual([
      { file: 'main.py', seq: 4, revision_id: REV, nodeCount: 1 },
    ]);
  });
});

/** Adds nodes and edges through the GraphSink half, the way a code delta would. */
async function plant(
  store: MemoryStore,
  addedNodes: readonly GraphNode[],
  addedEdges: readonly GraphEdge[] = [],
): Promise<void> {
  const seq = (await store.inspect()).highWaterSeq + 1;
  const delta = makeDelta({
    seq,
    file: wp('a.py'),
    revision_id: REV_A,
    producer: 'code',
    addedNodes,
    addedEdges,
    removedNodeIds: [],
  });
  if (delta === undefined) throw new Error('test bug: nothing to plant');
  await store.onDelta(delta, { seq, cause: 'live', files: ['a.py'] });
}

function deepFreeze(value: unknown): void {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
}
