// MemoryStore's GraphStore half, from the C-STORE text (05-contracts.yaml) and BMO-79: the
// filesystem tier is written as ONE merge-filesystem op, then per-file deltas merge onto it.

import type { GraphEdge, GraphNode, NodeLabel, WorkspacePath } from '@cpg/model';
import { graphDigest, isWorkspacePath } from '@cpg/model';
import type { EdgeRow, NodeRow, WriteOp } from '@cpg/store';
import { storeErrorCode } from '@cpg/store';
import { describe, expect, it } from 'vitest';
import type { MemoryStore } from './memory-store';
import { createMemoryStore } from './memory-store';

function wp(s: string): WorkspacePath {
  if (!isWorkspacePath(s)) throw new Error(`not a WorkspacePath: ${s}`);
  return s;
}
const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

const dirRow = (path: string): NodeRow => ({
  label: 'DIRECTORY',
  key: path,
  properties: { path, name: base(path), status: 'ready' },
});
const fileRow = (path: string, rev: string, language: string | null = 'python'): NodeRow => ({
  label: 'FILE',
  key: path,
  properties: { path, name: base(path), language, content_hash: rev, revision_id: rev },
});
const link = (from: string, toLabel: NodeLabel, to: string): EdgeRow => ({
  type: 'HAS_ENTRY',
  fromLabel: 'DIRECTORY',
  fromKey: from,
  toLabel,
  toKey: to,
  properties: {},
});

interface Fs {
  readonly directories?: readonly NodeRow[];
  readonly files?: readonly NodeRow[];
  readonly links?: readonly EdgeRow[];
  readonly removals?: readonly string[];
}
const mergeFs = (fs: Fs): WriteOp => ({
  kind: 'merge-filesystem',
  directories: fs.directories ?? [],
  files: fs.files ?? [],
  links: fs.links ?? [],
  moves: [],
  removals: (fs.removals ?? []).map(wp),
});

/** `.` -> pkg -> pkg/m.py, plus a.py at the root. */
const TREE = mergeFs({
  directories: [dirRow('.'), dirRow('pkg')],
  files: [fileRow('a.py', 'r1'), fileRow('pkg/m.py', 'r2')],
  links: [
    link('.', 'DIRECTORY', 'pkg'),
    link('.', 'FILE', 'a.py'),
    link('pkg', 'FILE', 'pkg/m.py'),
  ],
});

