// REAL (U2b.1 part 2a, BMO-35): ported from 21754b4:packages/graph-visualizer/src/legend.ts (as data rows instead of DOM).

import { NODE_TYPES, nodeTypeColor, REGISTRY_NODE_COLORS, type NodeColors } from './node-types';
import { relationshipColor, relationshipLabel } from './relationship-types';

export interface LegendRow {
  readonly key: string;
  readonly text: string;
  readonly title: string;
  readonly color: string;
  readonly pressed: boolean;
}

function makeRow(
  key: string,
  label: string,
  count: number,
  color: string,
  hidden: boolean,
): LegendRow {
  return {
    key,
    text: `${label} (${count})`,
    title: `Click to ${hidden ? 'show' : 'hide'} ${label.toLowerCase()}`,
    color,
    pressed: !hidden,
  };
}

export function countByType(types: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const type of types) {
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return counts;
}

/**
 * The registered types present, in registry order. Each swatch is its type's colour under `colors`
 * (nodeTypeColor), so the legend and the points cannot drift apart.
 */
export function nodeLegendRows(
  types: readonly string[],
  hidden: ReadonlySet<string>,
  colors: NodeColors = REGISTRY_NODE_COLORS,
): LegendRow[] {
  const counts = countByType(types);
  const rows: LegendRow[] = [];
  for (const nodeType of NODE_TYPES) {
    const count = counts.get(nodeType.key);
    if (count === undefined) continue;
    rows.push(
      makeRow(
        nodeType.key,
        nodeType.label,
        count,
        nodeTypeColor(colors, nodeType.key),
        hidden.has(nodeType.key),
      ),
    );
  }
  return rows;
}

export function relationshipLegendRows(
  edgeTypeKeys: readonly string[],
  hidden: ReadonlySet<string>,
): LegendRow[] {
  const counts = countByType(edgeTypeKeys);
  const rows: LegendRow[] = [];
  for (const [key, count] of [...counts].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    rows.push(makeRow(key, relationshipLabel(key), count, relationshipColor(key), hidden.has(key)));
  }
  return rows;
}
