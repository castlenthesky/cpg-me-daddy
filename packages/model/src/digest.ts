/**
 * The named graph digest (C-SINK Q5): FNV-1a (32-bit) over a sorted projection of the nodes and
 * edges, so two processes holding the same graph agree whatever order they hold it in (INV-15).
 * Spelled `fnv1a32:<8 hex>` so a later algorithm change is visible in the value itself.
 */

import type { GraphPayload } from './index';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  const entries: string[] = [];
  for (const [key, entryValue] of Object.entries(value)) {
    entries.push(`${JSON.stringify(key)}:${canonical(entryValue)}`);
  }
  return `{${entries.toSorted().join(',')}}`;
}

function fnv1a32(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function graphDigest(graph: Pick<GraphPayload, 'nodes' | 'edges'>): string {
  // REAL
  const nodeLines = graph.nodes
    .map(
      (node) =>
        `N:${JSON.stringify(node.id)},${JSON.stringify(node.type)},${canonical(node.name)},${canonical(node.data)}`,
    )
    .toSorted();
  const edgeLines = graph.edges
    .map(
      (edge) =>
        `E:${JSON.stringify(edge.source)},${canonical(edge.type)},${JSON.stringify(edge.target)},${canonical(edge.data)}`,
    )
    .toSorted();
  return fnv1a32([...nodeLines, ...edgeLines].join('\n'));
}