async function opened(now = (): number => 7): Promise<MemoryStore> {
  const store = createMemoryStore({ now });
  await store.open();
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

const method = (id: string, file: string, rev: string): GraphNode => ({
  id,
  type: 'METHOD',
  data: { name: 'f', file, revision_id: rev },
});

/** The code tier's delta onto file `a.py`. */
async function codeDelta(
  store: MemoryStore,
  seq: number,
  nodes: readonly GraphNode[],
): Promise<void> {
  const [first, ...rest] = nodes;
  if (first === undefined) throw new Error('test bug: empty delta');
  await store.onDelta(
    {
      seq,
      file: wp('a.py'),
      revision_id: 'r1',
      producer: 'code',
      addedNodes: [first, ...rest],
      addedEdges: [],
      removedNodeIds: [],
    },
    { seq, cause: 'live', files: ['a.py'] },
  );
}

const fsNode = (
  id: string,
  type: 'DIRECTORY' | 'FILE',
  data: Record<string, unknown>,
): GraphNode => ({
  id,
  type,
  name: String(data['name']),
  data,
});
const hasEntry = (source: string, target: string): GraphEdge => ({
  source,
  target,
  type: 'HAS_ENTRY',
});

describe('MemoryStore as a GraphStore', () => {
  it('declares the memory tier and refuses to drop the graph by default', () => {
    expect(createMemoryStore().capabilities).toMatchObject({
      tier: 'memory',
      dialect: 'none',
      allowDropGraph: false,
      softLimitNodes: 500_000,
      durability: 'durable',
    });
  });

  it('rejects writes and reads before open and after close with STORE_NOT_OPEN', async () => {
    const store = createMemoryStore();
    const before = [await rejection(store.write(TREE)), await rejection(store.fileStates())];
    await store.open();
    await store.close();
    const after = await Promise.all([
      rejection(store.write(TREE)),
      rejection(store.nodeKeys('FILE')),
      rejection(store.fileStates()),
      rejection(store.stats()),
      rejection(store.readFile(wp('a.py'))),
      rejection(store.staleNodes()),
    ]);
    expect([...before, ...after]).toEqual(Array(8).fill('STORE_NOT_OPEN'));
  });

  it('writes the filesystem tier as one merge-filesystem statement', async () => {
    const store = await opened();
    const receipt = await store.write(TREE);
    expect(receipt).toMatchObject({
      applied: true,
      nodesWritten: 4,
      edgesWritten: 3,
      nodesDeleted: 0,
      statementCount: 1,
    });
    expect(receipt.durationMs).toBeGreaterThanOrEqual(0);
    expect(await store.stats()).toEqual({ nodeCount: 4, edgeCount: 3, beyondMeasuredScale: false });
  });

  it('holds the same graph the GraphSink half reports: ids from makeNodeId, null pruned', async () => {
    const store = await opened();
    await store.write(
      mergeFs({
        directories: [dirRow('.')],
        files: [
          fileRow('notes.txt', 'r0', null),
          {
            ...fileRow('a:b.txt', 'r1'),
            properties: { ...fileRow('a:b.txt', 'r1').properties, loc: undefined },
          },
        ],
        links: [link('.', 'FILE', 'notes.txt'), link('.', 'FILE', 'a:b.txt')],
      }),
    );
    const expected = {
      nodes: [
        fsNode('dir:.', 'DIRECTORY', { path: '.', name: '.', status: 'ready' }),
        // language: null is the absent value (C-STORE INV-11 prunes null before SET).
        fsNode('file:notes.txt', 'FILE', {
          path: 'notes.txt',
          name: 'notes.txt',
          content_hash: 'r0',
          revision_id: 'r0',
        }),
        // `:` in a path is escaped by makeNodeId; a hand-built `file:${path}` would not be.
        fsNode('file:a%3Ab.txt', 'FILE', {
          path: 'a:b.txt',
          name: 'a:b.txt',
          language: 'python',
          content_hash: 'r1',
          revision_id: 'r1',
        }),
      ],
      edges: [hasEntry('dir:.', 'file:notes.txt'), hasEntry('dir:.', 'file:a%3Ab.txt')],
    };
    expect((await store.inspect()).digest).toBe(graphDigest(expected));
  });

  it('answers nodeKeys per label (id-uniqueness)', async () => {
    const store = await opened();
    await store.write(TREE);
    const [dirs, files] = await Promise.all([store.nodeKeys('DIRECTORY'), store.nodeKeys('FILE')]);
    expect([dirs.toSorted(), files.toSorted()]).toEqual([
      ['.', 'pkg'],
      ['a.py', 'pkg/m.py'],
    ]);
    // A :CPG label is keyed by its id.
    await codeDelta(store, 0, [method('file:a.py:METHOD:f', 'a.py', 'r1')]);
    expect(await store.nodeKeys('METHOD')).toEqual(['file:a.py:METHOD:f']);
  });

  it('merges on key: a re-merge updates in place and never nulls an existing property', async () => {
    const store = await opened();
    await store.write(TREE);
    const receipt = await store.write(
      mergeFs({ files: [fileRow('a.py', 'r9', null)], links: [link('.', 'FILE', 'a.py')] }),
    );
    expect(receipt.applied).toBe(true);
    expect(await store.stats()).toMatchObject({ nodeCount: 4, edgeCount: 3 });
    const states = await store.fileStates();
    expect(states.map((s) => [s.file, s.revision_id])).toEqual([
      ['a.py', 'r9'],
      ['pkg/m.py', 'r2'],
    ]);
    const { nodes } = await store.readFile(wp('a.py'));
    expect(nodes.find((n) => n.label === 'FILE')?.properties).toMatchObject({
      language: 'python',
      revision_id: 'r9',
    });
    // A DIRECTORY re-merges in place too.
    await store.write(
      mergeFs({
        directories: [
          { ...dirRow('pkg'), properties: { path: 'pkg', name: 'pkg', status: 'stale' } },
        ],
      }),
    );
    expect(await store.stats()).toMatchObject({ nodeCount: 4, edgeCount: 3 });
    expect((await store.nodeKeys('DIRECTORY')).toSorted()).toEqual(['.', 'pkg']);
  });

  it('retains nothing of the op it was given', async () => {
    const store = await opened();
    const row = fileRow('a.py', 'r1');
    const props: Record<string, unknown> = { ...row.properties };
    await store.write(
      mergeFs({ directories: [dirRow('.')], files: [{ ...row, properties: props }] }),
    );
    props['revision_id'] = 'mutated';
    expect((await store.fileStates()).map((f) => f.revision_id)).toEqual(['r1']);
  });

  it('keeps the code tier keys on a FILE when the filesystem tier re-merges it', async () => {
    const store = await opened();
    await store.write(TREE);
    await codeDelta(store, 0, [{ id: 'file:a.py', type: 'FILE', data: { interface_hash: 'i1' } }]);
    await store.write(mergeFs({ files: [fileRow('a.py', 'r5')] }));
    const { nodes } = await store.readFile(wp('a.py'));
    expect(nodes.find((n) => n.label === 'FILE')?.properties).toMatchObject({
      interface_hash: 'i1',
      revision_id: 'r5',
    });
  });

  it('reports fileStates sorted by file, counting the nodes each file owns', async () => {
    const store = await opened();
    // Written in reverse order: the sort is the store's job.
    await store.write(mergeFs({ files: [fileRow('pkg/m.py', 'r2'), fileRow('a.py', 'r1')] }));
    await codeDelta(store, 0, [method('file:a.py:METHOD:f', 'a.py', 'r1')]);
    expect(await store.fileStates()).toEqual([
      { file: 'a.py', seq: -1, revision_id: 'r1', nodeCount: 1 },
      { file: 'pkg/m.py', seq: -1, revision_id: 'r2', nodeCount: 0 },
    ]);
  });

  it('lists exactly the nodes whose revision_id differs from their FILE (P-B)', async () => {
    const store = await opened();
    await store.write(TREE);
    await codeDelta(store, 0, [
      method('file:a.py:METHOD:fresh', 'a.py', 'r1'),
      method('file:a.py:METHOD:old', 'a.py', 'r0'),
    ]);
    expect(await store.staleNodes()).toEqual([
      { id: 'file:a.py:METHOD:old', file: 'a.py', node_revision: 'r0', file_revision: 'r1' },
    ]);
  });

  it('readFile returns the FILE row and the rows the file owns', async () => {
    const store = await opened();
    await store.write(TREE);
    const f = 'file:a.py:METHOD:f';
    const g = 'file:pkg/m.py:METHOD:g';
    await store.onDelta(
      {
        seq: 0,
        file: wp('a.py'),
        revision_id: 'r1',
        producer: 'code',
        addedNodes: [method(f, 'a.py', 'r1'), method(g, 'pkg/m.py', 'r2')],
        addedEdges: [
          { source: f, target: g, type: 'CALLS', data: { status: 'resolved' } },
          { source: g, target: f, type: 'CALLS' },
        ],
        removedNodeIds: [],
      },
      { seq: 0, cause: 'live' },
    );
    const { nodes, edges } = await store.readFile(wp('a.py'));
    expect(nodes.map((n) => `${n.label} ${n.key}`).toSorted()).toEqual([
      'FILE a.py',
      `METHOD ${f}`,
    ]);
    // Only the edges leaving a.py's nodes; the incoming CALLS and HAS_ENTRY are other owners'.
    expect(edges).toEqual([
      {
        type: 'CALLS',
        fromLabel: 'METHOD',
        fromKey: f,
        toLabel: 'METHOD',
        toKey: g,
        properties: { status: 'resolved' },
      },
    ]);
    expect(await store.readFile(wp('absent.py'))).toEqual({ nodes: [], edges: [] });
  });

  it('a removed file takes its FILE node and its HAS_ENTRY edge, and is audited', async () => {
    const store = await opened(() => 42);
    await store.write(TREE);
    const receipt = await store.write(mergeFs({ removals: ['pkg/m.py'] }));
    expect(receipt).toMatchObject({ applied: true, nodesDeleted: 1 });
    expect(await store.stats()).toMatchObject({ nodeCount: 3, edgeCount: 2 });
    expect(store.auditLog()).toEqual([
      {
        at: 42,
        scope: { kind: 'file', file: 'pkg/m.py' },
        nodesDeleted: 1,
        calledBy: 'merge-filesystem',
      },
    ]);
  });

  it('a removed FILE takes the edges it is the source of, not only those into it', async () => {
    const store = await opened();
    await store.write(TREE);
    // DEPENDS_ON runs FILE -> FILE, so a.py's removal must not leave a.py -> pkg/m.py dangling.
    await store.onDelta(
      {
        seq: 0,
        file: wp('a.py'),
        revision_id: 'r1',
        producer: 'code',
        addedNodes: [],
        addedEdges: [{ source: 'file:a.py', target: 'file:pkg/m.py', type: 'DEPENDS_ON' }],
        removedNodeIds: [],
      },
      { seq: 0, cause: 'live' },
    );
    await store.write(mergeFs({ removals: ['a.py'] }));
    expect(await store.stats()).toMatchObject({ nodeCount: 3, edgeCount: 2 });
  });

  it('audits each removal of one op', async () => {
    const store = await opened();
    await store.write(TREE);
    await store.write(mergeFs({ removals: ['a.py', 'pkg'] }));
    expect(store.auditLog().map((a) => [a.scope.kind, a.nodesDeleted])).toEqual([
      ['file', 1],
      ['subtree', 2],
    ]);
    expect(await store.nodeKeys('DIRECTORY')).toEqual(['.']);
  });

  it('refuses to remove the workspace root: that is a whole-graph drop (INV-7)', async () => {
    const store = await opened();
    await store.write(TREE);
    const before = await store.inspect();
    expect(await rejection(store.write(mergeFs({ removals: ['.'] })))).toBe(
      'UNSAFE_DELETE_REFUSED',
    );
    expect(await store.inspect()).toEqual(before);
    expect(store.auditLog()).toEqual([]);
  });

  it('a removed directory takes its subtree on a segment boundary', async () => {
    const store = await opened();
    await store.write(
      mergeFs({
        directories: [dirRow('.'), dirRow('app'), dirRow('app/sub'), dirRow('application')],
        files: [fileRow('app/sub/x.py', 'x'), fileRow('application/y.py', 'y')],
        links: [
          link('.', 'DIRECTORY', 'app'),
          link('app', 'DIRECTORY', 'app/sub'),
          link('app/sub', 'FILE', 'app/sub/x.py'),
          link('.', 'DIRECTORY', 'application'),
          link('application', 'FILE', 'application/y.py'),
        ],
      }),
    );
    const receipt = await store.write(mergeFs({ removals: ['app'] }));
    expect(receipt.nodesDeleted).toBe(3);
    expect((await store.nodeKeys('DIRECTORY')).toSorted()).toEqual(['.', 'application']);
    expect(await store.nodeKeys('FILE')).toEqual(['application/y.py']);
    expect(await store.stats()).toMatchObject({ nodeCount: 3, edgeCount: 2 });
    expect(store.auditLog().map((a) => [a.scope, a.nodesDeleted])).toEqual([
      [{ kind: 'subtree', directory: 'app' }, 3],
    ]);
  });

  it.each([
    [
      'a non-filesystem label in files',
      mergeFs({ files: [{ label: 'METHOD', key: 'm', properties: {} }] }),
    ],
    [
      'a row key that is not its path',
      mergeFs({ files: [{ ...fileRow('a.py', 'r'), key: 'b.py' }] }),
    ],
    [
      'a link that is not HAS_ENTRY',
      mergeFs({
        directories: [dirRow('.')],
        links: [{ ...link('.', 'DIRECTORY', '.'), type: 'CALLS' }],
      }),
    ],
    [
      'a link onto a missing node, alongside a new row',
      mergeFs({ directories: [dirRow('fresh')], links: [link('.', 'FILE', 'zz.py')] }),
    ],
    [
      'a bad row after a good one',
      mergeFs({
        files: [
          fileRow('new.py', 'n'),
          { label: 'DIRECTORY', key: 'x', properties: { path: 'x' } },
        ],
      }),
    ],
  ])('rejects %s with WRITE_SHAPE_VIOLATION and changes nothing', async (_label, op) => {
    const store = await opened();
    await store.write(TREE);
    const before = await store.inspect();
    expect(await rejection(store.write(op))).toBe('WRITE_SHAPE_VIOLATION');
    expect(await store.inspect()).toEqual(before);
  });

  it('refuses the SEAT ops instead of pretending to apply them', async () => {
    const store = await opened();
    await store.write(TREE);
    const before = await store.inspect();
    const seats: WriteOp[] = [
      { kind: 'replace-file', file: wp('a.py'), seq: 0, revision_id: 'r', nodes: [], edges: [] },
      { kind: 'delete-file', file: wp('a.py'), seq: 0 },
      { kind: 'merge-singleton', metadata: { schema_version: '1' } },
      {
        kind: 'merge-filesystem',
        directories: [],
        files: [],
        links: [],
        moves: [{ from: wp('a.py'), to: wp('b.py'), kind: 'file' }],
        removals: [],
      },
    ];
    const codes = await Promise.all(seats.map((op) => rejection(store.write(op))));
    expect(codes).toEqual(Array(4).fill('WRITE_SHAPE_VIOLATION'));
    expect(() => store.overlayWriter('communities')).toThrow(/SEAT/);
    expect(await store.inspect()).toEqual(before);
  });
});
