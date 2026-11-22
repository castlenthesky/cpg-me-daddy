// The C-SINK GraphSink conformance suite (05-contracts.yaml), one block per invariant id, run against
// an implementation. Written from the contract's invariant list: the archived reference suite the
// contract cites ("46 tests") is in no reachable commit. The SinkDelivery half lands with
// createSinkDelivery.

import type { GraphEdge, GraphNode, GraphPayload, PropertyOwner, WorkspacePath } from '@cpg/model';
import { graphDigest, isWorkspacePath } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import type { DeliverableDelta, DeltaMeta, GraphSink, SinkState } from './contract';
import { classifyFailure } from './delta';
import { createMemoryStore } from './memory-store';

function wp(s: string): WorkspacePath {
  if (!isWorkspacePath(s)) throw new Error(`not a WorkspacePath: ${s}`);
  return s;
}

const method = (id: string, data: Record<string, unknown> = {}): GraphNode => ({
  id,
  type: 'METHOD',
  data,
});
const fileNode = (id: string, data: Record<string, unknown>): GraphNode => ({
  id,
  type: 'FILE',
  data,
});
const calls = (source: string, target: string): GraphEdge => ({ source, target, type: 'CALLS' });

const A = 'file:a.py:METHOD:f';
const B = 'file:a.py:METHOD:g';

function isNonEmpty<T>(xs: readonly T[]): xs is readonly [T, ...T[]] {
  return xs.length > 0;
}

interface Parts {
  readonly addedNodes?: readonly GraphNode[];
  readonly addedEdges?: readonly GraphEdge[];
  readonly removedNodeIds?: readonly string[];
  readonly producer?: PropertyOwner;
}

function delta(seq: number, parts: Parts): DeliverableDelta {
  const addedNodes = parts.addedNodes ?? [];
  const addedEdges = parts.addedEdges ?? [];
  const removedNodeIds = parts.removedNodeIds ?? [];
  const base = {
    seq,
    file: wp('a.py'),
    revision_id: 'r1',
    producer: parts.producer ?? 'code',
    addedNodes,
    addedEdges,
    removedNodeIds,
  };
  if (isNonEmpty(addedNodes)) return { ...base, addedNodes };
  if (isNonEmpty(addedEdges)) return { ...base, addedEdges };
  if (isNonEmpty(removedNodeIds)) return { ...base, removedNodeIds };
  throw new Error('test bug: an all-empty delta');
}

const live = (seq: number): DeltaMeta => ({ seq, cause: 'live', files: ['a.py'] });
const send = (sink: GraphSink, d: DeliverableDelta): Promise<void> => sink.onDelta(d, live(d.seq));

/** A sink already holding A -> B at seq 0. */
async function seeded(make: () => GraphSink): Promise<GraphSink> {
  const sink = make();
  await send(sink, delta(0, { addedNodes: [method(A), method(B)], addedEdges: [calls(A, B)] }));
  return sink;
}

