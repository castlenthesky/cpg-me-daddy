/**
 * M0.4b — the pure half of the graph writer: `planDelta()` turns a
 * `GraphDelta` (`schema/validate.ts` — the same type `assertGraphDeltaValid`
 * already gates; no second "DiffGraph" type exists) into the exact
 * parameterized Cypher operations a store executes. No client, no I/O — the
 * whole batching/grouping strategy is unit-testable DB-free, and the live
 * gate can `EXPLAIN` these exact strings.
 *
 * Three op kinds, matching the ownership/write-mechanism table in
 * 50-schema.md §8:
 *
 *   - **scope-delete**, issued first when `delta.file` is set:
 *     `MATCH (n:CPG {file:$file}) DELETE n` — never `DETACH DELETE`, which
 *     destroys inbound cross-file edges (the exact bug per-file replace
 *     safety, D5, exists to avoid).
 *   - **node-create / node-merge**, grouped by node KIND (not by raw label
 *     array — the array is a pure function of kind via `nodeSpec()`, so
 *     grouping by kind is equivalent and caps at 14 groups), dispatched on
 *     `nodeSpec().write`: `delete-create` labels (MODULE, METHOD, CALL, ...)
 *     get a plain `CREATE`; `merge-on-key` labels (SYMBOL, TAG, FILE,
 *     DIRECTORY) get a `MERGE` on their own key with null/undefined
 *     properties pruned before the `SET` — load-bearing, not cosmetic: an
 *     unpruned write would silently null out a definer's SYMBOL properties
 *     on every save of a file that merely CALLS it.
 *   - **edge**, grouped by the RESOLVED per-row match-shape
 *     `(type, fromLabel's own match label+key, toLabel's own match
 *     label+key)`, not by the edge type's static declared `from`/`to` label
 *     SETS — this is what collapses e.g. DEFINES's five possible source
 *     labels (MODULE/TYPE_DECL/METHOD/MEMBER/PARAM, all :CPG-co-labelled)
 *     into one query, while still letting an edge type whose declared
 *     endpoints are NOT uniformly shaped (e.g. TAGGED_BY, anchored at either
 *     a :CPG node or a bare SYMBOL) split into the groups its rows actually
 *     need. An endpoint matches on `:CPG {id: ...}` when its label is
 *     `:CPG`-co-labelled, else on its own label's declared key (`:SYMBOL
 *     {fqn: ...}`, `:TAG {name: ...}`) — never the kind label bare, which is
 *     a label scan and the single easiest way to fail this unit's own gate
 *     while looking MORE precise, not less. The mandatory `WITH s, row`
 *     barrier between the two `MATCH`es is this repo's own benchmark's fix
 *     for a measured 700ms -> 1ms planner trap (a bare two-pattern `MATCH`
 *     plans as a Cartesian Product). Dispatched on `edgeSpec().write` the
 *     same way nodes are: `delete-create` edges (DECLARES, DEFINES, CALLS,
 *     ...) get `CREATE`, since the scope-delete already cleared any prior
 *     ones; `merge-on-key` edges (ALIAS_OF, TAGGED_BY) get `MERGE` so a
 *     re-resolve pass does not accumulate duplicate relationships between
 *     two nodes neither of which is necessarily scope-deleted together.
 *
 * `overlay-job` and `move-rename-only` nodes/edges (COMMUNITY, MEMBER_OF,
 * TARGETS, DEPENDS_ON, HAS_ENTRY) are out of this writer's scope entirely —
 * they belong to the periodic overlay job and the filesystem walker
 * respectively, never to a per-file `GraphDelta`. `planDelta` throws if one
 * turns up, rather than silently mis-writing it.
 *
 * Rows are chunked at `batchSize` (default 5000) per query — chunking the
 * ROWS ARRAY, not the op list, per this repo's own benchmark (~3k
 * nodes/~10k edges in one query with no limit hit).
 */
import { edgeSpec, nodeSpec } from "../schema/schema";
import type { EdgeTypeSpec, NodeLabelSpec, WriteMechanism } from "../schema/types";
import type { EdgeRow, GraphDelta, NodeRow } from "../schema/validate";

export type CypherOpKind = "scope-delete" | "node-create" | "node-merge" | "edge";

