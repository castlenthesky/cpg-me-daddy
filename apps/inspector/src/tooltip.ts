// SEAT (U2b.1 part 2a, BMO-35): tooltip text split out of
// 21754b4:packages/graph-visualizer/src/visualizer.ts (showTooltip, showLinkTooltip).

import type { GraphEdge, GraphNode } from '@cpg/model';

/** Vertical clearance between the hovered point's edge (or a link's midpoint) and the tooltip. */
export const TOOLTIP_GAP_PX = 6;

function seat(what: string): never {
  throw new Error(`SEAT: ${what} is not built yet (U2b.1 part 2a)`);
}

/** `TYPE: name` (the id when there is no name), plus the node's resolution, if it has one. */
export function nodeTooltipText(_node: GraphNode): string {
  return seat('nodeTooltipText');
}

/** `Label: source → target` (names when the endpoints are known), plus the edge's resolution. */
export function linkTooltipText(
  _edge: GraphEdge,
  _source: GraphNode | undefined,
  _target: GraphNode | undefined,
): string {
  return seat('linkTooltipText');
}
