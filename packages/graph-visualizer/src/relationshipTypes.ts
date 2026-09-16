// Legend-only registry for edge (relationship) types — mirrors nodeTypes.ts's
// role for nodes, but is deliberately NOT what colours a rendered link:
// visualizer.ts renders links with `linkColorInterpolateFromEndpoints`, a
// gradient between the two endpoint *node* colours, so an edge type never
// gets its own on-canvas colour. This table only supplies a legend swatch, so
// the relationship legend reads consistently with the node legend beside it.
//
// `GraphEdge.type` is free-form (see contract.ts — `'AST'`, `'CFG'`,
// `'REACHING_DEF'`, …), so unlike NODE_TYPES this can never be exhaustive.
// Extend it when a producer's edge type deserves a curated colour; anything
// else (including an edge with no `type` at all) falls back to
// DEFAULT_RELATIONSHIP_COLOR under the `UNTYPED_RELATIONSHIP_KEY` bucket.
export interface RelationshipTypeDescriptor {
	key: string;
	label: string;
	color: string;
}

export const RELATIONSHIP_TYPES: RelationshipTypeDescriptor[] = [
	// file-watcher's directory/AST containment edges.
	{ key: 'CONTAINS', label: 'Contains', color: '#808080' },
	// cpg-generator's declaration -> symbol edges (toSubgraph).
	{ key: 'DEFINES', label: 'Defines', color: '#DCDCAA' },
	// file-watcher's resolve pass: CALL -> SYMBOL.
	{ key: 'CALLS', label: 'Calls', color: '#CE9178' },
	// file-watcher's resolve pass: IMPORT -> SYMBOL.
	{ key: 'IMPORTS', label: 'Imports', color: '#C586C0' },
	// file-watcher's resolve pass: a call's receiver -> the AST node (e.g. a
	// LOCAL) it's bound by, same file only. Named `RECEIVER` per the project's
	// own ratified CPG schema, not invented here.
	{ key: 'RECEIVER', label: 'Receiver', color: '#B5CEA8' },
	// file-watcher's resolve pass: a call's receiver -> the SYMBOL for its
	// evaluated type. Named `EVAL_TYPE` per the same schema.
	{ key: 'EVAL_TYPE', label: 'Eval type', color: '#4EC9B0' },
];

/**
 * Legend bucket key for an edge with no `type` — distinct from every real type
 * string (which are all non-empty) so it can share the same Map/Set-keyed
 * machinery as a real type instead of needing separate `undefined` handling
 * throughout the legend and visibility code.
 */
export const UNTYPED_RELATIONSHIP_KEY = '';
const UNTYPED_RELATIONSHIP_LABEL = 'Untyped';

// Matches DEFAULT_LINK_COLOR_HEX in nodeTypes.ts — the same neutral used when
// a link's own endpoints don't resolve a colour either.
export const DEFAULT_RELATIONSHIP_COLOR = '#4b4b4b';

const RELATIONSHIP_TYPES_BY_KEY = new Map(RELATIONSHIP_TYPES.map((descriptor) => [descriptor.key, descriptor]));

/** The legend bucket key for an edge — `UNTYPED_RELATIONSHIP_KEY` for one with no `type`. */
export function relationshipKey(type: string | undefined): string {
	return type ?? UNTYPED_RELATIONSHIP_KEY;
}

/** Human-readable legend label for a bucket key, falling back to the raw type string for one not in `RELATIONSHIP_TYPES`. */
export function relationshipLabel(key: string): string {
	if (key === UNTYPED_RELATIONSHIP_KEY) {
		return UNTYPED_RELATIONSHIP_LABEL;
	}
	return RELATIONSHIP_TYPES_BY_KEY.get(key)?.label ?? key;
}

/** Legend swatch colour for a bucket key, falling back to `DEFAULT_RELATIONSHIP_COLOR`. */
export function relationshipColor(key: string): string {
	if (key === UNTYPED_RELATIONSHIP_KEY) {
		return DEFAULT_RELATIONSHIP_COLOR;
	}
	return RELATIONSHIP_TYPES_BY_KEY.get(key)?.color ?? DEFAULT_RELATIONSHIP_COLOR;
}
