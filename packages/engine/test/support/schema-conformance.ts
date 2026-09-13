/**
 * Live-graph half of the M0.0 `test:schema` gate — verification spine layer
 * VS3's sibling. `test/support/invariants.ts` asks whether the graph's
 * CONTENT is self-consistent; this asks whether its SHAPE matches
 * `CPG_SCHEMA`. Deliberately a separate function, not folded into
 * `checkGraphInvariants` — merging them would change what F2's gate means.
 * The convention instead: every integration test ends by calling both.
 *
 * FalkorDB v4.20.4 mechanics, verified against THIS project's own harness
 * (`bun run db:up`, 127.0.0.1:6381, not any other instance) via `redis-cli`
 * before writing this file:
 *
 *   - `CALL db.labels() YIELD label`, `CALL db.relationshipTypes() YIELD
 *     relationshipType`, `CALL db.indexes()` and `CALL db.constraints()` all
 *     work over `GRAPH.RO_QUERY`.
 *   - `CALL db.propertyKeys()` is GRAPH-GLOBAL, not per-label — useless for
 *     "does label X carry only declared properties." Use
 *     `MATCH (n:X) UNWIND keys(n) AS k RETURN DISTINCT k` per label instead.
 *   - **The label/relationship-type registry is sticky.** Deleting every node
 *     of a label does NOT remove it from `db.labels()` — confirmed by
 *     creating `:ProbeA`/`:ProbeB`, deleting every `:ProbeA` node, and
 *     observing `db.labels()` still return `ProbeA` while
 *     `MATCH (n:ProbeA) RETURN count(n)` returns 0. So a registry hit is
 *     never itself a problem — only a registry hit with a live, non-zero
 *     count is. This is exactly the class of gotcha `open_items.OI5` warns
 *     about, hence verifying live rather than trusting the docs.
 *   - **`db.indexes()` returns ONE row per label**, with every indexed
 *     property on that label merged into a single `properties` array —
 *     `CPG(id)` + `CPG(file)` come back as one row `CPG [id, file]`, never
 *     two. `checkBootstrap` below matches by containment for this reason,
 *     not by exact array equality (M0.4a bug fix — the original matcher
 *     would report every multi-index label's entries missing even after a
 *     correct bootstrap). `db.constraints()` genuinely is one row per
 *     constraint, so that half stays a deep-equality match.
 */
import type { GraphService } from "../../../falkordb-service/src/index.ts";
import {
  NODE_LABELS,
  SCHEMA_CONSTRAINTS,
  SCHEMA_INDEXES,
  edgeSpec,
  nodeSpec,
} from "../../src/schema/index.ts";
import type { NodeLabelSpec, VerifyResult } from "../../src/schema/index.ts";

/**
 * Widens the `as const satisfies` literal array to its declared interface
 * type. `NODE_LABELS` itself is deliberately literal-typed (so a typo'd
 * label fails `tsc --build`), but that means iterating it directly leaves
 * TypeScript unable to see optional fields like `enumValues` that some
 * entries omit — this file only needs the general shape.
 */
const NODE_SPECS: readonly NodeLabelSpec[] = NODE_LABELS;

export interface ConformanceOptions {
  /** M0.4a flips this on once the bootstrap creates the declared indexes/constraints. Off here. */
  requireIndexes?: boolean;
}

async function liveCount(graph: GraphService, cypher: string): Promise<number> {
  return graph.scalar(cypher);
}

/** Labels/relationship types the registry reports that still have >=1 live entity. */
async function liveUndeclared(
  graph: GraphService,
  registryQuery: string,
  registryField: string,
  isDeclared: (name: string) => boolean,
  countFor: (name: string) => string,
): Promise<string[]> {
  const registered = await graph.read<Record<string, string>>(registryQuery);
  const candidates = registered.data
    .map((row) => row[registryField]!)
    .filter((name) => !isDeclared(name));
  const hits = await Promise.all(
    candidates.map(async (name) => {
      const count = await liveCount(graph, countFor(name));
      return count > 0 ? `${name} (${count} live)` : undefined;
    }),
  );
  return hits.filter((h): h is string => h !== undefined);
}

