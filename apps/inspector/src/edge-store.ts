// REAL (U2b.1 part 2a, BMO-35): ported from 21754b4:packages/graph-visualizer/src/visualizer.ts (edgeKey, edgesByKey, rebuildLinks, pushLinks).

import type { GraphEdge } from '@cpg/model';
import { linkWidthForSizes } from './layout';
import { relationshipKey } from './relationship-types';

export interface LinkBuffers {
  readonly links: Float32Array;
  readonly linkWidths: Float32Array;
  readonly linkEdges: readonly GraphEdge[];
}

/** JSON tuple instead of the archive's literal NULs (check-deps rule 6 bans NUL bytes in source). */
export function edgeKey(edge: GraphEdge): string {
  return JSON.stringify([edge.source, edge.target, edge.type ?? null]);
}

/** The authoritative edge set: links are rebuilt from it, never appended, so an edge draws once. */
export class EdgeStore {
  private edges = new Map<string, GraphEdge>();

  get size(): number {
    return this.edges.size;
  }

  replace(edges: readonly GraphEdge[]): void {
    const next = new Map<string, GraphEdge>();
    for (const edge of edges) next.set(edgeKey(edge), edge);
    this.edges = next;
  }

  apply(removedNodeIds: readonly string[], addedEdges: readonly GraphEdge[]): void {
    if (removedNodeIds.length > 0) {
      const removed = new Set(removedNodeIds);
      for (const [key, edge] of this.edges) {
        if (removed.has(edge.source) || removed.has(edge.target)) this.edges.delete(key);
      }
    }
    for (const edge of addedEdges) this.edges.set(edgeKey(edge), edge);
  }

  build(indexOf: (id: string) => number | undefined, sizes: ArrayLike<number>): LinkBuffers {
    const links: number[] = [];
    const linkWidths: number[] = [];
    const linkEdges: GraphEdge[] = [];
    for (const edge of this.edges.values()) {
      const source = indexOf(edge.source);
      const target = indexOf(edge.target);
      if (source === undefined || target === undefined) continue;
      links.push(source, target);
      linkWidths.push(linkWidthForSizes(Number(sizes[source]), Number(sizes[target])));
      linkEdges.push(edge);
    }
    return {
      links: new Float32Array(links),
      linkWidths: new Float32Array(linkWidths),
      linkEdges,
    };
  }
}

export function visibleLinks(all: LinkBuffers, hidden: ReadonlySet<string>): LinkBuffers {
  if (hidden.size === 0) return all;
  const links: number[] = [];
  const linkWidths: number[] = [];
  const linkEdges: GraphEdge[] = [];
  for (const [i, edge] of all.linkEdges.entries()) {
    if (hidden.has(relationshipKey(edge.type))) continue;
    links.push(Number(all.links[i * 2]), Number(all.links[i * 2 + 1]));
    linkWidths.push(Number(all.linkWidths[i]));
    linkEdges.push(edge);
  }
  return {
    links: new Float32Array(links),
    linkWidths: new Float32Array(linkWidths),
    linkEdges,
  };
}
