/**
 * `applyGraphDelta`: folds one `GraphDelta` into a `GraphPayload`, gated on seq (I-10) and merging
 * re-added node ids by per-property owner (DQ-01c) instead of appending a duplicate (L-01).
 *
 * Imports from `./index` are types only, so there is no runtime cycle with the re-export there.
 */
import type { GraphDelta, GraphNode, GraphPayload } from './index';
import { nodeSpec, type NodeLabelSpec, type PropertyOwner } from './schema';

/**
 * Why a delta was rejected as a whole. `readd-without-removal`: a node id already present (after this
 * delta's removals, including an earlier add in the same delta) is re-added by its own home tier on a
 * label whose `write` is not `'merge-on-key'`. `type-conflict`: a re-add whose `type` differs from the
 * existing node's.
 */
export type DeltaDefectCode = 'readd-without-removal' | 'type-conflict';

export interface DeltaDefect {
  readonly code: DeltaDefectCode;
  readonly nodeId: string;
}

/**
 * The outcome of one apply. `already-applied` returns the input payload by reference; `gap` and
 * `malformed` carry no payload (all-or-nothing, C-SINK INV-10). No outcome mutates either argument.
 */
export type DeltaApplyResult =
  | { readonly outcome: 'applied'; readonly payload: GraphPayload }
  | { readonly outcome: 'already-applied'; readonly payload: GraphPayload }
  | { readonly outcome: 'gap'; readonly expected: number; readonly got: number }
  | { readonly outcome: 'malformed'; readonly defects: readonly [DeltaDefect, ...DeltaDefect[]] };

/**
 * Applies `delta` to `payload`:
 * - seq gate first: `delta.seq === payload.seq + 1` applies (or is malformed); `delta.seq <=
 *   payload.seq` is `already-applied`; anything else (NaN, non-integer, ahead by more than one) is `gap`.
 * - removals before additions (I-5); edges touching a removed id are dropped (I-8); added edges are
 *   kept even with a missing endpoint (I-9).
 * - a re-added id merges in place: keys the producer's tier owns come from the incoming node, keys
 *   the other tier owns come from the existing node. Unknown labels shallow-merge.
 *
 * Pure: neither argument is mutated.
 */
// REAL
export function applyGraphDelta(payload: GraphPayload, delta: GraphDelta): DeltaApplyResult {
  const expected = payload.seq + 1;
  if (delta.seq <= payload.seq) return { outcome: 'already-applied', payload };
  if (delta.seq !== expected) return { outcome: 'gap', expected, got: delta.seq };

  const removed = new Set(delta.removedNodeIds);
  const nodes: GraphNode[] = payload.nodes.filter((node) => !removed.has(node.id));
  const indexById = new Map<string, number>();
  nodes.forEach((node, index) => indexById.set(node.id, index));

  const defects: DeltaDefect[] = [];
  for (const incoming of delta.addedNodes) {
    const at = indexById.get(incoming.id);
    if (at === undefined) {
      indexById.set(incoming.id, nodes.length);
      nodes.push(incoming);
      continue;
    }
    const existing = nodes[at];
    if (existing === undefined) continue;
    if (existing.type !== incoming.type) {
      defects.push({ code: 'type-conflict', nodeId: incoming.id });
      continue;
    }
    const spec = nodeSpec(incoming.type);
    if (spec === undefined) {
      nodes[at] = shallowMerge(existing, incoming);
      continue;
    }
    const home = homeTier(spec);
    if (spec.write !== 'merge-on-key' && delta.producer === home) {
      defects.push({ code: 'readd-without-removal', nodeId: incoming.id });
      continue;
    }
    nodes[at] = ownerMerge(spec, delta.producer, existing, incoming);
  }

  const [first, ...rest] = defects;
  if (first !== undefined) return { outcome: 'malformed', defects: [first, ...rest] };

  const edges = payload.edges
    .filter((edge) => !removed.has(edge.source) && !removed.has(edge.target))
    .concat(delta.addedEdges);
  return { outcome: 'applied', payload: { seq: delta.seq, nodes, edges } };
}

/** `'filesystem'` for filesystem-class labels, else `'code'` (D2). */
function homeTier(spec: NodeLabelSpec): PropertyOwner {
  return spec.ownership === 'filesystem' ? 'filesystem' : 'code';
}

function withData(
  node: GraphNode,
  name: string | undefined,
  data: Record<string, unknown> | undefined,
): GraphNode {
  return {
    id: node.id,
    type: node.type,
    ...(name !== undefined ? { name } : {}),
    ...(data !== undefined ? { data } : {}),
  };
}

/** Unknown label: no ownership data, so the only non-destructive rule is a shallow merge (D9). */
function shallowMerge(existing: GraphNode, incoming: GraphNode): GraphNode {
  const data =
    existing.data === undefined && incoming.data === undefined
      ? undefined
      : { ...existing.data, ...incoming.data };
  return withData(existing, incoming.name ?? existing.name, data);
}

/** Producer-owned keys come from `incoming`, every other key from `existing` (D6, D15). */
function ownerMerge(
  spec: NodeLabelSpec,
  producer: PropertyOwner,
  existing: GraphNode,
  incoming: GraphNode,
): GraphNode {
  const home = homeTier(spec);
  const ownerOf = (key: string): PropertyOwner =>
    spec.properties.find((property) => property.name === key)?.owner ?? home;

  let data: Record<string, unknown> | undefined;
  if (existing.data !== undefined || incoming.data !== undefined) {
    data = {};
    for (const [key, value] of Object.entries(existing.data ?? {})) {
      if (ownerOf(key) !== producer) data[key] = value;
    }
    for (const [key, value] of Object.entries(incoming.data ?? {})) {
      if (ownerOf(key) === producer) data[key] = value;
    }
  }
  const name = ownerOf('name') === producer ? incoming.name : existing.name;
  return withData(existing, name, data);
}