async function checkUndeclaredLabels(graph: GraphService): Promise<string[]> {
  const undeclared = await liveUndeclared(
    graph,
    "CALL db.labels() YIELD label RETURN label",
    "label",
    (label) => nodeSpec(label) !== undefined || label === "CPG",
    (label) => `MATCH (n:${label}) RETURN count(n) AS n`,
  );
  return undeclared.length > 0
    ? [`undeclared node label(s) with live nodes: ${undeclared.join(", ")}`]
    : [];
}

async function checkUndeclaredRelationshipTypes(graph: GraphService): Promise<string[]> {
  const undeclared = await liveUndeclared(
    graph,
    "CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType",
    "relationshipType",
    (type) => edgeSpec(type) !== undefined,
    (type) => `MATCH ()-[r:${type}]->() RETURN count(r) AS n`,
  );
  return undeclared.length > 0
    ? [`undeclared edge type(s) with live edges: ${undeclared.join(", ")}`]
    : [];
}

async function checkOneLabelProperties(
  graph: GraphService,
  spec: NodeLabelSpec,
): Promise<string[]> {
  const count = await liveCount(graph, `MATCH (n:${spec.label}) RETURN count(n) AS n`);
  if (count === 0) {
    return [];
  }
  const problems: string[] = [];
  const declaredNames = new Set([...spec.properties.map((p) => p.name), ...spec.key]);

  const [observed, ...checks] = await Promise.all([
    graph.read<{ k: string }>(`MATCH (n:${spec.label}) UNWIND keys(n) AS k RETURN DISTINCT k`),
    ...spec.properties
      .filter((p) => p.cardinality === "one")
      .map(async (prop) => {
        const missing = await liveCount(
          graph,
          `MATCH (n:${spec.label}) WHERE n.${prop.name} IS NULL RETURN count(n) AS n`,
        );
        return missing > 0
          ? `${spec.label}: ${missing} live node(s) missing required property '${prop.name}'`
          : undefined;
      }),
    ...spec.properties
      .filter((p) => p.enumValues)
      .map(async (prop) => {
        const bad = await graph.read<{ v: unknown }>(
          `MATCH (n:${spec.label}) WHERE n.${prop.name} IS NOT NULL AND NOT n.${prop.name} IN $allowed ` +
            `RETURN DISTINCT n.${prop.name} AS v`,
          { allowed: [...prop.enumValues!] },
        );
        return bad.data.map(
          (r) =>
            `${spec.label}.${prop.name} = ${JSON.stringify(r.v)} is not one of [${prop.enumValues!.join(", ")}]`,
        );
      }),
  ]);

  for (const { k } of observed.data) {
    if (!declaredNames.has(k)) {
      problems.push(`${spec.label}: live nodes carry undeclared property '${k}'`);
    }
  }
  for (const c of checks) {
    if (Array.isArray(c)) {
      problems.push(...c);
    } else if (c !== undefined) {
      problems.push(c);
    }
  }
  return problems;
}

async function checkPerLabelProperties(graph: GraphService): Promise<string[]> {
  const perLabel = await Promise.all(
    NODE_SPECS.map((spec) => checkOneLabelProperties(graph, spec)),
  );
  return perLabel.flat();
}

async function checkOneLabelStructure(graph: GraphService, spec: NodeLabelSpec): Promise<string[]> {
  const [cpgViolations, fileViolations] = await Promise.all([
    liveCount(
      graph,
      spec.cpgCoLabel
        ? `MATCH (n:${spec.label}) WHERE NOT n:CPG RETURN count(n) AS n`
        : `MATCH (n:${spec.label}) WHERE n:CPG RETURN count(n) AS n`,
    ),
    liveCount(
      graph,
      spec.hasFileProperty
        ? `MATCH (n:${spec.label}) WHERE n.file IS NULL RETURN count(n) AS n`
        : `MATCH (n:${spec.label}) WHERE n.file IS NOT NULL RETURN count(n) AS n`,
    ),
  ]);
  const problems: string[] = [];
  if (cpgViolations > 0) {
    problems.push(
      spec.cpgCoLabel
        ? `${spec.label}: ${cpgViolations} live node(s) missing the :CPG co-label`
        : `${spec.label}: ${cpgViolations} live node(s) wrongly carry the :CPG label`,
    );
  }
  if (fileViolations > 0) {
    problems.push(
      spec.hasFileProperty
        ? `${spec.label}: ${fileViolations} live node(s) missing the required 'file' property`
        : `${spec.label}: ${fileViolations} live node(s) wrongly carry a 'file' property (breaks per-file replace safety, D5)`,
    );
  }
  return problems;
}

