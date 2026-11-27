// REAL (U2b.1 part 1, BMO-35): ported from 21754b4:packages/graph-visualizer/src/layout.ts.
// Seeded radial seed layout: a fresh mulberry32 generator per `layoutPayload` call drives both
// jitter draws so identical payloads and seeds produce byte-identical `Float32Array` buffers.

import type { GraphEdge, GraphNode, GraphPayload } from '@cpg/model';
import { DEFAULT_NODE_COLOR, NODE_TYPE_COLORS } from './node-types';

// Must match the Graph's simulationLinkDistance in the renderer (U2b part 2) —
// the layout and the link-spring force should agree on roughly how far apart
// connected points belong, or the simulation fights its own starting layout.
export const LINK_DISTANCE: number = 20;

export const SPACE_SIZE: number = 4096;
// cosmos.gl's gravity force always pulls toward (spaceSize/2, spaceSize/2)
// (see the forceGravity shader) — the seed layout below is built around this
// same point, so gravity has nothing dramatic to do on the very first tick.
const SPACE_CENTER = SPACE_SIZE / 2;
// Radial spacing per tree depth: one link-length, or enough arc length for
// that depth's sibling count to avoid overlap — whichever is larger.
const RING_STEP = LINK_DISTANCE;
const MIN_ARC = 12;
// Small per-node jitter so the seed isn't a fully pre-solved layout — the
// simulation (once actually running) then has real work to do settling it,
// instead of sitting at a stable configuration with nothing to visibly
// resolve. Radius varies by this fraction; angle varies within this fraction
// of the node's own angular slice (well short of a neighbor's slice, to
// avoid gross sibling overlap).
const RADIUS_JITTER = 0.1;
const ANGLE_JITTER = 0.6;
// Radial layouts must stay well inside [0, SPACE_SIZE]: the position shader
// clamps every coordinate to that range, and a point actually clamped
// becomes coincident with every other clamped point — reintroducing the same
// many-body repulsion spike this whole layout exists to avoid. The division
// reserves headroom for RADIUS_JITTER, so a jittered outer-ring point still
// can't reach the clamp.
const MAX_RADIUS = (SPACE_CENTER * 0.9) / (1 + RADIUS_JITTER);

// Point sizing: the root (or, with multiple roots, the synthetic centre — see
// VIRTUAL_ROOT_ID below) renders largest; every child shrinks by a fixed
// fraction of its own parent's size, down to a floor so leaves stay visible
// in deep trees. Multiplicative (rather than depth * step) so a delta-added
// node in the renderer (U2b part 2, which has no layout pass to hand it a
// depth) can size itself the same way — off its parent's already-known size.
export const ROOT_POINT_SIZE: number = 20;
const POINT_SIZE_FALLOFF = 0.88;
const MIN_POINT_SIZE = 4;

/** A child's point size given its parent's — see the sizing comment above. */
export function childPointSize(parentSize: number): number {
  return Math.max(MIN_POINT_SIZE, parentSize * POINT_SIZE_FALLOFF);
}

// Link width mirrors the size of the two points it connects (so edges taper
// the same way the tree does) without overpowering either endpoint — tuned
// so the widest edges (near the root) render comfortably thicker than
// cosmos.gl's own linkDefaultWidth of 1, tapering down from there.
const LINK_WIDTH_TO_POINT_SIZE_RATIO = 0.2;

/** A link's width given the point sizes of its two endpoints. */
export function linkWidthForSizes(sizeA: number, sizeB: number): number {
  return ((sizeA + sizeB) / 2) * LINK_WIDTH_TO_POINT_SIZE_RATIO;
}

