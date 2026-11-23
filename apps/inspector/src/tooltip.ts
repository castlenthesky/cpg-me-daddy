// REAL (U2b.1 part 2a, BMO-35): ported from 21754b4:packages/graph-visualizer/src/visualizer.ts (showTooltip, showLinkTooltip).

import {
  readEdgeResolution,
  readNodeResolution,
  type EdgeResolution,
  type GraphEdge,
  type GraphNode,
  type Read,
} from '@cpg/model';
import { relationshipKey, relationshipLabel } from './relationship-types';

export const TOOLTIP_GAP_PX = 6;

function resolutionSuffix(read: Read<EdgeResolution>): string {
  if (read.state !== 'present') return '';
  const { status, reason } = read.value;
  return ` — ${status}${reason ? ` (${reason})` : ''}`;
}

export function nodeTooltipText(node: GraphNode): string {
  return `${node.type}: ${node.name ?? node.id}${resolutionSuffix(readNodeResolution(node))}`;
}

export function linkTooltipText(
  edge: GraphEdge,
  source: GraphNode | undefined,
  target: GraphNode | undefined,
): string {
  const label = relationshipLabel(relationshipKey(edge.type));
  const sourceLabel = source?.name ?? edge.source;
  const targetLabel = target?.name ?? edge.target;
  return `${label}: ${sourceLabel} → ${targetLabel}${resolutionSuffix(readEdgeResolution(edge))}`;
}
