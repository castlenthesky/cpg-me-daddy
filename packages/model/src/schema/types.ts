/**
 * Types for the v1 CPG schema (M0.0).
 *
 * These interfaces describe the shape of `NODE_LABELS` and `EDGE_TYPES` in
 * `nodes.ts`/`edges.ts`. They carry no data themselves — they exist so the
 * literal arrays there can be checked with `satisfies` while still keeping
 * their literal types (`as const satisfies readonly NodeLabelSpec[]`), which
 * is what lets `NodeLabel`/`EdgeType` be the exact 14/15-member unions rather
 * than plain `string`. A typo'd label then fails `tsc --build`, before it
 * ever reaches the runtime validator in `validate.ts`.
 *
 * Full narrative and the Joern divergence table: docs/outline/04-schema.yaml.
 */

/** How many values a property holds. */
export type Cardinality = 'one' | 'zeroOrOne' | 'list';

/** A property's scalar or list value type. */
export type PropertyType = 'string' | 'int' | 'float' | 'bool' | 'string[]';

/**
 * Who writes this node label or edge type, and therefore what transaction it
 * may appear in. This classification is load-bearing (R6 Next Steps #2,
 * DL7): `overlay` members must never appear inside a per-file replace
 * transaction, which is exactly what `validate.ts`'s overlay-in-replace check
 * enforces.
 */
export type OwnershipClass =
  | 'filesystem' // DIRECTORY, FILE, HAS_ENTRY — walker-owned, mutated on move/rename
  | 'file-owned' // MODULE/TYPE_DECL/METHOD/PARAM/MEMBER/CALL/IMPORT/UNKNOWN + their edges
  | 'identity' // SYMBOL, ALIAS_OF, TAG, TAGGED_BY — cross-file anchor, merged not deleted
  | 'overlay' // COMMUNITY, MEMBER_OF, TARGETS, DEPENDS_ON — async periodic job only
  | 'graph-singleton'; // META_DATA — one per graph, no `file`, never per-file replaced

/** The write mechanism the per-file replace (or its analogue) uses for this class. */
export type WriteMechanism =
  | 'delete-create' // file-owned structural nodes/edges (R6 Next Steps #2)
  | 'merge-on-key' // identity-tier: MERGE on the declared `key`, never deleted wholesale
  | 'overlay-job' // written only by the async periodic overlay job, never inside a replace
  | 'move-rename-only'; // filesystem tier: mutated only when the path itself changes

/** How the golden serializer (M0.6+) treats this property's value. */
export type GoldenPolicy =
  | 'include' // deterministic given fixture content; printed in goldens
  | 'redact' // volatile (timestamps, run ids); never printed, must not churn a golden diff
  | 'exclude'; // dropped from goldens entirely (revision_id: it changes with every fixture edit)

export interface PropertySpec {
  readonly name: string;
  readonly type: PropertyType;
  readonly cardinality: Cardinality;
  /**
   * Present only for enum-valued properties. Always a reference to one of the
   * arrays in `enums.ts` — never a fresh literal array — so that, e.g.,
   * `CALLS.status` and `IMPORTS.status` can be asserted to share one object
   * by `===`, not merely by matching contents (R6: "not a parallel
   * vocabulary").
   */
  readonly enumValues?: readonly string[];
  readonly golden: GoldenPolicy;
  readonly doc: string;
}

export interface NodeLabelSpec {
  readonly label: string;
  /** Carries the shared `:CPG` label. False for DIRECTORY/FILE/SYMBOL/COMMUNITY/TAG/META_DATA. */
  readonly cpgCoLabel: boolean;
  /**
   * Carries a `file` property. Must be false for SYMBOL and META_DATA — that
   * is what makes per-file replace safe for SYMBOL (D5) and keeps META_DATA
   * out of every per-file transaction entirely.
   */
  readonly hasFileProperty: boolean;
  readonly ownership: OwnershipClass;
  readonly write: WriteMechanism;
  /**
   * Identity key: the property name(s) that uniquely address one node of
   * this label. `["id"]` for :CPG nodes (the `path:kind:qualifiedScopePath`
   * rule), `["fqn"]` for SYMBOL, `["path"]` for DIRECTORY/FILE, `[]` for the
   * graph-wide singleton META_DATA.
   */
  readonly key: readonly string[];
  readonly properties: readonly PropertySpec[];
  /** The archived plan's milestone id (M0.x) that first writes this label. */
  readonly firstWrittenIn: string;
  readonly doc: string;
}

export interface EdgeTypeSpec {
  readonly type: string;
  /** Node labels this edge may originate from. */
  readonly from: readonly string[];
  /** Node labels this edge may terminate at. */
  readonly to: readonly string[];
  readonly ownership: OwnershipClass;
  readonly write: WriteMechanism;
  readonly properties: readonly PropertySpec[];
  readonly firstWrittenIn: string;
  readonly doc: string;
}

/** One Cypher index the schema bootstrap (M0.4) must create. */
export interface SchemaIndexSpec {
  readonly label: string;
  readonly properties: readonly string[];
  readonly kind: 'RANGE';
}

/** One Cypher constraint the schema bootstrap (M0.4) must create. */
export interface SchemaConstraintSpec {
  readonly type: 'UNIQUE';
  readonly label: string;
  readonly properties: readonly string[];
  readonly entityType: 'NODE';
}
