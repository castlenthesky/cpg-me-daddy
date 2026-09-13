/**
 * M0.4a — schema bootstrap: creates the indexes and the UNIQUE `SYMBOL.fqn`
 * constraint `SCHEMA_INDEXES`/`SCHEMA_CONSTRAINTS` declare, then read-compares
 * `META_DATA.schema_version` against `CPG_SCHEMA.version` (50-schema.md §8's
 * "read-compare-rebuild logic" — this owns the read-compare half; the
 * rebuild-on-mismatch action is left to the caller, which is M0.11's
 * orchestration, not a schema-bootstrap concern).
 *
 * Two FalkorDB mechanics this depends on, verified live against the pinned
 * v4.20.4 image before writing this file:
 *
 *   - **Index creation is not idempotent.** A second `CREATE INDEX` on an
 *     already-indexed label/property errors, so every call here reads
 *     `CALL db.indexes()` first and creates only what is missing.
 *   - **`db.indexes()` returns one row per label**, with every indexed
 *     property on that label merged into a single `properties` array
 *     (`CPG(id)` + `CPG(file)` come back as one row `CPG [id, file]`, never
 *     two) — `createMissingIndexes` below checks containment against that
 *     merged set, not exact equality, for the same reason
 *     `test/support/schema-conformance.ts`'s `checkBootstrap` does.
 *
 * The UNIQUE constraint is NOT Cypher on FalkorDB — it is the Redis command
 * `GRAPH.CONSTRAINT CREATE`, sent through `AdminService.raw()` (the typed
 * client's documented escape hatch for driver commands it doesn't model).
 * Its reply is the literal string `"PENDING"`; treating that as done is
 * exactly the bug this bootstrap exists to avoid, so it polls
 * `CALL db.constraints()` to `OPERATIONAL`/`FAILED` instead, bounded by
 * `constraintTimeoutMs`.
 */
import type { Timed } from "falkordb-service";

import { CPG_SCHEMA, SCHEMA_CONSTRAINTS, SCHEMA_INDEXES } from "../schema/schema";
import type { SchemaConstraintSpec, SchemaIndexSpec } from "../schema/types";
import { ENGINE_VERSION } from "../version";

export interface SchemaVersionResult {
  readonly expected: number;
  /** `undefined` when no `META_DATA` node existed yet. */
  readonly found: number | undefined;
  readonly action: "created" | "matched" | "mismatch";
}

export interface BootstrapReport {
  readonly indexesCreated: readonly string[];
  readonly indexesExisting: readonly string[];
  readonly constraintsCreated: readonly string[];
  readonly constraintsExisting: readonly string[];
  readonly schemaVersion: SchemaVersionResult;
}

/**
 * The minimal shape `bootstrapSchema` needs out of `GraphService` — every
 * real `GraphService` satisfies this structurally, so callers pass one
 * directly, but a DB-free unit test can pass a plain fake instead of
 * constructing a real driver-backed instance.
 */
export interface BootstrapGraph {
  readonly name: string;
  read<T = unknown>(query: string, params?: Record<string, unknown>): Promise<Timed<T>>;
  write<T = unknown>(query: string, params?: Record<string, unknown>): Promise<Timed<T>>;
}

/** The minimal shape `bootstrapSchema` needs out of `AdminService`. */
export interface BootstrapAdmin {
  raw<T = unknown>(args: string[]): Promise<T>;
}

/** The graph/admin pair `bootstrapSchema` needs — never the whole server lifecycle. */
export interface BootstrapDeps {
  readonly graph: BootstrapGraph;
  readonly admin: BootstrapAdmin;
}

export interface BootstrapOptions {
  /** Bound on polling a `PENDING` constraint reply to `OPERATIONAL`/`FAILED`. Default 5000. */
  readonly constraintTimeoutMs?: number;
  /** Poll interval while waiting. Default 100. */
  readonly constraintPollIntervalMs?: number;
}

const DEFAULT_CONSTRAINT_TIMEOUT_MS = 5_000;
const DEFAULT_CONSTRAINT_POLL_INTERVAL_MS = 100;

function describeIndex(spec: SchemaIndexSpec): string {
  return `${spec.label}(${spec.properties.join(", ")})`;
}

function describeConstraint(spec: SchemaConstraintSpec): string {
  return `${spec.type} ${spec.label}(${spec.properties.join(", ")})`;
}

interface IndexRow {
  readonly label: string;
  readonly properties: readonly string[];
}

interface ConstraintRow {
  readonly type: string;
  readonly label: string;
  readonly properties: readonly string[];
  readonly status: string;
}

async function readIndexedProperties(graph: BootstrapGraph): Promise<Map<string, Set<string>>> {
  const rows = await graph.read<IndexRow>("CALL db.indexes()");
  const byLabel = new Map<string, Set<string>>();
  for (const row of rows.data) {
    const set = byLabel.get(row.label) ?? new Set<string>();
    for (const property of row.properties) {
      set.add(property);
    }
    byLabel.set(row.label, set);
  }
  return byLabel;
}

async function readConstraints(graph: BootstrapGraph): Promise<ConstraintRow[]> {
  const rows = await graph.read<ConstraintRow>("CALL db.constraints()");
  return rows.data;
}

function constraintMatches(row: ConstraintRow, spec: SchemaConstraintSpec): boolean {
  return (
    row.type === spec.type &&
    row.label === spec.label &&
    JSON.stringify(row.properties) === JSON.stringify(spec.properties)
  );
}

