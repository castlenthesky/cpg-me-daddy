// Single source of truth for node-type colour, shared by the point-color
// buffer built in `layoutPayload` (layout.ts) and the legend swatches built
// in `buildLegend` (legend.ts) — so the two can never drift apart. Extend
// this table (and nothing else) when CPG node labels beyond file/directory
// start arriving; master's media/graphWebview.js has a ready-made palette
// (METHOD, TYPE_DECL, CALL, …) worth reusing verbatim at that point.
export interface NodeTypeDescriptor {
	key: string;
	label: string;
	color: string;
}

export const NODE_TYPES: NodeTypeDescriptor[] = [
	{ key: 'directory', label: 'Directories', color: '#ff9933' },
	{ key: 'file', label: 'Files', color: '#4db3ff' },
];

export function hexToRgba(hex: string): [number, number, number, number] {
	const value = hex.replace('#', '');
	const r = parseInt(value.substring(0, 2), 16) / 255;
	const g = parseInt(value.substring(2, 4), 16) / 255;
	const b = parseInt(value.substring(4, 6), 16) / 255;
	return [r, g, b, 1];
}

// Points whose type isn't in NODE_TYPES (including the synthetic multi-root
// anchor placeNode introduces — see layout.ts) fall back to this neutral grey
// rather than being dropped.
export const DEFAULT_NODE_COLOR: [number, number, number, number] = [0.6, 0.6, 0.6, 1];

export const NODE_TYPE_COLORS = new Map<string, [number, number, number, number]>(
	NODE_TYPES.map((nodeType) => [nodeType.key, hexToRgba(nodeType.color)])
);

// Shared by visualizer.ts (as the cosmos.gl `linkDefaultColor` config value)
// and layout.ts (as the fallback for an edge whose source node isn't in
// NODE_TYPE_COLORS, e.g. the synthetic multi-root anchor) so the two can't
// drift apart — same rationale as NODE_TYPE_COLORS above.
export const DEFAULT_LINK_COLOR_HEX = '#4b4b4b';
