// REAL (U2b.1 part 1, BMO-35): ported from 21754b4:packages/graph-visualizer/src/relationshipTypes.ts.
//
// Legend-only registry for edge (relationship) types — mirrors node-types.ts's
// role for nodes, but is deliberately NOT what colours a rendered link: the
// renderer (U2b part 2) draws links with `linkColorInterpolateFromEndpoints`,
// a gradient between the two endpoint *node* colours, so an edge type never
// gets its own on-canvas colour. This table only supplies a legend swatch, so
// the relationship legend reads consistently with the node legend beside it.
//
// `GraphEdge.type` is free-form (see `@cpg/model` and the schema in
// `packages/model/src/schema`, `docs/outline/04-schema.yaml`), so unlike
// NODE_TYPES this can never be exhaustive. Extend it when a producer's edge
// type deserves a curated colour; anything else (including an edge with no
// `type` at all) falls back to DEFAULT_RELATIONSHIP_COLOR under the
// `UNTYPED_RELATIONSHIP_KEY` bucket.
//
// Differences from the archive table, aligned with the schema:
// - `CONTAINS` became `HAS_ENTRY`: the schema renamed directory/file containment
//   to `HAS_ENTRY` and reserves `CONTAINS` for Joern's opposite meaning.
// - `RECEIVER` was dropped because it is not an edge type in the schema.
// - The archive's receiver-type edge row was dropped because that edge is
//   reserved until U8 (`packages/model/src/schema/reserved.ts`).

export interface RelationshipTypeDescriptor {
  readonly key: string;
  readonly label: string;
  readonly color: string;
}

export const RELATIONSHIP_TYPES: readonly RelationshipTypeDescriptor[] = [
  // Directory/file hierarchy edges (renamed from the archive's CONTAINS).
  { key: 'HAS_ENTRY', label: 'Has entry', color: '#808080' },
  // Declaration -> symbol edges.
  { key: 'DEFINES', label: 'Defines', color: '#DCDCAA' },
  // Call resolution edges: CALL -> SYMBOL.
  { key: 'CALLS', label: 'Calls', color: '#CE9178' },
  // Import resolution edges: IMPORT -> SYMBOL.
  { key: 'IMPORTS', label: 'Imports', color: '#C586C0' },
  // MODULE -> its FILE; the swatch is its from-end's colour.
  { key: 'SOURCE_FILE', label: 'Source file', color: '#B5CEA8' },
];

/**
 * Legend bucket key for an edge with no `type` — distinct from every real type
 * string (which are all non-empty) so it can share the same Map/Set-keyed
 * machinery as a real type instead of needing separate `undefined` handling
 * throughout the legend and visibility code.
 */
export const UNTYPED_RELATIONSHIP_KEY: string = '';
const UNTYPED_RELATIONSHIP_LABEL = 'Untyped';

// Matches DEFAULT_LINK_COLOR_HEX in node-types.ts — the same neutral used when
// a link's own endpoints don't resolve a colour either.
export const DEFAULT_RELATIONSHIP_COLOR: string = '#4b4b4b';

const RELATIONSHIP_TYPES_BY_KEY = new Map(
  RELATIONSHIP_TYPES.map((descriptor) => [descriptor.key, descriptor]),
);

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