// Synthetic node id used only when a payload has more than one root (see
// buildHierarchy below) — placed at the space centre so the real roots can
// still be laid out radially around it. Built with `String.fromCharCode(0)` so
// no literal NUL byte sits in source (check-deps rule 6) while still carrying
// U+0000: by C-MODEL I-3 no real id contains U+0000, so it can never collide
// with a payload node and is never the reserved `'__root__'`.
const VIRTUAL_ROOT_ID = String.fromCharCode(0) + 'inspector/virtual-root';
const VIRTUAL_ROOT_TYPE = '__root__';

/** Which end of an edge is the parent of the other end when the layout places a point. */
export type ParentEnd = 'source' | 'target';

/** One row of a parent table: an edge type, and which of its two ends is the parent. */
export interface ParentRule {
  readonly type: string;
  readonly parent: ParentEnd;
}

/**
 * Where a point goes: beside its parent, found through these rows (BMO-100, controller decision
 * 103). The same table places a full payload (`layoutPayload`) and a delta's new points
 * (`deltaParents`), so a point a delta adds lands where a full layout would have put it.
 *
 * - `hierarchy`: containment. A node takes its parent from the first row, in this order, that has
 *   an edge naming it as the child; within a row, the first such edge in edge order.
 * - `fallback`: layout anchors, not containment. Only a node no hierarchy row placed may take one,
 *   again first row first; the anchor must itself have a parent, and the adoption must close no
 *   cycle (`buildHierarchy`'s second pass).
 */
export interface ParentTable {
  readonly hierarchy: readonly ParentRule[];
  readonly fallback: readonly ParentRule[];
}

/**
 * Default parent table (BMO-100, controller decision 103): filesystem and code-tier containment in
 * `hierarchy` (`SOURCE_FILE` and `IN_SCOPE` point from child to parent, so their parent end is
 * `'target'`), then symbol-reference anchors in `fallback`. First matching row wins in this order.
 * Every fallback edge points at a SYMBOL (`packages/model/src/schema/edges.ts`), the one node type no
 * hierarchy row places, so each fallback's parent end is its source: the declaration, IMPORT, CALL
 * or TYPE_DECL that the hierarchy rows already placed.
 */
export const DEFAULT_PARENT_TABLE: ParentTable = {
  hierarchy: [
    { type: 'HAS_ENTRY', parent: 'source' },
    { type: 'DECLARES', parent: 'source' },
    { type: 'HAS_PARAM', parent: 'source' },
    { type: 'SOURCE_FILE', parent: 'target' },
    { type: 'IN_SCOPE', parent: 'target' },
  ],
  fallback: [
    { type: 'DEFINES', parent: 'source' },
    { type: 'IMPORTS', parent: 'source' },
    { type: 'CALLS', parent: 'source' },
    { type: 'INHERITS_FROM', parent: 'source' },
  ],
};

export interface LayoutOptions {
  /** Required: the only source of jitter. The same payload and seed give byte-identical buffers. */
  readonly seed: number;
  /** The rows that find each point's parent; default `DEFAULT_PARENT_TABLE`. */
  readonly parentTable?: ParentTable;
}

export interface LayoutResult {
  /** x, y per point. */
  readonly positions: Float32Array;
  /** r, g, b, a per point. */
  readonly colors: Float32Array;
  /** Point-index pairs. */
  readonly links: Float32Array;
  /** Node type per point. */
  readonly types: readonly string[];
  /** Node id per point, parallel to positions/colors/types. */
  readonly ids: readonly string[];
  /** Point size per point. */
  readonly sizes: Float32Array;
  /** Width per link (one entry per pair in `links`). */
  readonly linkWidths: Float32Array;
}

interface Hierarchy {
  readonly nodesById: ReadonlyMap<string, GraphNode>;
  // child ids per parent id, including the synthetic root when present
  readonly childrenOf: ReadonlyMap<string, readonly string[]>;
  readonly rootId: string;
}

interface PlacementState {
  readonly hierarchy: Hierarchy;
  readonly weights: ReadonlyMap<string, number>;
  readonly radii: readonly number[];
  readonly random: () => number;
  readonly positions: number[];
  readonly colors: number[];
  readonly links: number[];
  readonly types: string[];
  readonly ids: string[];
  readonly sizes: number[];
}

