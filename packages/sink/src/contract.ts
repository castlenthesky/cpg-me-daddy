// C-SINK (05-contracts.yaml): the output seam. One producer fans numbered envelopes out to N sinks;
// ONE interface with two durability modes so the producer never branches per sink.
// Types only (check-deps rule contract-types-only). SEAT: the Envelope / SinkDelivery half
// (createSinkDelivery, retry, telemetry) arrives with its first caller; it is not in U2a.2.

import type { GraphDelta, GraphEdge, GraphNode, GraphPayload } from '@cpg/model';

/** INV-3: the all-empty delta is unrepresentable; the edge-only arm is first-class (INV-4). */
export type DeliverableDelta = GraphDelta &
  (
    | { readonly addedNodes: readonly [GraphNode, ...GraphNode[]] }
    | { readonly addedEdges: readonly [GraphEdge, ...GraphEdge[]] }
    | { readonly removedNodeIds: readonly [string, ...string[]] }
  );

export type SnapshotCause = 'initial' | 'catch-up' | 'resync';
export type DeltaCause = 'live' | 'cascade' | 'bulk';

export interface SinkCapabilities {
  readonly durability: 'durable' | 'ephemeral';
  readonly resyncBySnapshot: boolean;
  readonly deadlineMs: number;
  readonly maxQueueDepth: number;
}

export interface SinkState {
  /** -1 for a fresh sink. */
  readonly highWaterSeq: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  /** Order-independent and content-sensitive (INV-15): `graphDigest` from @cpg/model. */
  readonly digest: string;
  /** If present, COMPLETE. */
  readonly nodeIds?: readonly string[];
}

export interface SnapshotMeta {
  readonly seq: number;
  readonly cause: SnapshotCause;
  readonly files?: readonly string[];
}

export interface DeltaMeta {
  readonly seq: number;
  readonly cause: DeltaCause;
  readonly files?: readonly string[];
}

export interface GraphSink {
  readonly id: string;
  readonly capabilities: SinkCapabilities;
  onSnapshot(payload: GraphPayload, meta: SnapshotMeta): Promise<void>;
  onDelta(delta: DeliverableDelta, meta: DeltaMeta): Promise<void>;
  inspect(): Promise<SinkState>;
  dispose(): Promise<void>;
}

export type SinkFailureKind =
  | 'transient'
  | 'overloaded'
  | 'out-of-order'
  | 'malformed'
  | 'permanent';

export type SinkError = Error & {
  readonly name: 'SinkError';
  readonly kind: SinkFailureKind;
  readonly sinkId: string;
  readonly seq: number;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
};
