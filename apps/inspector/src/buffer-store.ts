// SEAT (U2b.1 part 2a, BMO-35): the per-point buffers split out of
// 21754b4:packages/graph-visualizer/src/visualizer.ts (renderInternal, applyDeltaInternal,
// seedPosition, maskHidden, applyVisibility's live snapshot).

import type { GraphDelta, GraphEdge, GraphNode, GraphPayload } from '@cpg/model';
import type { LayoutResult } from './layout';

function seat(what: string): never {
  throw new Error(`SEAT: ${what} is not built yet (U2b.1 part 2a)`);
}

/**
 * The parent each added node is seeded beside: its first incoming `hierarchyEdgeType` edge, else
 * its first incoming fallback-type edge. The same two passes as the layout's `buildHierarchy`, so a
 * node lands in the same place on a full render and in a delta.
 */
export function deltaParents(
  _addedEdges: readonly GraphEdge[],
  _hierarchyEdgeType: string,
  _fallbackParentEdgeTypes: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  return seat('deltaParents');
}

/**
 * Per-point buffers, parallel by point index: id, type, base position (x, y), colour (r, g, b, a)
 * and size. A point keeps its index for its whole life. A removed node is a NaN-position tombstone,
 * and a re-added id is restored at its old index. The getters return copies.
 */
export class BufferStore {
  /** Point count, tombstones included. */
  get length(): number {
    return seat('BufferStore.length');
  }

  get positions(): Float32Array {
    return seat('BufferStore.positions');
  }

  get colors(): Float32Array {
    return seat('BufferStore.colors');
  }

  get sizes(): Float32Array {
    return seat('BufferStore.sizes');
  }

  /** A full render: the layout's points, and the payload's nodes for lookup. */
  load(_layout: LayoutResult, _payload: GraphPayload): void {
    seat('BufferStore.load');
  }

  /**
   * Removals first (tombstone), then additions:
   * - a new id is appended;
   * - a tombstoned id is restored in place;
   * - a live id keeps its point and position, and only its node, type and colour are updated.
   * A new or restored point is seeded at its parent's base position (from `parents`) when that
   * parent has a point with a finite position, else at the space centre, plus
   * `(random() - 0.5) * 2 * LINK_DISTANCE` on x and then on y. Its size is `childPointSize` of that
   * parent's size, or of `ROOT_POINT_SIZE` when the parent is not locatable.
   */
  applyDelta(
    _delta: Pick<GraphDelta, 'addedNodes' | 'removedNodeIds'>,
    _parents: ReadonlyMap<string, string>,
    _random: () => number,
  ): void {
    seat('BufferStore.applyDelta');
  }

  /**
   * Copies the simulation's live positions (x, y per point) into the base positions wherever the
   * live pair is finite and the point is not a tombstone. `live` may be shorter than the store.
   */
  syncLive(_live: ArrayLike<number>): void {
    seat('BufferStore.syncLive');
  }

  /** The base positions with NaN for every point whose type is hidden. */
  masked(_hiddenTypes: ReadonlySet<string>): Float32Array {
    return seat('BufferStore.masked');
  }

  /** The live payload node drawn at `index`; undefined for the synthetic root, a tombstone, or out of range. */
  nodeAt(_index: number): GraphNode | undefined {
    return seat('BufferStore.nodeAt');
  }

  /** The live payload node with `id`, drawn or not. */
  node(_id: string): GraphNode | undefined {
    return seat('BufferStore.node');
  }

  /** The point index of a live node; undefined for a tombstone, the synthetic root, or an undrawn id. */
  liveIndex(_id: string): number | undefined {
    return seat('BufferStore.liveIndex');
  }

  /** The type of every point that draws a live node, in index order (no synthetic root, no tombstone). */
  liveTypes(): string[] {
    return seat('BufferStore.liveTypes');
  }
}
