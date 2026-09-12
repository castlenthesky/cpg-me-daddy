/**
 * The deterministic JSON projection of `CPG_SCHEMA`.
 *
 * Serves the future `cpg://schema` MCP resource (M2): `JSON.stringify` of
 * this function's output is the whole resource body, no database
 * connection required, since `src/schema/` imports nothing but its own
 * types. Sorted so two runs against the same schema produce byte-identical
 * output regardless of declaration order — that determinism is asserted by
 * `test/unit/schema/schema.test.ts`. Nothing is dropped: the Joern alignment
 * data travels into the JSON too, because that is what makes the written
 * spec's divergence table (`tools/schema-doc.ts`) generatable from this
 * object rather than maintained by hand.
 */
import type { CPG_SCHEMA } from "./schema";
import type { EdgeTypeSpec, NodeLabelSpec, PropertySpec } from "./types";

/**
 * Plain code-unit ordering, not `localeCompare` — ICU collation treats `_` as
 * ignorable, which would sort `IN_SCOPE` before `INHERITS_FROM` in some
 * locales and after in others. A schema serializer must not depend on the
 * host's locale.
 */
function byKey<K extends string>(key: K) {
  return (a: Record<K, string>, b: Record<K, string>): number =>
    a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
}

function sortProperties(properties: readonly PropertySpec[]): PropertySpec[] {
  return properties.toSorted(byKey("name"));
}

function serializeNode(node: NodeLabelSpec): NodeLabelSpec {
  return { ...node, properties: sortProperties(node.properties) };
}

function serializeEdge(edge: EdgeTypeSpec): EdgeTypeSpec {
  return { ...edge, properties: sortProperties(edge.properties) };
}

/** A JSON-serializable, deterministically-ordered projection of a `CPG_SCHEMA`-shaped object. */
export function schemaToJson(schema: typeof CPG_SCHEMA) {
  return {
    version: schema.version,
    idRule: schema.idRule,
    nodes: schema.nodes.map(serializeNode).toSorted(byKey("label")),
    edges: schema.edges.map(serializeEdge).toSorted(byKey("type")),
    indexes: schema.indexes.toSorted(byKey("label")),
    constraints: schema.constraints.toSorted(byKey("label")),
  };
}