async function rejectionKind(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (error) {
    return classifyFailure(error);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

const counts = (s: SinkState): readonly number[] => [s.highWaterSeq, s.nodeCount, s.edgeCount];

export function verifyGraphSinkContract(name: string, make: () => GraphSink): void {
  describe(`C-SINK GraphSink contract: ${name}`, () => {
    it('a fresh sink is empty at highWaterSeq -1', async () => {
      const state = await make().inspect();
      expect(counts(state)).toEqual([-1, 0, 0]);
      expect(state.digest).toBe(graphDigest({ nodes: [], edges: [] }));
    });

    it('INV-12: the effect is visible in inspect() as soon as onDelta resolves', async () => {
      const state = await (await seeded(make)).inspect();
      expect(counts(state)).toEqual([0, 2, 1]);
      expect(state.digest).toBe(
        graphDigest({ nodes: [method(A), method(B)], edges: [calls(A, B)] }),
      );
      // nodeIds is optional, but when present it is COMPLETE.
      expect(state.nodeIds === undefined ? [A, B] : state.nodeIds.toSorted()).toEqual([A, B]);
    });

    it('INV-4: an edge-only delta is applied', async () => {
      const sink = make();
      await send(sink, delta(0, { addedNodes: [method(A), method(B)] }));
      await send(sink, delta(1, { addedEdges: [calls(A, B)] }));
      expect(counts(await sink.inspect())).toEqual([1, 2, 1]);
    });

    it('INV-5: a seq at or below highWaterSeq resolves as a no-op', async () => {
      const sink = await seeded(make);
      const before = await sink.inspect();
      // A true redelivery replays the same delta: it must not be judged as a re-add.
      await send(sink, delta(0, { addedNodes: [method(A), method(B)], addedEdges: [calls(A, B)] }));
      await send(sink, delta(0, { addedNodes: [method('file:a.py:METHOD:other')] }));
      await send(sink, delta(-1, { removedNodeIds: [A] }));
      expect(await sink.inspect()).toEqual(before);
    });

    it('INV-6 + INV-10: a gap rejects out-of-order and leaves state identical', async () => {
      const sink = await seeded(make);
      const before = await sink.inspect();
      expect(await rejectionKind(send(sink, delta(2, { removedNodeIds: [A] })))).toBe(
        'out-of-order',
      );
      expect(await sink.inspect()).toEqual(before);
    });

    it('INV-7: removing a node removes every incident edge', async () => {
      const sink = await seeded(make);
      const C = 'file:a.py:METHOD:h';
      await send(
        sink,
        delta(1, { addedNodes: [method(C)], addedEdges: [calls(B, C), calls(C, A)] }),
      );
      // B is the target of A -> B and the source of B -> C; C -> A does not touch it.
      await send(sink, delta(2, { removedNodeIds: [B] }));
      const state = await sink.inspect();
      expect(counts(state)).toEqual([2, 2, 1]);
      expect(state.digest).toBe(
        graphDigest({ nodes: [method(A), method(C)], edges: [calls(C, A)] }),
      );
    });

    it('INV-18 + INV-10: a dangling added edge rejects malformed and leaves state identical', async () => {
      const sink = await seeded(make);
      const before = await sink.inspect();
      const missing = 'file:a.py:METHOD:missing';
      expect(await rejectionKind(send(sink, delta(1, { addedEdges: [calls(A, missing)] })))).toBe(
        'malformed',
      );
      expect(await rejectionKind(send(sink, delta(1, { addedEdges: [calls(missing, A)] })))).toBe(
        'malformed',
      );
      const ontoRemoved = delta(1, { removedNodeIds: [B], addedEdges: [calls(A, B)] });
      expect(await rejectionKind(send(sink, ontoRemoved))).toBe('malformed');
      expect(await sink.inspect()).toEqual(before);
    });

    it('DQ-01: a same-producer re-add without removal is malformed; state identical', async () => {
      const sink = await seeded(make);
      const before = await sink.inspect();
      const readd = delta(1, { addedNodes: [method(A, { name: 'f2' })] });
      expect(await rejectionKind(send(sink, readd))).toBe('malformed');
      expect(await sink.inspect()).toEqual(before);
    });

    it('DQ-01: a cross-tier re-add merges by property owner', async () => {
      const sink = make();
      const fsTier = { path: 'a.py', name: 'a.py', content_hash: 'h', revision_id: 'h' };
      await send(
        sink,
        delta(0, { producer: 'filesystem', addedNodes: [fileNode('file:a.py', fsTier)] }),
      );
      await send(
        sink,
        delta(1, {
          addedNodes: [fileNode('file:a.py', { interface_hash: 'i', content_hash: 'X' })],
        }),
      );
      // The filesystem tier re-adds with new hashes and a stray code-owned key: its own keys win,
      // the code tier's interface_hash survives.
      const fsTier2 = { path: 'a.py', name: 'a.py', content_hash: 'h2', revision_id: 'h2' };
      await send(
        sink,
        delta(2, {
          producer: 'filesystem',
          addedNodes: [fileNode('file:a.py', { ...fsTier2, interface_hash: 'Y' })],
        }),
      );
      const merged = fileNode('file:a.py', { ...fsTier2, interface_hash: 'i' });
      const state = await sink.inspect();
      expect(counts(state)).toEqual([2, 1, 0]);
      expect(state.digest).toBe(graphDigest({ nodes: [merged], edges: [] }));
    });

    it('INV-9: a garbage delivery rejects; the sink never throws synchronously', async () => {
      const sink = await seeded(make);
      let pending: Promise<void> | undefined;
      expect(() => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately garbage: what a buggy producer could send.
        pending = sink.onDelta(null as unknown as DeliverableDelta, live(1));
      }).not.toThrow();
      expect(await rejectionKind(pending ?? Promise.resolve())).not.toBe('resolved');
      let snap: Promise<void> | undefined;
      expect(() => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately garbage.
        snap = sink.onSnapshot(null as unknown as GraphPayload, { seq: 1, cause: 'resync' });
      }).not.toThrow();
      expect(await rejectionKind(snap ?? Promise.resolve())).not.toBe('resolved');
    });

    it('INV-11: a sink neither mutates nor retains the delivered objects', async () => {
      const sink = make();
      const nodes = [method(A, { name: 'f' }), method(B)];
      await sink.onSnapshot(deepFreeze({ seq: 0, nodes: [method(B)], edges: [] }), {
        seq: 0,
        cause: 'initial',
      });
      await send(sink, deepFreeze(delta(1, { addedNodes: [method(A, { name: 'f' })] })));
      const live2 = delta(2, { addedEdges: [calls(A, B)] });
      await send(sink, live2);
      const before = await sink.inspect();
      // Mutating what was delivered must not reach into the sink.
      const edge = live2.addedEdges[0];
      if (edge !== undefined) Object.assign(edge, { target: A });
      expect(await sink.inspect()).toEqual(before);

      // The same for a snapshot and for a node's data.
      const fresh = make();
      const snapNode = method(A, { name: 'f' });
      const snapNodes = [snapNode];
      const snapshot: GraphPayload = { seq: 0, nodes: snapNodes, edges: [] };
      await fresh.onSnapshot(snapshot, { seq: 0, cause: 'initial' });
      const node = method(B, { name: 'g' });
      await send(fresh, delta(1, { addedNodes: [node] }));
      const held = await fresh.inspect();
      Object.assign(snapNode.data ?? {}, { name: 'mutated' });
      Object.assign(node.data ?? {}, { name: 'mutated' });
      snapNodes.length = 0;
      expect(await fresh.inspect()).toEqual(held);
      expect(before.digest).toBe(graphDigest({ nodes, edges: [calls(A, B)] }));
    });

    it('onSnapshot replaces the graph at meta.seq; deltas continue from there', async () => {
      const sink = await seeded(make);
      const payload: GraphPayload = { seq: 5, nodes: [method(B)], edges: [] };
      await sink.onSnapshot(payload, { seq: 5, cause: 'resync' });
      expect(counts(await sink.inspect())).toEqual([5, 1, 0]);
      await send(sink, delta(6, { addedNodes: [method(A)] }));
      expect(counts(await sink.inspect())).toEqual([6, 2, 0]);
    });

    it('onSnapshot at or below highWaterSeq is a no-op (INV-5)', async () => {
      const sink = await seeded(make);
      await send(sink, delta(1, { removedNodeIds: [B] }));
      const before = await sink.inspect();
      await sink.onSnapshot({ seq: 1, nodes: [], edges: [] }, { seq: 1, cause: 'catch-up' });
      await sink.onSnapshot({ seq: 0, nodes: [], edges: [] }, { seq: 0, cause: 'catch-up' });
      expect(await sink.inspect()).toEqual(before);
    });

    it('onSnapshot with a dangling edge rejects malformed and leaves state identical', async () => {
      const sink = await seeded(make);
      const before = await sink.inspect();
      const bad: GraphPayload = { seq: 3, nodes: [method(A)], edges: [calls(A, B)] };
      expect(await rejectionKind(sink.onSnapshot(bad, { seq: 3, cause: 'resync' }))).toBe(
        'malformed',
      );
      expect(await sink.inspect()).toEqual(before);
    });

    it('INV-15: the digest ignores delivery order and sees content', async () => {
      const nodes = [method(A, { name: 'f' }), method(B, { name: 'g' })];
      const edges = [calls(A, B), calls(B, A)];
      const one = make();
      const two = make();
      await one.onSnapshot({ seq: 0, nodes, edges }, { seq: 0, cause: 'initial' });
      await two.onSnapshot(
        { seq: 0, nodes: nodes.toReversed(), edges: edges.toReversed() },
        { seq: 0, cause: 'initial' },
      );
      const three = make();
      await three.onSnapshot(
        { seq: 0, nodes: [method(A, { name: 'F' }), method(B, { name: 'g' })], edges },
        { seq: 0, cause: 'initial' },
      );
      const [d1, d2, d3] = await Promise.all(
        [one, two, three].map(async (s) => (await s.inspect()).digest),
      );
      expect(d1).toBe(d2);
      expect(d3).not.toBe(d1);
    });
  });
}

verifyGraphSinkContract('MemoryStore', () => createMemoryStore());
