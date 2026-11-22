// MemoryStore: the always-on, durable, in-memory graph. This file is its GraphSink half; the
// GraphStore half (C-STORE write/fileStates/nodeKeys/staleNodes) lands in U2a.2c.

import type { GraphDelta, GraphPayload } from '@cpg/model';
import { applyGraphDelta, graphDigest } from '@cpg/model';
import type {
  DeliverableDelta,
  DeltaMeta,
  GraphSink,
  SinkCapabilities,
  SinkState,
  SnapshotMeta,
} from './contract';
import { assertDeltaWellFormed, sinkError } from './delta';

export interface MemoryStoreOptions {
  /** Default 'memory'. */
  readonly id?: string;
}

export type MemoryStore = GraphSink;

const MEMORY_STORE_CAPABILITIES: SinkCapabilities = {
  durability: 'durable',
  resyncBySnapshot: false,
  deadlineMs: 1000,
  maxQueueDepth: 1024,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function createMemoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  // REAL
  const id = options.id ?? 'memory';
  let state: GraphPayload = { seq: -1, nodes: [], edges: [] };
  let disposed = false;

  return {
    id,
    capabilities: MEMORY_STORE_CAPABILITIES,

    async onSnapshot(payload: GraphPayload, meta: SnapshotMeta): Promise<void> {
      if (disposed) {
        throw sinkError('permanent', id, meta.seq, 'sink is disposed');
      }
      if (!isObject(payload)) {
        throw sinkError('malformed', id, meta.seq, 'snapshot payload must be an object');
      }
      if (meta.seq <= state.seq) return;

      const copy = structuredClone(payload);
      const nodeIds = new Set(copy.nodes.map((node) => node.id));
      for (const edge of copy.edges) {
        if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
          throw sinkError(
            'malformed',
            id,
            meta.seq,
            `dangling edge ${edge.source} -> ${edge.target}`,
          );
        }
      }
      state = { seq: meta.seq, nodes: copy.nodes, edges: copy.edges };
    },

    async onDelta(delta: DeliverableDelta, meta: DeltaMeta): Promise<void> {
      if (disposed) {
        throw sinkError('permanent', id, meta.seq, 'sink is disposed');
      }
      if (!isObject(delta)) {
        throw sinkError('malformed', id, meta.seq, 'delta must be an object');
      }
      if (meta.seq <= state.seq) return;
      if (meta.seq > state.seq + 1) {
        throw sinkError(
          'out-of-order',
          id,
          meta.seq,
          `expected seq ${String(state.seq + 1)}, got ${String(meta.seq)}`,
        );
      }

      const copy: GraphDelta = { ...structuredClone(delta), seq: meta.seq };
      const priorNodeIds = new Set(state.nodes.map((node) => node.id));
      assertDeltaWellFormed(copy, priorNodeIds, id, meta.seq);

      const result = applyGraphDelta(state, copy);
      switch (result.outcome) {
        case 'applied':
          state = result.payload;
          return;
        case 'malformed': {
          const detail = result.defects.map((d) => `${d.code}:${d.nodeId}`).join(', ');
          throw sinkError('malformed', id, meta.seq, `delta malformed (${detail})`);
        }
        case 'gap':
          throw sinkError(
            'out-of-order',
            id,
            meta.seq,
            `expected seq ${String(result.expected)}, got ${String(result.got)}`,
          );
        case 'already-applied':
          return;
      }
    },

    async inspect(): Promise<SinkState> {
      return {
        highWaterSeq: state.seq,
        nodeCount: state.nodes.length,
        edgeCount: state.edges.length,
        digest: graphDigest(state),
        nodeIds: state.nodes.map((node) => node.id),
      };
    },

    async dispose(): Promise<void> {
      disposed = true;
    },
  };
}
