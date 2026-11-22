// The C-SINK functions over deltas and failures.

import type { GraphDelta } from '@cpg/model';
import type { DeliverableDelta, SinkError, SinkFailureKind } from './contract';

const SINK_FAILURE_KINDS: ReadonlySet<string> = new Set<SinkFailureKind>([
  'transient',
  'overloaded',
  'out-of-order',
  'malformed',
  'permanent',
]);

function isDeliverableDelta(delta: GraphDelta): delta is DeliverableDelta {
  return (
    delta.addedNodes.length > 0 || delta.addedEdges.length > 0 || delta.removedNodeIds.length > 0
  );
}

function isSinkFailureKind(value: unknown): value is SinkFailureKind {
  return typeof value === 'string' && SINK_FAILURE_KINDS.has(value);
}

/** undefined = nothing changed = never delivered (producer_may_not). */
export function makeDelta(parts: GraphDelta): DeliverableDelta | undefined {
  // REAL
  return isDeliverableDelta(parts) ? parts : undefined;
}

export function sinkError(
  kind: SinkFailureKind,
  sinkId: string,
  seq: number,
  message: string,
  extra?: { readonly retryAfterMs?: number; readonly cause?: unknown },
): SinkError {
  // REAL
  const base =
    extra?.cause !== undefined ? new Error(message, { cause: extra.cause }) : new Error(message);
  return Object.assign(base, {
    name: 'SinkError' as const,
    kind,
    sinkId,
    seq,
    ...(extra?.retryAfterMs === undefined ? {} : { retryAfterMs: extra.retryAfterMs }),
  });
}

/** A SinkError's own kind; anything unrecognised is `transient` (retrying is safe; dropping is not). */
export function classifyFailure(value: unknown): SinkFailureKind {
  // REAL
  if (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    value.name === 'SinkError' &&
    'kind' in value &&
    isSinkFailureKind(value.kind)
  ) {
    return value.kind;
  }
  return 'transient';
}

/**
 * Throws a `malformed` SinkError unless every added edge's endpoints exist after the delta applies
 * to a graph holding `priorNodeIds` (INV-18). Removals happen first, so an edge onto a node the
 * same delta removes is dangling.
 */
export function assertDeltaWellFormed(
  delta: GraphDelta,
  priorNodeIds: ReadonlySet<string>,
  sinkId: string,
  seq: number,
): void {
  // REAL
  const live = new Set(priorNodeIds);
  for (const id of delta.removedNodeIds) live.delete(id);
  for (const node of delta.addedNodes) live.add(node.id);
  for (const edge of delta.addedEdges) {
    if (!live.has(edge.source) || !live.has(edge.target)) {
      throw sinkError(
        'malformed',
        sinkId,
        seq,
        `dangling edge ${edge.source} -> ${edge.target} (type=${edge.type ?? ''})`,
      );
    }
  }
}
