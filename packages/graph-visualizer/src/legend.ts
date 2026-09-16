import { NODE_TYPES } from './nodeTypes';
import { relationshipColor, relationshipLabel } from './relationshipTypes';

export function countByType(types: string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const type of types) {
		counts.set(type, (counts.get(type) ?? 0) + 1);
	}
	return counts;
}

/** One legend row: a colour swatch, a `label (count)`, and a click target that reports `key` to `onToggle`. Shared by `buildLegend` (node types) and `buildRelationshipLegend` (edge types) so both legends look and behave alike. */
function appendLegendItem(legendEl: HTMLElement, key: string, label: string, count: number, color: string, hidden: boolean, onToggle: (key: string) => void): void {
	const item = document.createElement('button');
	item.type = 'button';
	item.className = 'legend-item';
	item.setAttribute('aria-pressed', String(!hidden));
	item.title = `Click to ${hidden ? 'show' : 'hide'} ${label.toLowerCase()}`;

	const swatch = document.createElement('span');
	swatch.className = 'legend-swatch';
	swatch.style.background = color;

	const labelEl = document.createElement('span');
	labelEl.className = 'legend-label';
	labelEl.textContent = `${label} (${count})`;

	item.append(swatch, labelEl);
	item.addEventListener('click', () => onToggle(key));
	legendEl.appendChild(item);
}

/**
 * (Re)builds the legend into `legendEl` from the node types actually present
 * in the currently rendered graph. `onToggle` is called with a node-type key
 * when its swatch is clicked; the caller owns hidden/shown state (see
 * `GraphVisualizer.toggleNodeType`) so a re-render can recompute counts
 * without losing it.
 */
export function buildLegend(legendEl: HTMLElement, types: string[], hiddenTypes: ReadonlySet<string>, onToggle: (type: string) => void): void {
	const counts = countByType(types);
	legendEl.innerHTML = '';
	for (const nodeType of NODE_TYPES) {
		const count = counts.get(nodeType.key) ?? 0;
		if (count === 0) {
			continue;
		}
		appendLegendItem(legendEl, nodeType.key, nodeType.label, count, nodeType.color, hiddenTypes.has(nodeType.key), onToggle);
	}
}

/**
 * (Re)builds the relationship (edge type) legend into `legendEl`. Unlike
 * `buildLegend`, there's no fixed table to iterate — `GraphEdge.type` is
 * free-form (see contract.ts), so the rows are derived from whatever types
 * are actually present in `edgeTypes` (one entry per edge, already normalized
 * through `relationshipKey` — an edge with no `type` groups under the
 * `UNTYPED_RELATIONSHIP_KEY` bucket). Sorted alphabetically so row order
 * doesn't reshuffle as edges come and go across deltas.
 */
export function buildRelationshipLegend(legendEl: HTMLElement, edgeTypeKeys: string[], hiddenTypes: ReadonlySet<string>, onToggle: (type: string) => void): void {
	const counts = countByType(edgeTypeKeys);
	legendEl.innerHTML = '';
	for (const key of [...counts.keys()].sort()) {
		const count = counts.get(key) ?? 0;
		if (count === 0) {
			continue;
		}
		appendLegendItem(legendEl, key, relationshipLabel(key), count, relationshipColor(key), hiddenTypes.has(key), onToggle);
	}
}