async function checkStructuralLabelRules(graph: GraphService): Promise<string[]> {
  const perLabel = await Promise.all(NODE_SPECS.map((spec) => checkOneLabelStructure(graph, spec)));
  return perLabel.flat();
}

async function checkEdgeEndpoints(graph: GraphService): Promise<string[]> {
  const registered = await graph.read<{ relationshipType: string }>(
    "CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType",
  );
  const results = await Promise.all(
    registered.data.map(async ({ relationshipType: type }) => {
      const spec = edgeSpec(type);
      if (!spec) {
        return undefined; // reported by checkUndeclaredRelationshipTypes
      }
      const fromList = spec.from.map((l) => `'${l}'`).join(", ");
      const toList = spec.to.map((l) => `'${l}'`).join(", ");
      const bad = await liveCount(
        graph,
        `MATCH (a)-[r:${type}]->(b) ` +
          `WHERE NOT any(l IN labels(a) WHERE l IN [${fromList}]) ` +
          `OR NOT any(l IN labels(b) WHERE l IN [${toList}]) ` +
          `RETURN count(r) AS n`,
      );
      return bad > 0
        ? `${type}: ${bad} live edge(s) with an endpoint label outside the declared from/to sets`
        : undefined;
    }),
  );
  return results.filter((r): r is string => r !== undefined);
}

async function checkBootstrap(graph: GraphService): Promise<string[]> {
  const [indexes, constraints] = await Promise.all([
    graph.read<{ label: string; properties: string[] }>("CALL db.indexes()"),
    graph.read<{ type: string; label: string; properties: string[] }>("CALL db.constraints()"),
  ]);
  const problems: string[] = [];
  // FalkorDB's db.indexes() returns ONE row per label, with every indexed
  // property on that label merged into a single `properties` array (verified
  // live: `CPG(id)` + `CPG(file)` come back as one row `CPG [id, file]`, not
  // two rows). Two separately-declared SCHEMA_INDEXES entries on the same
  // label therefore share one row — matching by exact array equality would
  // report both as missing even after a correct bootstrap. Match by
  // containment instead: every property this spec declares must appear
  // somewhere in that label's row.
  const indexedPropsByLabel = new Map<string, Set<string>>();
  for (const row of indexes.data) {
    const set = indexedPropsByLabel.get(row.label) ?? new Set<string>();
    for (const p of row.properties) {
      set.add(p);
    }
    indexedPropsByLabel.set(row.label, set);
  }
  for (const spec of SCHEMA_INDEXES) {
    const indexed = indexedPropsByLabel.get(spec.label);
    const found = indexed !== undefined && spec.properties.every((p) => indexed.has(p));
    if (!found) {
      problems.push(`missing declared index on ${spec.label}(${spec.properties.join(", ")})`);
    }
  }
  for (const spec of SCHEMA_CONSTRAINTS) {
    const found = constraints.data.some(
      (row) =>
        row.type === spec.type &&
        row.label === spec.label &&
        JSON.stringify(row.properties) === JSON.stringify(spec.properties),
    );
    if (!found) {
      problems.push(
        `missing declared constraint ${spec.type} on ${spec.label}(${spec.properties.join(", ")})`,
      );
    }
  }
  return problems;
}

/** Runs every live-graph schema check and reports every problem, not just the first. */
export async function checkSchemaConformance(
  graph: GraphService,
  opts: ConformanceOptions = {},
): Promise<VerifyResult> {
  const groups = await Promise.all([
    checkUndeclaredLabels(graph),
    checkUndeclaredRelationshipTypes(graph),
    checkPerLabelProperties(graph),
    checkStructuralLabelRules(graph),
    checkEdgeEndpoints(graph),
    opts.requireIndexes ? checkBootstrap(graph) : Promise.resolve([]),
  ]);
  const problems = groups.flat();
  return { ok: problems.length === 0, problems };
}

/** Throws unless the live graph satisfies every schema check. Lists every problem at once. */
export async function assertSchemaConformance(
  graph: GraphService,
  opts: ConformanceOptions = {},
): Promise<void> {
  const result = await checkSchemaConformance(graph, opts);
  if (!result.ok) {
    const lines = result.problems.map((p) => `  - ${p}`).join("\n");
    throw new Error(`Schema conformance violated in "${graph.name}":\n${lines}`);
  }
}
