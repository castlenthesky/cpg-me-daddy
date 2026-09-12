/**
 * The DB-free half of the M0.0 `test:schema` gate.
 *
 * `validateGraphDelta()` checks a `GraphDelta` — the same shape M0.4's
 * `UNWIND $rows` per-file writer will batch — against `CPG_SCHEMA`, so M0.4
 * has no choice but to validate what it writes. This runs entirely offline:
 * no FalkorDB connection, so it lives under `test/unit/schema/` and joins
 * `bun run test:unit` as well as `bun run test:schema`. The live-graph
 * counterpart, `test/support/schema-conformance.ts` (M0.0c), asks the same
 * questions of an actual running graph.
 */
import { edgeSpec, nodeSpec } from "./schema";
import type { PropertySpec } from "./types";

export interface NodeRow {
  /** All labels this node carries, e.g. `["CPG", "METHOD"]` or `["SYMBOL"]`. */
  labels: string[];
  properties: Record<string, unknown>;
}

export interface EdgeRow {
  type: string;
  fromLabel: string;
  toLabel: string;
  /**
   * The actual key of the node this edge connects — a node's own identity
   * key, e.g. its `id` for a :CPG node or `fqn` for a SYMBOL (hence `Key`,
   * not `Id`: not every endpoint is keyed by `id`). Optional here:
   * schema-level conformance only needs the label pair — connectivity is
   * the extractor's business, not this validator's. Added additively
   * (M0.6/M0.8, the AST-to-CPG conversion unit) so a `GraphDelta` can
   * represent a genuinely connected graph, not just which label pairs are
   * legal; existing callers that omit them are still valid deltas.
   */
  fromKey?: string;
  toKey?: string;
  properties: Record<string, unknown>;
}

export interface GraphDelta {
  /** Set when this delta is one file's per-file replace. Enables the overlay and cross-file rules. */
  file?: string;
  nodes: NodeRow[];
  edges: EdgeRow[];
}

/** Deliberately the same result shape as `test/support/invariants.ts`. One spine, one shape. */
export interface VerifyResult {
  ok: boolean;
  problems: string[];
}

function typeMatches(type: PropertySpec["type"], value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "int":
    case "float":
      return typeof value === "number";
    case "bool":
      return typeof value === "boolean";
    case "string[]":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
    default:
      return false;
  }
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function checkProperties(
  where: string,
  properties: Readonly<Record<string, unknown>>,
  specs: readonly PropertySpec[],
  problems: string[],
  /**
   * Identity-key property names (`NodeLabelSpec.key`) are always allowed even
   * though they carry no `PropertySpec` of their own — their presence and
   * non-emptiness is checked separately, by the key-presence check in
   * `validateNode`. Declaring `id`/`fqn`/`path` a second time as an ordinary
   * property on all fourteen node specs would be pure duplication of `key`.
   */
  allowedKeys: readonly string[] = [],
): void {
  const declared = new Map(specs.map((p) => [p.name, p]));
  const keySet = new Set(allowedKeys);

  for (const [key, value] of Object.entries(properties)) {
    if (keySet.has(key)) {
      continue;
    }
    const spec = declared.get(key);
    if (!spec) {
      problems.push(`${where}: undeclared property '${key}'`);
      continue;
    }
    if (!isPresent(value)) {
      continue;
    }
    if (!typeMatches(spec.type, value)) {
      problems.push(
        `${where}: property '${key}' should be ${spec.type}, got ${JSON.stringify(value)}`,
      );
      continue;
    }
    if (spec.enumValues && !spec.enumValues.includes(value as string)) {
      problems.push(
        `${where}: property '${key}' = ${JSON.stringify(value)} is not one of [${spec.enumValues.join(", ")}]`,
      );
    }
  }

  for (const spec of specs) {
    if (spec.cardinality === "one" && !isPresent(properties[spec.name])) {
      problems.push(`${where}: missing required property '${spec.name}'`);
    }
  }
}

function validateNode(row: NodeRow, delta: GraphDelta, problems: string[]): void {
  const nonCpgLabels = row.labels.filter((l) => l !== "CPG");
  if (nonCpgLabels.length !== 1) {
    problems.push(
      `node [${row.labels.join(", ")}]: must carry exactly one kind label alongside CPG, found ${nonCpgLabels.length}`,
    );
    return;
  }
  const kind = nonCpgLabels[0]!;
  const spec = nodeSpec(kind);
  if (!spec) {
    problems.push(`node '${kind}': undeclared node label`);
    return;
  }

  const where = `node ${kind}${typeof row.properties["id"] === "string" ? ` (${row.properties["id"]})` : ""}`;

  const hasCpg = row.labels.includes("CPG");
  if (spec.cpgCoLabel && !hasCpg) {
    problems.push(`${where}: must carry the :CPG label`);
  }
  if (!spec.cpgCoLabel && hasCpg) {
    problems.push(
      `${where}: must NOT carry the :CPG label (${kind} is not a structural :CPG node)`,
    );
  }

  const hasFile = isPresent(row.properties["file"]);
  if (spec.hasFileProperty && !hasFile) {
    problems.push(`${where}: must carry a 'file' property`);
  }
  if (!spec.hasFileProperty && hasFile) {
    problems.push(`${where}: must NOT carry a 'file' property (breaks per-file replace safety)`);
  }

  for (const keyProp of spec.key) {
    if (!isPresent(row.properties[keyProp])) {
      problems.push(`${where}: missing key property '${keyProp}'`);
    }
  }

  if (spec.ownership === "overlay" && delta.file !== undefined) {
    problems.push(
      `${where}: overlay-owned node written inside a per-file replace for '${delta.file}' — overlay ` +
        "nodes must only be written by the async periodic overlay job",
    );
  }

  if (delta.file !== undefined && spec.hasFileProperty && row.properties["file"] !== delta.file) {
    problems.push(
      `${where}: 'file' property (${JSON.stringify(row.properties["file"])}) does not match the ` +
        `replace's own file (${JSON.stringify(delta.file)})`,
    );
  }

  checkProperties(where, row.properties, spec.properties, problems, spec.key);
}