/** Deterministic mulberry32 PRNG in [0, 1), seeded with `seed >>> 0`. */
export function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The parent and the child `rule` reads off `edge` (the caller has matched `edge.type`). */
export function edgeEnds(
  edge: GraphEdge,
  rule: ParentRule,
): readonly [parent: string, child: string] {
  return rule.parent === 'source' ? [edge.source, edge.target] : [edge.target, edge.source];
}

/**
 * Derives a tree from `table.hierarchy` (in row order, then `payload.edges`
 * order per row) for seeding the radial layout below. Each rule names which
 * end of a matching edge is the parent and adopts the other end when it does
 * not yet have a parent; a node with no parent after both passes is a root.
 * Multiple roots are placed as children of a synthetic centre node so the
 * single-root case is laid out without a synthetic point.
 *
 * A second pass then adopts still-parentless nodes via `table.fallback` (in
 * row order, then `payload.edges` order per row). That exists for `SYMBOL`
 * nodes, which by design have no hierarchy edge — no file owns them, because a
 * file that owned one could sweep it on re-parse and take other files' edges
 * with it. Without the adoption every symbol would be a root, which would force
 * the synthetic-centre path and render a 20px grey dot with no tooltip at the
 * middle of the graph. With it, a symbol lands beside the first anchored node
 * that defines or references it, so a cross-file reference reads as a chord
 * between two file clusters — which is the entire point of drawing them.
 */
function buildHierarchy(payload: GraphPayload, table: ParentTable): Hierarchy {
  const nodesById = new Map(payload.nodes.map((node) => [node.id, node]));
  const childrenOf = new Map<string, string[]>();
  const hasParent = new Set<string>();
  const parentOf = new Map<string, string>();

  const adopt = (parentId: string, childId: string): void => {
    hasParent.add(childId);
    parentOf.set(childId, parentId);
    const children = childrenOf.get(parentId);
    if (children) {
      children.push(childId);
    } else {
      childrenOf.set(parentId, [childId]);
    }
  };

  for (const rule of table.hierarchy) {
    for (const edge of payload.edges) {
      if (edge.type !== rule.type) continue;
      const [parentId, childId] = edgeEnds(edge, rule);
      if (!nodesById.has(parentId) || !nodesById.has(childId)) continue;
      if (hasParent.has(childId)) continue; // first parent wins
      adopt(parentId, childId);
    }
  }

  for (const rule of table.fallback) {
    for (const edge of payload.edges) {
      if (edge.type !== rule.type) continue;
      const [parentId, childId] = edgeEnds(edge, rule);
      if (hasParent.has(childId)) continue; // a real hierarchy parent or earlier row always wins
      if (!nodesById.has(parentId) || !nodesById.has(childId)) continue;
      // The anchor must itself be placed, or a chain of fallback adoptions
      // could hang off a node that never gets a position.
      if (!hasParent.has(parentId)) continue;
      if (wouldCycle(parentId, childId, parentOf)) continue;
      adopt(parentId, childId);
    }
  }

  let roots = payload.nodes.map((node) => node.id).filter((id) => !hasParent.has(id));
  // A hierarchy that (via a cycle) leaves every node with a parent would
  // otherwise yield an empty root set and render nothing — clear `childrenOf`
  // so the cycle is dropped and every node becomes a root (a leaf of the
  // synthetic centre, or the lone root when the payload has one node).
  if (roots.length === 0 && payload.nodes.length > 0) {
    childrenOf.clear();
    roots = payload.nodes.map((node) => node.id);
  }

  const singleRoot = roots.length === 1 ? roots[0] : undefined;
  if (singleRoot !== undefined) {
    return { nodesById, childrenOf, rootId: singleRoot };
  }
  childrenOf.set(VIRTUAL_ROOT_ID, roots);
  return { nodesById, childrenOf, rootId: VIRTUAL_ROOT_ID };
}

