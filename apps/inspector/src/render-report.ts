// SEAT (U2b.1 part 3a-i, BMO-35): the counts render-reconciliation compares (C-EXT I-10, owner
// decision 12a), taken from the payload the page holds and what the renderer actually drew.

import type { GraphPayload, RenderReport } from '@cpg/model';

/** At most this many ids in `droppedNodeIds` (C-EXT: "a capped sample"). */
export const DROPPED_SAMPLE_CAP = 50;

/** What the renderer drew: GraphVisualizer.drawn(). */
export interface DrawnGraph {
  /** Whether this payload id has a live point. */
  isDrawn(id: string): boolean;
  /** Distinct (source, target, type) edges drawn, both endpoints live. */
  readonly edgeCount: number;
}

/**
 * The render-report for `payload` as drawn: `payloadNodeCount` is `payload.nodes.length`;
 * `renderedNodeCount` counts the distinct ids drawn; `droppedNodeIds` lists, once each and in payload
 * order, every id with an entry left undrawn (an unplaced node, or a duplicate's extra copy), capped
 * at DROPPED_SAMPLE_CAP; `duplicateEdges` is `payload.edges.length` minus the distinct edge keys.
 */
export function renderReport(
  _payload: GraphPayload,
  _drawn: DrawnGraph,
  _frameMs: number,
): RenderReport {
  throw new Error('SEAT: renderReport is U2b.1 part 3a-i');
}