export interface CypherOp {
  readonly kind: CypherOpKind;
  /** Human-readable grouping key, for diagnostics — not parsed by any caller. */
  readonly group: string;
  readonly cypher: string;
  readonly params: Record<string, unknown>;
}

export interface PlanDeltaOptions {
  /** Rows per query, chunked within a group. Default 5000. */
  readonly batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 5000;

function chunk<T>(rows: readonly T[], size: number): T[][] {
  if (rows.length === 0) {
    return [];
  }
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size));
  }
  return out;
}

function requireNodeSpec(label: string): NodeLabelSpec {
  const spec = nodeSpec(label);
  if (spec === undefined) {
    throw new Error(`planDelta: '${label}' is not a declared v1 schema node label.`);
  }
  return spec;
}

function requireEdgeSpec(type: string): EdgeTypeSpec {
  const spec = edgeSpec(type);
  if (spec === undefined) {
    throw new Error(`planDelta: '${type}' is not a declared v1 schema edge type.`);
  }
  return spec;
}

function requireOutOfScopeWriteMechanism(write: WriteMechanism, what: string): void {
  if (write === "overlay-job" || write === "move-rename-only") {
    throw new Error(
      `planDelta: ${what} has write mechanism '${write}', which is out of this per-file ` +
        "writer's scope (overlay-job belongs to the periodic overlay job; move-rename-only " +
        "belongs to the filesystem walker). This delta should never have carried it.",
    );
  }
}

/** The kind label a `NodeRow` was tagged with — its one non-`CPG` label. */
function nodeKind(row: NodeRow): string {
  const kind = row.labels.find((l) => l !== "CPG");
  if (kind === undefined) {
    throw new Error(
      `planDelta: a node row carries no non-CPG label: ${JSON.stringify(row.labels)}`,
    );
  }
  return kind;
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return groups;
}

