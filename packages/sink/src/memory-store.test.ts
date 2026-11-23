// MemoryStore-specific behaviour beyond the shared GraphSink suite (sink.conformance.test.ts).

import type { WorkspacePath } from '@cpg/model';
import { isWorkspacePath } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import { classifyFailure } from './delta';
import { createMemoryStore } from './memory-store';

function wp(s: string): WorkspacePath {
  if (!isWorkspacePath(s)) throw new Error(`not a WorkspacePath: ${s}`);
  return s;
}

describe('createMemoryStore', () => {
  it('is a durable sink that degrades rather than resyncing by snapshot (C-SINK Q1)', () => {
    const store = createMemoryStore();
    expect(store.id).toBe('memory');
    expect(store.capabilities).toMatchObject({ durability: 'durable', resyncBySnapshot: false });
    expect(createMemoryStore({ id: 'm2' }).id).toBe('m2');
  });

  it('reports a COMPLETE nodeIds list', async () => {
    const store = createMemoryStore();
    await store.onSnapshot(
      { seq: 0, nodes: [{ id: 'dir:.', type: 'DIRECTORY', data: { path: '.' } }], edges: [] },
      { seq: 0, cause: 'initial' },
    );
    expect((await store.inspect()).nodeIds).toEqual(['dir:.']);
  });

  it('rejects every delivery after dispose as permanent', async () => {
    const store = createMemoryStore();
    await store.dispose();
    const kind = await store
      .onSnapshot({ seq: 0, nodes: [], edges: [] }, { seq: 0, cause: 'initial' })
      .then(
        () => 'resolved',
        (error: unknown) => classifyFailure(error),
      );
    const deltaKind = await store
      .onDelta(
        {
          seq: 0,
          file: wp('a.py'),
          revision_id: 'r',
          producer: 'code',
          addedNodes: [],
          addedEdges: [],
          removedNodeIds: ['x'],
        },
        { seq: 0, cause: 'live' },
      )
      .then(
        () => 'resolved',
        (error: unknown) => classifyFailure(error),
      );
    expect([kind, deltaKind]).toEqual(['permanent', 'permanent']);
  });
});

// U2b.1 part 3b: readAll, the whole-graph read C-CLI Q6 names ("MemoryStore's readFile/readAll"),
// which CpgEngine.inspect reads. A store-half read, so it needs open() like the others.
describe('MemoryStore.readAll', () => {
  const graph = {
    seq: 3,
    nodes: [
      { id: 'd', type: 'DIRECTORY', name: '.', data: { path: '.' } },
      { id: 'f', type: 'FILE', name: 'a.ts', data: { path: 'a.ts', revision_id: 'r1' } },
    ],
    edges: [{ source: 'd', target: 'f', type: 'HAS_ENTRY' }],
  };

  it('before open() it throws STORE_NOT_OPEN, like every read', async () => {
    await expect(createMemoryStore().readAll()).rejects.toMatchObject({
      name: 'StoreError',
      code: 'STORE_NOT_OPEN',
    });
  });

  it('after close() it throws STORE_NOT_OPEN', async () => {
    const store = createMemoryStore();
    await store.open();
    await store.close();
    await expect(store.readAll()).rejects.toMatchObject({ code: 'STORE_NOT_OPEN' });
  });

  it('a fresh store is the empty graph at seq -1', async () => {
    const store = createMemoryStore();
    await store.open();
    expect(await store.readAll()).toEqual({ seq: -1, nodes: [], edges: [] });
  });

  it('returns the whole graph: every node and edge, and the seq', async () => {
    const store = createMemoryStore();
    await store.open();
    await store.onSnapshot(graph, { seq: 3, cause: 'initial' });
    expect(await store.readAll()).toEqual(graph);
  });

  it('is a deep copy: changing the result changes nothing in the store', async () => {
    const store = createMemoryStore();
    await store.open();
    await store.onSnapshot(graph, { seq: 3, cause: 'initial' });
    const first = await store.readAll();
    const [node] = first.nodes;
    if (node?.data !== undefined) Reflect.set(node.data, 'path', 'changed');
    Reflect.set(first.edges, 'length', 0);
    expect(await store.readAll()).toEqual(graph);
    expect((await store.inspect()).edgeCount).toBe(1);
  });
});