/** This row's own kind label (its one non-`CPG` label), or `undefined` if that's not exactly one. */
function nodeKind(row: NodeRow): string | undefined {
  const nonCpgLabels = row.labels.filter((l) => l !== "CPG");
  return nonCpgLabels.length === 1 ? nonCpgLabels[0] : undefined;
}

/**
 * `"<label>:<keyValue>"` for every node in the delta whose label has a
 * single-property key (every v1 label does — `["id"]`, `["fqn"]`, `["path"]`,
 * or `[]` for the keyless `META_DATA` singleton). Feeds the referential-
 * integrity check below: an edge's `fromKey`/`toKey` must resolve to a real
 * node in the SAME delta, not just a legal label pair.
 */
function buildNodeKeyIndex(nodes: readonly NodeRow[]): ReadonlySet<string> {
  const index = new Set<string>();
  for (const node of nodes) {
    const kind = nodeKind(node);
    if (kind === undefined) {
      continue;
    }
    const spec = nodeSpec(kind);
    if (spec === undefined || spec.key.length !== 1) {
      continue;
    }
    const keyValue = node.properties[spec.key[0]!];
    if (typeof keyValue === "string") {
      index.add(`${kind}:${keyValue}`);
    }
  }
  return index;
}

function validateEdge(
  row: EdgeRow,
  delta: GraphDelta,
  nodeKeyIndex: ReadonlySet<string>,
  problems: string[],
): void {
  const spec = edgeSpec(row.type);
  if (!spec) {
    problems.push(`edge '${row.type}': undeclared edge type`);
    return;
  }

  const where = `edge ${row.type} (${row.fromLabel} -> ${row.toLabel})`;

  if (!spec.from.includes(row.fromLabel)) {
    problems.push(
      `${where}: source label '${row.fromLabel}' is not in the declared 'from' set [${spec.from.join(", ")}]`,
    );
  }
  if (!spec.to.includes(row.toLabel)) {
    problems.push(
      `${where}: target label '${row.toLabel}' is not in the declared 'to' set [${spec.to.join(", ")}]`,
    );
  }

  if (spec.ownership === "overlay" && delta.file !== undefined) {
    problems.push(
      `${where}: overlay-owned edge written inside a per-file replace for '${delta.file}' — overlay ` +
        "edges must only be written by the async periodic overlay job",
    );
  }

  // Referential integrity: `fromKey`/`toKey` are optional (existing callers
  // that never set them stay valid — see the field doc), but a caller that
  // DOES set one must point at a node that actually exists in this same
  // delta. A per-file replace's own nodes are the only thing it can promise
  // to be self-consistent about; cross-file references (SYMBOL) are exactly
  // why this check only fires when the key was supplied at all.
  if (row.fromKey !== undefined && !nodeKeyIndex.has(`${row.fromLabel}:${row.fromKey}`)) {
    problems.push(
      `${where}: 'fromKey' ${JSON.stringify(row.fromKey)} does not match any '${row.fromLabel}' node in this delta`,
    );
  }
  if (row.toKey !== undefined && !nodeKeyIndex.has(`${row.toLabel}:${row.toKey}`)) {
    problems.push(
      `${where}: 'toKey' ${JSON.stringify(row.toKey)} does not match any '${row.toLabel}' node in this delta`,
    );
  }

  checkProperties(where, row.properties, spec.properties, problems);
}

/** Runs every schema check against a `GraphDelta` and reports every problem, not just the first. */
export function validateGraphDelta(delta: GraphDelta): VerifyResult {
  const problems: string[] = [];
  const nodeKeyIndex = buildNodeKeyIndex(delta.nodes);
  for (const node of delta.nodes) {
    validateNode(node, delta, problems);
  }
  for (const edge of delta.edges) {
    validateEdge(edge, delta, nodeKeyIndex, problems);
  }
  return { ok: problems.length === 0, problems };
}

/** Throws unless the delta satisfies every schema check. The message lists every problem at once. */
export function assertGraphDeltaValid(delta: GraphDelta): void {
  const result = validateGraphDelta(delta);
  if (!result.ok) {
    const lines = result.problems.map((p) => `  - ${p}`).join("\n");
    throw new Error(`Schema violations in graph delta:\n${lines}`);
  }
}
