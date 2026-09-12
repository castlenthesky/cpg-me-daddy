/**
 * Types for the v1 CPG schema (M0.0).
 *
 * These interfaces describe the shape of `NODE_LABELS` and `EDGE_TYPES` in
 * `nodes.ts`/`edges.ts`. They carry no data themselves — they exist so the
 * literal arrays there can be checked with `satisfies` while still keeping
 * their literal types (`as const satisfies readonly NodeLabelSpec[]`), which
 * is what lets `NodeLabel`/`EdgeType` be the exact 14/13-member unions rather
 * than plain `string`. A typo'd label then fails `tsc --build`, before it
 * ever reaches the runtime validator in `validate.ts`.
 *
 * Full narrative and the Joern divergence table: see the planning corpus at
 * `.agent/knowledge/planning-sessions/2026-09-11.project-outline/50-schema.md`.
 */

/** How many values a property holds. Mirrors Joern's own cardinality vocabulary. */
export type Cardinality = "one" | "zeroOrOne" | "list";

/** A property's scalar or list value type. */
export type PropertyType = "string" | "int" | "float" | "bool" | "string[]";

/**
 * Who writes this node label or edge type, and therefore what transaction it
 * may appear in. This classification is load-bearing (R6 Next Steps #2,
 * DL7): `overlay` members must never appear inside a per-file replace
 * transaction, which is exactly what `validate.ts`'s overlay-in-replace check
 * enforces.
 */
export type OwnershipClass =
  | "filesystem" // DIRECTORY, FILE, HAS_ENTRY — walker-owned, mutated on move/rename
  | "file-owned" // MODULE/TYPE_DECL/METHOD/PARAM/MEMBER/CALL/IMPORT/UNKNOWN + their edges
  | "identity" // SYMBOL, ALIAS_OF, TAG, TAGGED_BY — cross-file anchor, merged not deleted
  | "overlay" // COMMUNITY, MEMBER_OF, TARGETS, DEPENDS_ON — async periodic job only
  | "graph-singleton"; // META_DATA — one per graph, no `file`, never per-file replaced

/** The write mechanism the per-file replace (or its analogue) uses for this class. */
export type WriteMechanism =
  | "delete-create" // file-owned structural nodes/edges (R6 Next Steps #2)
  | "merge-on-key" // identity-tier: MERGE on the declared `key`, never deleted wholesale
  | "overlay-job" // written only by the async periodic overlay job, never inside a replace
  | "move-rename-only"; // filesystem tier: mutated only when the path itself changes

/**
 * This node/edge's relationship to Joern's published CPG spec
 * (`test/support/joern-cpg-schema.json`), and the reason for the verdict.
 *
 * Deliberately only three verdicts: everything REJECTED or deferred from
 * Joern does not appear in `NODE_LABELS`/`EDGE_TYPES` at all — it is not a
 * shipped label, so it has no `JoernAlignment` to carry. The full
 * REJECT/deferred accounting lives in the written spec's rejection table,
 * checked against the same vendored JSON by `test/unit/schema/joern.test.ts`.
 */
export type JoernVerdict =
  | "adopt_as_is" // same name as Joern's; property differences are additive, not a rename
  | "adopt_renamed" // Joern has a named equivalent; we ship a different name
  | "extend"; // Joern has no equivalent; this is ours

/** How much this diverges from Joern, independent of whether the *name* changed. */
export type DivergenceClass =
  | "none" // name and shape both match Joern
  | "name-only" // same concept, different name, no structural reason
  | "semantic" // same name or concept, but the shape/endpoints/meaning differ
  | "gap-fill" // Joern has nothing like this at all
  | "structural-incompatibility"; // Joern's mechanism is incompatible with per-file replace

export interface JoernAlignment {
  readonly verdict: JoernVerdict;
  /** The analogous/former Joern name. Omitted only for `extend` with no Joern analogue at all. */
  readonly joernName?: string;
  readonly divergenceClass: DivergenceClass;
  /** True when the Joern name exists only in Joern's `Hidden.scala`, not its published spec. */
  readonly hidden?: boolean;
  /** A specific, non-cosmetic reason. Reviewed verbatim at the M0.0 manual gate. */
  readonly rationale: string;
  /** Where the verdict was argued and decided, e.g. "R6 node table". */
  readonly source: string;
}

/** How the golden serializer (M0.6+) treats this property's value. */
export type GoldenPolicy =
  | "include" // deterministic given fixture content; printed in goldens
  | "redact"; // volatile (timestamps, run ids); never printed, must not churn a golden diff

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
  readonly joern: JoernAlignment;
  /** The milestone (60-delivery.yaml unit id) that first writes this label. */
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
  readonly joern: JoernAlignment;
  readonly firstWrittenIn: string;
  readonly doc: string;
}

/** One Cypher index the schema bootstrap (M0.4) must create. */
export interface SchemaIndexSpec {
  readonly label: string;
  readonly properties: readonly string[];
  readonly kind: "RANGE";
}

/** One Cypher constraint the schema bootstrap (M0.4) must create. */
export interface SchemaConstraintSpec {
  readonly type: "UNIQUE";
  readonly label: string;
  readonly properties: readonly string[];
  readonly entityType: "NODE";
}
