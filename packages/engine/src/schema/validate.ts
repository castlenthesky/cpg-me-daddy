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

function validateEdge(row: EdgeRow, delta: GraphDelta, problems: string[]): void {
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

  checkProperties(where, row.properties, spec.properties, problems);
}

/** Runs every schema check against a `GraphDelta` and reports every problem, not just the first. */
export function validateGraphDelta(delta: GraphDelta): VerifyResult {
  const problems: string[] = [];
  for (const node of delta.nodes) {
    validateNode(node, delta, problems);
  }
  for (const edge of delta.edges) {
    validateEdge(edge, delta, problems);
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