/**
 * Whether making `parentId` the parent of `childId` would close a loop —
 * i.e. `parentId` already descends from `childId`.
 *
 * The hierarchy pass can't create a cycle (first parent wins, and every node
 * gets at most one), but the fallback pass adopts along edges that carry no
 * tree guarantee, so it has to check. An unbounded walk is safe here because
 * `parentOf` is single-parent by construction, and the visited set guards
 * against a pre-existing cycle rather than one this would create.
 */
function wouldCycle(
  parentId: string,
  childId: string,
  parentOf: ReadonlyMap<string, string>,
): boolean {
  const visited = new Set<string>();
  let current: string | undefined = parentId;
  while (current !== undefined && !visited.has(current)) {
    if (current === childId) return true;
    visited.add(current);
    current = parentOf.get(current);
  }
  return false;
}

// First pass: per-node leaf-count "weight" (so wide subtrees get a
// proportionally wider angular slice) and a running count of nodes at each
// depth (so each ring gets enough radius to fit its members without overlap).
function buildWeights(
  id: string,
  childrenOf: ReadonlyMap<string, readonly string[]>,
  weights: Map<string, number>,
  depth: number,
  countAtDepth: number[],
): number {
  countAtDepth[depth] = (countAtDepth[depth] ?? 0) + 1;
  const children = childrenOf.get(id) ?? [];
  let weight = 0;
  for (const child of children) {
    weight += buildWeights(child, childrenOf, weights, depth + 1, countAtDepth);
  }
  weight = Math.max(1, weight);
  weights.set(id, weight);
  return weight;
}

function computeRadii(countAtDepth: readonly number[]): number[] {
  const radii: number[] = [0];
  let previous = 0;
  for (const count of countAtDepth.slice(1)) {
    const arcRadius = (count * MIN_ARC) / (Math.PI * 2);
    previous = Math.max(previous + RING_STEP, arcRadius);
    radii.push(previous);
  }
  if (previous > MAX_RADIUS) {
    const scale = MAX_RADIUS / previous;
    return radii.map((radius) => radius * scale);
  }
  return radii;
}

// Second pass: place each node at the midpoint of the angular slice it was
// given, splitting that slice among its children in proportion to their
// weight. The root gets the full circle at radius 0, so it lands exactly on
// SPACE_CENTER regardless of angle. `links` here carries only the hierarchy
// edges actually used for placement (including any synthetic-root ones) —
// the remaining, non-hierarchy edges are unioned in separately by
// layoutPayload once every node has an index.
function placeNode(
  id: string,
  parentIndex: number | undefined,
  depth: number,
  angleStart: number,
  angleEnd: number,
  parentSize: number | undefined,
  state: PlacementState,
): void {
  const index = state.positions.length / 2;
  const span = angleEnd - angleStart;
  const angle = (angleStart + angleEnd) / 2 + (state.random() - 0.5) * span * ANGLE_JITTER;
  const radius = (state.radii[depth] ?? 0) * (1 + (state.random() - 0.5) * 2 * RADIUS_JITTER);
  state.positions.push(
    SPACE_CENTER + Math.cos(angle) * radius,
    SPACE_CENTER + Math.sin(angle) * radius,
  );

  const node = state.hierarchy.nodesById.get(id);
  const type = node?.type ?? VIRTUAL_ROOT_TYPE;
  state.colors.push(...(NODE_TYPE_COLORS.get(type) ?? DEFAULT_NODE_COLOR));
  state.types.push(type);
  state.ids.push(id);
  const size = parentSize === undefined ? ROOT_POINT_SIZE : childPointSize(parentSize);
  state.sizes.push(size);
  if (parentIndex !== undefined) {
    state.links.push(parentIndex, index);
  }

  const children = state.hierarchy.childrenOf.get(id) ?? [];
  if (children.length === 0) {
    return;
  }
  const totalWeight = state.weights.get(id) ?? children.length;
  let cursor = angleStart;
  for (const child of children) {
    const childSpan = span * ((state.weights.get(child) ?? 1) / totalWeight);
    placeNode(child, index, depth + 1, cursor, cursor + childSpan, size, state);
    cursor += childSpan;
  }
}

