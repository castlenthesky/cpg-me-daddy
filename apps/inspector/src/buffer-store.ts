// REAL (U2b.1 part 2a, BMO-35): ported from 21754b4:packages/graph-visualizer/src/visualizer.ts (renderInternal, applyDeltaInternal, seedPosition, maskHidden, applyVisibility).

import type { GraphDelta, GraphEdge, GraphNode, GraphPayload } from '@cpg/model';
import {
  childPointSize,
  LINK_DISTANCE,
  ROOT_POINT_SIZE,
  SPACE_SIZE,
  edgeEnds,
  type LayoutResult,
  type ParentTable,
} from './layout';
import {
  hexToRgba,
  nodeTypeColor,
  REGISTRY_NODE_COLORS,
  type NodeColors,
  type Rgba,
} from './node-types';

const SPACE_CENTER = SPACE_SIZE / 2;

function isFiniteNumber(value: number | undefined): value is number {
  return Number.isFinite(value);
}

/**
 * Each delta-added child's parent under `table` (the layout's table, BMO-100): the first row,
 * hierarchy rows then fallback rows, with an edge naming the node as its child; within a row, the
 * first such edge in `addedEdges` order. No anchor or cycle check: a parent that cannot be located
 * seeds at the centre (`BufferStore.applyDelta`).
 */
export function deltaParents(
  addedEdges: readonly GraphEdge[],
  table: ParentTable,
): ReadonlyMap<string, string> {
  const parents = new Map<string, string>();
  for (const rule of [...table.hierarchy, ...table.fallback]) {
    for (const edge of addedEdges) {
      if (edge.type !== rule.type) continue;
      const [parentId, childId] = edgeEnds(edge, rule);
      if (!parents.has(childId)) {
        parents.set(childId, parentId);
      }
    }
  }
  return parents;
}

/**
 * Per-point buffers, parallel by index. A point keeps its index for life: a removed node is a NaN
 * tombstone and a re-added id is restored in place. The getters return copies.
 */
export class BufferStore {
  private ids: string[] = [];
  private types: string[] = [];
  private basePositions: number[] = [];
  private baseColors: number[] = [];
  private baseSizes: number[] = [];
  private indexById = new Map<string, number>();
  private nodes = new Map<string, GraphNode>();
  private nodeColors: NodeColors = REGISTRY_NODE_COLORS;

  get length(): number {
    return this.ids.length;
  }

  get positions(): Float32Array {
    return new Float32Array(this.basePositions);
  }

  get colors(): Float32Array {
    return new Float32Array(this.baseColors);
  }

  get sizes(): Float32Array {
    return new Float32Array(this.baseSizes);
  }

  load(layout: LayoutResult, payload: GraphPayload): void {
    this.ids = [...layout.ids];
    this.types = [...layout.types];
    this.basePositions = Array.from(layout.positions);
    this.baseColors = Array.from(layout.colors);
    this.baseSizes = Array.from(layout.sizes);
    this.indexById = new Map(layout.ids.map((id, index) => [id, index]));
    this.nodes = new Map(payload.nodes.map((node) => [node.id, node]));
  }

  applyDelta(
    delta: Pick<GraphDelta, 'addedNodes' | 'removedNodeIds'>,
    parents: ReadonlyMap<string, string>,
    random: () => number,
  ): void {
    for (const id of delta.removedNodeIds) {
      // Delete from `nodes` even when unplaced, fixing the archive skipping before delete.
      this.nodes.delete(id);
      const index = this.indexById.get(id);
      if (index !== undefined) {
        this.basePositions[index * 2] = NaN;
        this.basePositions[index * 2 + 1] = NaN;
      }
    }

    const addedById = new Map<string, GraphNode>();
    for (const node of delta.addedNodes) {
      if (!addedById.has(node.id)) addedById.set(node.id, node);
    }
    const handled = new Set<GraphNode>();
    const visit = (node: GraphNode): void => {
      if (handled.has(node)) return;
      handled.add(node);
      const parentId = parents.get(node.id);
      const parentNode = parentId === undefined ? undefined : addedById.get(parentId);
      if (parentNode !== undefined) visit(parentNode);
      this.addNode(node, parentId, random);
    };
    for (const node of delta.addedNodes) {
      visit(node);
    }
  }

