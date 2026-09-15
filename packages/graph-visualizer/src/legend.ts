import { NODE_TYPES } from './nodeTypes';

export function countByType(types: string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const type of types) {
		counts.set(type, (counts.get(type) ?? 0) + 1);
	}
	return counts;
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
		const hidden = hiddenTypes.has(nodeType.key);

		const item = document.createElement('button');
		item.type = 'button';
		item.className = 'legend-item';
		item.setAttribute('aria-pressed', String(!hidden));
		item.title = `Click to ${hidden ? 'show' : 'hide'} ${nodeType.label.toLowerCase()}`;

		const swatch = document.createElement('span');
		swatch.className = 'legend-swatch';
		swatch.style.background = nodeType.color;

		const label = document.createElement('span');
		label.className = 'legend-label';
		label.textContent = `${nodeType.label} (${count})`;

		item.append(swatch, label);
		item.addEventListener('click', () => onToggle(nodeType.key));
		legendEl.appendChild(item);
	}
}