/** Drops key properties (they belong in the MERGE pattern) and null/undefined values. */
function pruneForMerge(
  properties: Record<string, unknown>,
  keyProps: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(properties)) {
    if (keyProps.includes(k) || v === null || v === undefined) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

function planNodeCreate(
  label: string,
  spec: NodeLabelSpec,
  rows: NodeRow[],
  batchSize: number,
): CypherOp[] {
  const labels = spec.cpgCoLabel ? ["CPG", label] : [label];
  const cypher = `UNWIND $rows AS row CREATE (n:${labels.join(":")}) SET n = row`;
  return chunk(rows, batchSize).map((rowsChunk) => ({
    kind: "node-create",
    group: label,
    cypher,
    params: { rows: rowsChunk.map((r) => r.properties) },
  }));
}

function planNodeMerge(
  label: string,
  spec: NodeLabelSpec,
  rows: NodeRow[],
  batchSize: number,
): CypherOp[] {
  if (spec.key.length !== 1) {
    throw new Error(
      `planDelta: merge-on-key label '${label}' has no single-property key to merge on ` +
        `(declared key: ${JSON.stringify(spec.key)}).`,
    );
  }
  const keyProp = spec.key[0]!;
  const cypher = `UNWIND $rows AS row MERGE (n:${label} {${keyProp}: row.key}) SET n += row.props`;
  return chunk(rows, batchSize).map((rowsChunk) => ({
    kind: "node-merge",
    group: label,
    cypher,
    params: {
      rows: rowsChunk.map((r) => ({
        key: r.properties[keyProp],
        props: pruneForMerge(r.properties, spec.key),
      })),
    },
  }));
}

function planNodes(nodes: readonly NodeRow[], batchSize: number): CypherOp[] {
  const byKind = groupBy(nodes, nodeKind);
  const ops: CypherOp[] = [];
  for (const [kind, rows] of byKind) {
    const spec = requireNodeSpec(kind);
    requireOutOfScopeWriteMechanism(spec.write, `node label '${kind}'`);
    ops.push(
      ...(spec.write === "merge-on-key"
        ? planNodeMerge(kind, spec, rows, batchSize)
        : planNodeCreate(kind, spec, rows, batchSize)),
    );
  }
  return ops;
}

interface EndpointShape {
  readonly matchLabel: string;
  readonly keyProp: string;
}

/** How an edge endpoint is matched: `:CPG {id}` when co-labelled, else the label's own key. */
function endpointShape(label: string): EndpointShape {
  const spec = requireNodeSpec(label);
  if (spec.cpgCoLabel) {
    return { matchLabel: "CPG", keyProp: "id" };
  }
  if (spec.key.length !== 1) {
    throw new Error(
      `planDelta: edge endpoint label '${label}' has no single-property key to match on ` +
        `(declared key: ${JSON.stringify(spec.key)}).`,
    );
  }
  return { matchLabel: label, keyProp: spec.key[0]! };
}

interface EdgeGroupKey {
  readonly key: string;
  readonly type: string;
  readonly from: EndpointShape;
  readonly to: EndpointShape;
}

function edgeGroupKey(row: EdgeRow): EdgeGroupKey {
  const from = endpointShape(row.fromLabel);
  const to = endpointShape(row.toLabel);
  return {
    key: `${row.type}::${from.matchLabel}.${from.keyProp}::${to.matchLabel}.${to.keyProp}`,
    type: row.type,
    from,
    to,
  };
}

function planEdgeGroup(
  { type, from, to }: EdgeGroupKey,
  spec: EdgeTypeSpec,
  rows: EdgeRow[],
  batchSize: number,
): CypherOp[] {
  const verb = spec.write === "merge-on-key" ? "MERGE" : "CREATE";
  const setOp = spec.write === "merge-on-key" ? "+=" : "=";
  const cypher =
    `UNWIND $rows AS row ` +
    `MATCH (s:${from.matchLabel} {${from.keyProp}: row.from}) ` +
    `WITH s, row ` +
    `MATCH (t:${to.matchLabel} {${to.keyProp}: row.to}) ` +
    `${verb} (s)-[r:${type}]->(t) ` +
    `SET r ${setOp} row.props`;
  return chunk(rows, batchSize).map((rowsChunk) => ({
    kind: "edge",
    group: `${type}: ${from.matchLabel}.${from.keyProp} -> ${to.matchLabel}.${to.keyProp}`,
    cypher,
    params: {
      rows: rowsChunk.map((r) => ({
        from: requireEdgeKey(r, "fromKey"),
        to: requireEdgeKey(r, "toKey"),
        props: r.properties,
      })),
    },
  }));
}

function requireEdgeKey(row: EdgeRow, field: "fromKey" | "toKey"): string {
  const value = row[field];
  if (value === undefined) {
    throw new Error(
      `planDelta: edge row for '${row.type}' has no ${field} — a writer needs the real node ` +
        "key to build a MATCH clause (schema-only conformance checks can omit it; a write cannot).",
    );
  }
  return value;
}

function planEdges(edges: readonly EdgeRow[], batchSize: number): CypherOp[] {
  const keyed = edges.map((row) => ({ row, groupKey: edgeGroupKey(row) }));
  const byGroup = groupBy(keyed, (item) => item.groupKey.key);
  const ops: CypherOp[] = [];
  for (const items of byGroup.values()) {
    const groupKey = items[0]!.groupKey;
    const spec = requireEdgeSpec(groupKey.type);
    requireOutOfScopeWriteMechanism(spec.write, `edge type '${groupKey.type}'`);
    ops.push(
      ...planEdgeGroup(
        groupKey,
        spec,
        items.map((i) => i.row),
        batchSize,
      ),
    );
  }
  return ops;
}

/**
 * Turns a `GraphDelta` into the ordered Cypher operations a store should
 * execute: the scope delete first (if `delta.file` is set), then nodes,
 * then edges — nodes before edges so an edge's endpoints already exist
 * within the same write.
 */
export function planDelta(delta: GraphDelta, opts: PlanDeltaOptions = {}): CypherOp[] {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const ops: CypherOp[] = [];
  if (delta.file !== undefined) {
    ops.push({
      kind: "scope-delete",
      group: "scope-delete",
      cypher: "MATCH (n:CPG {file: $file}) DELETE n",
      params: { file: delta.file },
    });
  }
  ops.push(...planNodes(delta.nodes, batchSize));
  ops.push(...planEdges(delta.edges, batchSize));
  return ops;
}