/**
 * Lays out a `GraphPayload` for cosmos.gl: a seeded radial position per node
 * (see the constants and passes above), a colour per node from `node-types.ts`,
 * and a link (point-index pair) for every edge in the payload — not just the
 * `parentTable.hierarchy` edges used to seed the layout. For a payload with a
 * single root and only hierarchy-row edges this reproduces the original
 * single-tree layout.
 */
export function layoutPayload(payload: GraphPayload, options: LayoutOptions): LayoutResult {
  const { seed, parentTable = DEFAULT_PARENT_TABLE } = options;
  const hierarchy = buildHierarchy(payload, parentTable);

  const weights = new Map<string, number>();
  const countAtDepth: number[] = [];
  buildWeights(hierarchy.rootId, hierarchy.childrenOf, weights, 0, countAtDepth);
  const radii = computeRadii(countAtDepth);

  const state: PlacementState = {
    hierarchy,
    weights,
    radii,
    random: createMulberry32(seed),
    positions: [],
    colors: [],
    links: [],
    types: [],
    ids: [],
    sizes: [],
  };
  placeNode(hierarchy.rootId, undefined, 0, 0, Math.PI * 2, undefined, state);

  const indexById = new Map(state.ids.map((id, index) => [id, index]));
  const hierarchyEdgeTypes = new Set(parentTable.hierarchy.map((rule) => rule.type));
  unionNonHierarchyLinks(payload.edges, hierarchyEdgeTypes, indexById, state.links);

  const linkWidths = buildLinkWidths(state.links, state.sizes);

  return {
    positions: new Float32Array(state.positions),
    colors: new Float32Array(state.colors),
    links: new Float32Array(state.links),
    types: state.types,
    ids: state.ids,
    sizes: new Float32Array(state.sizes),
    linkWidths,
  };
}

/**
 * Per-link width, derived from the two endpoints' point sizes (see
 * linkWidthForSizes above) — covers every link in `links`, hierarchy and
 * non-hierarchy alike, since both are already unioned into that one flat
 * array by the time this runs. Link *colour* needs no equivalent here: it's
 * rendered as a live gradient straight from the two endpoints' point colours
 * (see `linkColorInterpolateFromEndpoints` in the renderer, U2b part 2) rather
 * than a value computed and stored per link.
 */
function buildLinkWidths(links: readonly number[], sizes: readonly number[]): Float32Array {
  const linkWidths: number[] = [];
  for (let i = 0; i < links.length; i += 2) {
    const sourceIndex = links[i] ?? 0;
    const targetIndex = links[i + 1] ?? 0;
    linkWidths.push(linkWidthForSizes(sizes[sourceIndex] ?? 0, sizes[targetIndex] ?? 0));
  }
  return new Float32Array(linkWidths);
}

function unionNonHierarchyLinks(
  edges: readonly GraphEdge[],
  hierarchyEdgeTypes: ReadonlySet<string>,
  indexById: ReadonlyMap<string, number>,
  links: number[],
): void {
  for (const edge of edges) {
    // A hierarchy-row edge is already carried by the tree walk above, or placed nothing.
    if (edge.type !== undefined && hierarchyEdgeTypes.has(edge.type)) continue;
    const sourceIndex = indexById.get(edge.source);
    const targetIndex = indexById.get(edge.target);
    if (sourceIndex === undefined || targetIndex === undefined) continue;
    links.push(sourceIndex, targetIndex);
  }
}
