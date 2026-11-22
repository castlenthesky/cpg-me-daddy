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
    const after = [await rejection(store.write(TREE)), await rejection(store.nodeKeys('FILE'))];
    expect([...before, ...after]).toEqual(Array(4).fill('STORE_NOT_OPEN'));
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
        files: [fileRow('notes.txt', 'r0', null)],
        links: [link('.', 'FILE', 'notes.txt')],
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
      ],
      edges: [hasEntry('dir:.', 'file:notes.txt')],
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
    await store.write(TREE);
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
    await codeDelta(store, 0, [method('file:a.py:METHOD:f', 'a.py', 'r1')]);
    const { nodes, edges } = await store.readFile(wp('a.py'));
    expect(nodes.map((n) => `${n.label} ${n.key}`).toSorted()).toEqual([
      'FILE a.py',
      'METHOD file:a.py:METHOD:f',
    ]);
    expect(edges).toEqual([]);
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
    expect(store.auditLog().map((a) => a.scope)).toEqual([{ kind: 'subtree', directory: 'app' }]);
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
      'a link onto a missing node',
      mergeFs({ directories: [dirRow('.')], links: [link('.', 'FILE', 'zz.py')] }),
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