  /**
   * Gives every point its type's colour under `colors` (nodeTypeColor), and colours what later
   * deltas add the same way. Positions and sizes are untouched, and `load` still takes its layout's.
   */
  recolour(colors: NodeColors): void {
    this.nodeColors = colors;
    for (const [index, type] of this.types.entries()) {
      this.writeColor(index, hexToRgba(nodeTypeColor(colors, type)));
    }
  }

  /** Copies finite live positions into finite base slots so tombstones are never lifted. */
  syncLive(live: ArrayLike<number>): void {
    const count = Math.min(this.ids.length, Math.floor(live.length / 2));
    for (let i = 0; i < count; i++) {
      const xi = i * 2;
      const yi = xi + 1;
      const lx = live[xi];
      const ly = live[yi];
      if (
        isFiniteNumber(lx) &&
        isFiniteNumber(ly) &&
        isFiniteNumber(this.basePositions[xi]) &&
        isFiniteNumber(this.basePositions[yi])
      ) {
        this.basePositions[xi] = lx;
        this.basePositions[yi] = ly;
      }
    }
  }

  masked(hiddenTypes: ReadonlySet<string>): Float32Array {
    const next = new Float32Array(this.basePositions);
    if (hiddenTypes.size === 0) return next;
    for (const [i, type] of this.types.entries()) {
      if (hiddenTypes.has(type)) {
        next[i * 2] = NaN;
        next[i * 2 + 1] = NaN;
      }
    }
    return next;
  }

  nodeAt(index: number): GraphNode | undefined {
    const id = this.ids[index];
    return id === undefined ? undefined : this.nodes.get(id);
  }

  node(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  liveIndex(id: string): number | undefined {
    return this.nodes.has(id) ? this.indexById.get(id) : undefined;
  }

  liveTypes(): string[] {
    const result: string[] = [];
    for (const [i, id] of this.ids.entries()) {
      const type = this.types[i];
      if (type !== undefined && this.nodes.has(id)) result.push(type);
    }
    return result;
  }

  private addNode(node: GraphNode, parentId: string | undefined, random: () => number): void {
    const color = hexToRgba(nodeTypeColor(this.nodeColors, node.type));
    const existing = this.indexById.get(node.id);
    if (existing !== undefined && this.nodes.has(node.id)) {
      // A still-live id keeps its position and size (no random draw) and refreshes metadata.
      this.nodes.set(node.id, node);
      this.types[existing] = node.type;
      this.writeColor(existing, color);
      return;
    }

    const [x, y, size] = this.seedPoint(parentId, random);
    this.nodes.set(node.id, node);
    if (existing !== undefined) {
      this.basePositions[existing * 2] = x;
      this.basePositions[existing * 2 + 1] = y;
      this.types[existing] = node.type;
      this.baseSizes[existing] = size;
      this.writeColor(existing, color);
    } else {
      this.indexById.set(node.id, this.ids.length);
      this.ids.push(node.id);
      this.types.push(node.type);
      this.basePositions.push(x, y);
      this.baseColors.push(...color);
      this.baseSizes.push(size);
    }
  }

  /** Requires finite parent coordinates for size as well as position so tombstones never leak size. */
  private seedPoint(
    parentId: string | undefined,
    random: () => number,
  ): readonly [number, number, number] {
    const parentIndex = parentId === undefined ? undefined : this.indexById.get(parentId);
    const px = parentIndex === undefined ? undefined : this.basePositions[parentIndex * 2];
    const py = parentIndex === undefined ? undefined : this.basePositions[parentIndex * 2 + 1];
    const locatable = parentIndex !== undefined && isFiniteNumber(px) && isFiniteNumber(py);
    const originX = locatable ? px : SPACE_CENTER;
    const originY = locatable ? py : SPACE_CENTER;
    const parentSize = locatable ? Number(this.baseSizes[parentIndex]) : ROOT_POINT_SIZE;
    return [
      originX + (random() - 0.5) * 2 * LINK_DISTANCE,
      originY + (random() - 0.5) * 2 * LINK_DISTANCE,
      childPointSize(parentSize),
    ];
  }

  private writeColor(index: number, color: Rgba): void {
    const offset = index * 4;
    this.baseColors[offset] = color[0];
    this.baseColors[offset + 1] = color[1];
    this.baseColors[offset + 2] = color[2];
    this.baseColors[offset + 3] = color[3];
  }
}
