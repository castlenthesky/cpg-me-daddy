// The C-SINK functions over deltas and failures.

import type { GraphDelta } from '@cpg/model';
import type { DeliverableDelta, SinkError, SinkFailureKind } from './contract';

/** undefined = nothing changed = never delivered (producer_may_not). */
export function makeDelta(_parts: GraphDelta): DeliverableDelta | undefined {
  // SEAT: U2a.2b
  throw new Error('SEAT: makeDelta is not built yet (U2a.2b)');
}

export function sinkError(
  _kind: SinkFailureKind,
  _sinkId: string,
  _seq: number,
  _message: string,
  _extra?: { readonly retryAfterMs?: number; readonly cause?: unknown },
): SinkError {
  // SEAT: U2a.2b
  throw new Error('SEAT: sinkError is not built yet (U2a.2b)');
}

/** A SinkError's own kind; anything unrecognised is `transient` (retrying is safe; dropping is not). */
export function classifyFailure(_value: unknown): SinkFailureKind {
  // SEAT: U2a.2b
  throw new Error('SEAT: classifyFailure is not built yet (U2a.2b)');
}

/**
 * Throws a `malformed` SinkError unless every added edge's endpoints exist after the delta applies
 * to a graph holding `priorNodeIds` (INV-18). Removals happen first, so an edge onto a node the
 * same delta removes is dangling.
 */
export function assertDeltaWellFormed(
  _delta: GraphDelta,
  _priorNodeIds: ReadonlySet<string>,
  _sinkId: string,
  _seq: number,
): void {
  // SEAT: U2a.2b
  throw new Error('SEAT: assertDeltaWellFormed is not built yet (U2a.2b)');
}
