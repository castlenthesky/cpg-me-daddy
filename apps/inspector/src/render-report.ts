// REAL (U2b.1 part 3a-i, BMO-35): the counts render-reconciliation compares (C-EXT I-10, owner
// decision 12a), taken from the payload the page holds and what the renderer actually drew.

import type { GraphPayload, RenderReport } from '@cpg/model';
import { edgeKey } from './edge-store';

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
  payload: GraphPayload,
  drawn: DrawnGraph,
  frameMs: number,
): RenderReport {
  const seenIds = new Set<string>();
  const dropped = new Set<string>();
  const droppedNodeIds: string[] = [];
  let renderedNodeCount = 0;

  for (const node of payload.nodes) {
    const { id } = node;
    if (!seenIds.has(id)) {
      seenIds.add(id);
      if (drawn.isDrawn(id)) {
        renderedNodeCount += 1;
        continue;
      }
    }
    if (!dropped.has(id)) {
      dropped.add(id);
      if (droppedNodeIds.length < DROPPED_SAMPLE_CAP) {
        droppedNodeIds.push(id);
      }
    }
  }

  const edgeKeys = new Set<string>();
  for (const edge of payload.edges) {
    edgeKeys.add(edgeKey(edge));
  }

  return {
    payloadNodeCount: payload.nodes.length,
    renderedNodeCount,
    renderedEdgeCount: drawn.edgeCount,
    duplicateEdges: payload.edges.length - edgeKeys.size,
    droppedNodeIds,
    frameMs,
  };
}
