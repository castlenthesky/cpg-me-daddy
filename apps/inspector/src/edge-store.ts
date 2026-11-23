// SEAT (U2b.1 part 2a, BMO-35): the authoritative edge set split out of
// 21754b4:packages/graph-visualizer/src/visualizer.ts (edgeKey, edgesByKey, rebuildLinks, pushLinks).

import type { GraphEdge } from '@cpg/model';

/** Link buffers in one order: a point-index pair, a width and the source edge per link. */
export interface LinkBuffers {
  readonly links: Float32Array;
  readonly linkWidths: Float32Array;
  readonly linkEdges: readonly GraphEdge[];
}

function seat(what: string): never {
  throw new Error(`SEAT: ${what} is not built yet (U2b.1 part 2a)`);
}

/** An edge's identity: source, target and type. Two edges with the same three are one edge. */
export function edgeKey(_edge: GraphEdge): string {
  return seat('edgeKey');
}

/**
 * The renderer's edge set, keyed by `edgeKey`. Links are always rebuilt from it, never appended,
 * so an edge is drawn once however often it arrives, and dies with either endpoint.
 */
export class EdgeStore {
  /** Distinct edges held, including any whose endpoints are not drawn. */
  get size(): number {
    return seat('EdgeStore.size');
  }

  /** A full render: the set becomes `edges`, deduplicated by key. */
  replace(_edges: readonly GraphEdge[]): void {
    seat('EdgeStore.replace');
  }

  /** A delta: drop every edge touching a removed id, then add `addedEdges`. */
  apply(_removedNodeIds: readonly string[], _addedEdges: readonly GraphEdge[]): void {
    seat('EdgeStore.apply');
  }

  /**
   * Link buffers in insertion order. An edge whose endpoint has no index is skipped. A width is
   * `linkWidthForSizes` of its endpoints' sizes.
   */
  build(_indexOf: (id: string) => number | undefined, _sizes: ArrayLike<number>): LinkBuffers {
    return seat('EdgeStore.build');
  }
}

/** The links whose relationship key (`relationshipKey(edge.type)`) is not hidden, in order. */
export function visibleLinks(_all: LinkBuffers, _hidden: ReadonlySet<string>): LinkBuffers {
  return seat('visibleLinks');
}