/**
 * Creates every `SCHEMA_INDEXES` entry not already present. One
 * `CREATE INDEX FOR (n:<Label>) ON (n.<prop>)` per property, matching how
 * `SCHEMA_INDEXES` declares them (each entry names exactly one property in
 * v1) and the DDL form this repo's own benchmark record already proved on
 * this exact pinned image.
 */
async function createMissingIndexes(
  graph: BootstrapGraph,
): Promise<{ created: string[]; existing: string[] }> {
  const indexed = await readIndexedProperties(graph);
  const created: string[] = [];
  const existing: string[] = [];
  for (const spec of SCHEMA_INDEXES) {
    const have = indexed.get(spec.label);
    if (have !== undefined && spec.properties.every((property) => have.has(property))) {
      existing.push(describeIndex(spec));
      continue;
    }
    for (const property of spec.properties) {
      // Sequential by design: FalkorDB DDL, not parallelisable read work —
      // issuing two CREATE INDEX statements against the same graph
      // concurrently is a race this bootstrap has no reason to invite.
      // eslint-disable-next-line no-await-in-loop
      await graph.write(`CREATE INDEX FOR (n:${spec.label}) ON (n.${property})`);
    }
    created.push(describeIndex(spec));
  }
  return { created, existing };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates every `SCHEMA_CONSTRAINTS` entry not already present, via
 * `AdminService.raw()` — never Cypher. Polls to `OPERATIONAL`/`FAILED`
 * rather than trusting the immediate `PENDING` reply.
 */
async function createMissingConstraints(
  deps: BootstrapDeps,
  opts: BootstrapOptions,
): Promise<{ created: string[]; existing: string[] }> {
  const { graph, admin } = deps;
  const timeoutMs = opts.constraintTimeoutMs ?? DEFAULT_CONSTRAINT_TIMEOUT_MS;
  const pollIntervalMs = opts.constraintPollIntervalMs ?? DEFAULT_CONSTRAINT_POLL_INTERVAL_MS;
  const created: string[] = [];
  const existing: string[] = [];

  for (const spec of SCHEMA_CONSTRAINTS) {
    const label = describeConstraint(spec);
    // Sequential across specs: each must be checked and possibly created (and
    // waited for) in order before deciding the next one's starting state.
    // eslint-disable-next-line no-await-in-loop
    const already = (await readConstraints(graph)).some((row) => constraintMatches(row, spec));
    if (already) {
      existing.push(label);
      continue;
    }

    // GRAPH.CONSTRAINT CREATE <graph> UNIQUE NODE <label> PROPERTIES <n> <prop...>
    // eslint-disable-next-line no-await-in-loop
    await admin.raw<string>([
      "GRAPH.CONSTRAINT",
      "CREATE",
      graph.name,
      spec.type,
      spec.entityType,
      spec.label,
      "PROPERTIES",
      String(spec.properties.length),
      ...spec.properties,
    ]);

    const deadline = Date.now() + timeoutMs;
    let status: string | undefined;
    for (;;) {
      // Sequential by nature: a readiness poll for the PENDING -> OPERATIONAL
      // transition, not parallelisable work.
      // eslint-disable-next-line no-await-in-loop
      const row = (await readConstraints(graph)).find((r) => constraintMatches(r, spec));
      status = row?.status;
      if (status === "OPERATIONAL" || status === "FAILED" || Date.now() >= deadline) {
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(pollIntervalMs);
    }
    if (status !== "OPERATIONAL") {
      throw new Error(
        `GRAPH.CONSTRAINT CREATE for ${label} did not reach OPERATIONAL within ${timeoutMs}ms ` +
          `(last observed status: ${status ?? "not found"}).`,
      );
    }
    created.push(label);
  }
  return { created, existing };
}

interface MetadataRow {
  readonly schema_version: number | null;
}

/**
 * Reads `META_DATA.schema_version` and compares it to `CPG_SCHEMA.version`.
 * Creates the singleton when absent. Never acts on a mismatch — bootstrap
 * reports, the caller (M0.11's orchestration) decides whether to rebuild.
 */
async function readCompareMetadata(graph: BootstrapGraph): Promise<SchemaVersionResult> {
  const expected = CPG_SCHEMA.version;
  const rows = await graph.read<MetadataRow>(
    "MATCH (m:META_DATA) RETURN m.schema_version AS schema_version LIMIT 1",
  );
  const row = rows.data[0];
  if (row === undefined || row.schema_version === null) {
    await graph.write(
      "CREATE (:META_DATA {schema_version: $version, engine_version: $engineVersion, " +
        "overlays: [], created_at: $createdAt})",
      { version: expected, engineVersion: ENGINE_VERSION, createdAt: new Date().toISOString() },
    );
    return { expected, found: undefined, action: "created" };
  }
  const found = row.schema_version;
  return { expected, found, action: found === expected ? "matched" : "mismatch" };
}

/** Bootstraps a graph's indexes, constraint and `META_DATA` singleton. Safe to call repeatedly. */
export async function bootstrapSchema(
  deps: BootstrapDeps,
  opts: BootstrapOptions = {},
): Promise<BootstrapReport> {
  const { created: indexesCreated, existing: indexesExisting } = await createMissingIndexes(
    deps.graph,
  );
  const { created: constraintsCreated, existing: constraintsExisting } =
    await createMissingConstraints(deps, opts);
  const schemaVersion = await readCompareMetadata(deps.graph);
  return {
    indexesCreated,
    indexesExisting,
    constraintsCreated,
    constraintsExisting,
    schemaVersion,
  };
}
