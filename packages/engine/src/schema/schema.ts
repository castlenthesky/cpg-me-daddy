/**
 * The assembled v1 CPG schema: lookup maps, indexes/constraints for the M0.4
 * store bootstrap, and the id rule. This is `CPG_SCHEMA` — the single object
 * `SCHEMA_VERSION`, the validator, the golden serializer and the future
 * `cpg://schema` MCP resource all read.
 */
import { EDGE_TYPES } from "./edges";
import { NODE_LABELS } from "./nodes";
import type { EdgeTypeSpec, NodeLabelSpec, SchemaConstraintSpec, SchemaIndexSpec } from "./types";

/**
 * `path:kind:qualifiedScopePath[:ordinal|:bodyHash]`. No file content hash —
 * that would change every id in a file on every save (AM1/D31, which
 * reverses planning README design rule 1's original hash-based formula).
 * `CALL` ordinals are parent-scope-relative, not file-relative, so
 * "insert above -> 0 id changes" holds for two identical calls in one method.
 */
export const ID_RULE = "path:kind:qualifiedScopePath[:ordinal|:bodyHash]";

/**
 * Feeds the M0.4a bootstrap and the live conformance check's optional index
 * assertion. `SYMBOL(fqn)` is here, not just implied by the UNIQUE constraint
 * below: FalkorDB refuses a UNIQUE constraint without a supporting exact-match
 * index on the same properties (M0.4a bug fix — this entry was missing).
 */
export const SCHEMA_INDEXES: readonly SchemaIndexSpec[] = [
  { label: "CPG", properties: ["id"], kind: "RANGE" },
  { label: "CPG", properties: ["file"], kind: "RANGE" },
  { label: "FILE", properties: ["path"], kind: "RANGE" },
  { label: "DIRECTORY", properties: ["path"], kind: "RANGE" },
  { label: "SYMBOL", properties: ["fqn"], kind: "RANGE" },
];

export const SCHEMA_CONSTRAINTS: readonly SchemaConstraintSpec[] = [
  { type: "UNIQUE", label: "SYMBOL", properties: ["fqn"], entityType: "NODE" },
];

export const CPG_SCHEMA = {
  /**
   * Bumped whenever a label, edge type, required property or enum value set
   * changes. The graph is a cache (design rule 7) — there is no migration
   * path, only rebuild: on start the daemon reads `META_DATA.schema_version`
   * and, on mismatch, drops and re-indexes (GE-FR18, GE-UC1).
   */
  version: 3,
  idRule: ID_RULE,
  nodes: NODE_LABELS,
  edges: EDGE_TYPES,
  indexes: SCHEMA_INDEXES,
  constraints: SCHEMA_CONSTRAINTS,
} as const;

const NODE_BY_LABEL = new Map<string, NodeLabelSpec>(NODE_LABELS.map((n) => [n.label, n]));
const EDGE_BY_TYPE = new Map<string, EdgeTypeSpec>(EDGE_TYPES.map((e) => [e.type, e]));

/** The declared spec for a node label, or `undefined` if it is not part of the v1 schema. */
export function nodeSpec(label: string): NodeLabelSpec | undefined {
  return NODE_BY_LABEL.get(label);
}

/** The declared spec for an edge type, or `undefined` if it is not part of the v1 schema. */
export function edgeSpec(type: string): EdgeTypeSpec | undefined {
  return EDGE_BY_TYPE.get(type);
}
