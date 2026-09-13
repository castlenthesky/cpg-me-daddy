/**
 * DB-free half of M0.4a's gate: `bootstrapSchema` exercised against a fake
 * `BootstrapGraph`/`BootstrapAdmin` pair, never a live FalkorDB. The live half
 * (indexes really created, the constraint really reaching OPERATIONAL, a
 * duplicate SYMBOL.fqn really rejected by the server) is
 * `test/integration/bootstrap.test.ts`.
 */
import { describe, expect, test } from "bun:test";

import type { Timed } from "../../../../falkordb-service/src/index.ts";
import { CPG_SCHEMA } from "../../../src/schema/index.ts";
import {
  bootstrapSchema,
  type BootstrapAdmin,
  type BootstrapGraph,
} from "../../../src/store/bootstrap.ts";

function timed<T>(data: T[]): Timed<T> {
  return { data, wallMs: 0, serverMs: 0, meta: [] };
}

interface IndexRow {
  label: string;
  properties: string[];
}
interface ConstraintRow {
  type: string;
  label: string;
  properties: string[];
  status: string;
}
interface MetaRow {
  schema_version: number | null;
}

interface FakeState {
  indexRows: IndexRow[];
  constraintRows: ConstraintRow[];
  metaRows: MetaRow[];
}

interface FakeCall {
  query: string;
  params?: Record<string, unknown>;
}

/**
 * A minimal in-memory stand-in for a live graph, structurally typed against
 * `BootstrapGraph` — no real `GraphService`/driver connection anywhere.
 */
function makeFakeGraph(state: FakeState) {
  const writes: FakeCall[] = [];
  const reads: FakeCall[] = [];
  const graph: BootstrapGraph = {
    name: "fake_graph",
    async read<T>(query: string): Promise<Timed<T>> {
      reads.push({ query });
      if (query.includes("db.indexes")) {
        return timed(state.indexRows as unknown as T[]);
      }
      if (query.includes("db.constraints")) {
        return timed(state.constraintRows as unknown as T[]);
      }
      if (query.includes("META_DATA")) {
        return timed(state.metaRows as unknown as T[]);
      }
      throw new Error(`fake graph: unexpected read query: ${query}`);
    },
    async write<T>(query: string, params?: Record<string, unknown>): Promise<Timed<T>> {
      writes.push({ query, params });
      if (query.startsWith("CREATE (:META_DATA")) {
        state.metaRows = [{ schema_version: params!.version as number }];
      }
      // CREATE INDEX statements have no rows to return; the fake does not
      // need to mutate state.indexRows for the tests below, since each test
      // sets up the post-bootstrap indexRows it cares about directly.
      return timed([] as T[]);
    },
  };
  return { graph, writes, reads };
}

/**
 * A fake `AdminService.raw()` that, on the GRAPH.CONSTRAINT CREATE call,
 * appends a PENDING row to `state.constraintRows` and flips it to
 * OPERATIONAL after `becomesOperationalAfterReads` subsequent
 * `db.constraints()` reads — modelling the real async PENDING -> OPERATIONAL
 * transition without a live server.
 */
function makeFakeAdmin(state: FakeState, opts: { becomesOperationalAfterReads?: number } = {}) {
  const rawCalls: string[][] = [];
  let readsSincePending = 0;
  const becomesOperationalAfterReads = opts.becomesOperationalAfterReads ?? 0;

  const admin: BootstrapAdmin = {
    async raw<T>(args: string[]): Promise<T> {
      rawCalls.push(args);
      if (args[0] === "GRAPH.CONSTRAINT" && args[1] === "CREATE") {
        const [, , , type, entityType, label, , , ...properties] = args;
        state.constraintRows.push({
          type: type!,
          label: label!,
          properties,
          status: becomesOperationalAfterReads <= 0 ? "OPERATIONAL" : "PENDING",
        });
        void entityType;
      }
      return "PENDING" as unknown as T;
    },
  };

  // Patch the shared state's constraint row to flip status after N reads by
  // wrapping the graph's read in the test itself would be circular, so
  // instead we expose a hook the test calls indirectly: bump a counter each
  // time db.constraints() is read via the graph fake, and flip status once
  // the threshold is hit. Since makeFakeGraph doesn't know about this admin,
  // do the flip here by intercepting via a getter the test wires up.
  return {
    admin,
    rawCalls,
    /** Call once per `db.constraints()` read to simulate eventual readiness. */
    onConstraintsRead(): void {
      if (becomesOperationalAfterReads <= 0) {
        return;
      }
      readsSincePending += 1;
      if (readsSincePending >= becomesOperationalAfterReads) {
        for (const row of state.constraintRows) {
          if (row.status === "PENDING") {
            row.status = "OPERATIONAL";
          }
        }
      }
    },
  };
}

/** Wires a fake graph's reads of db.constraints() through `onConstraintsRead`. */
function withConstraintPolling(
  graph: BootstrapGraph,
  onConstraintsRead: () => void,
): BootstrapGraph {
  return {
    ...graph,
    async read<T>(query: string, params?: Record<string, unknown>): Promise<Timed<T>> {
      if (query.includes("db.constraints")) {
        onConstraintsRead();
      }
      return graph.read<T>(query, params);
    },
  };
}

describe("bootstrapSchema — indexes", () => {
  test("creates every declared index on a fresh graph", async () => {
    const state: FakeState = { indexRows: [], constraintRows: [], metaRows: [] };
    const { graph, writes } = makeFakeGraph(state);
    const { admin } = makeFakeAdmin(state);

    const report = await bootstrapSchema({ graph, admin });

    expect(report.indexesCreated.toSorted()).toEqual(
      ["CPG(id)", "CPG(file)", "FILE(path)", "DIRECTORY(path)", "SYMBOL(fqn)"].toSorted(),
    );
    expect(report.indexesExisting).toEqual([]);

    const indexWrites = writes.filter((w) => w.query.startsWith("CREATE INDEX"));
    expect(indexWrites.map((w) => w.query).toSorted()).toEqual(
      [
        "CREATE INDEX FOR (n:CPG) ON (n.id)",
        "CREATE INDEX FOR (n:CPG) ON (n.file)",
        "CREATE INDEX FOR (n:FILE) ON (n.path)",
        "CREATE INDEX FOR (n:DIRECTORY) ON (n.path)",
        "CREATE INDEX FOR (n:SYMBOL) ON (n.fqn)",
      ].toSorted(),
    );
  });

  test("regression: a merged multi-property index row is read as fully satisfied, not partially missing", async () => {
    // The exact shape FalkorDB actually returns: ONE row for CPG carrying
    // BOTH indexed properties, not two rows. A matcher that compared
    // `row.properties` by exact array equality against each single-property
    // SCHEMA_INDEXES entry would report both CPG(id) and CPG(file) missing
    // here, even though the graph is fully bootstrapped.
    const state: FakeState = {
      indexRows: [
        { label: "CPG", properties: ["id", "file"] },
        { label: "FILE", properties: ["path"] },
        { label: "DIRECTORY", properties: ["path"] },
        { label: "SYMBOL", properties: ["fqn"] },
      ],
      constraintRows: [
        { type: "UNIQUE", label: "SYMBOL", properties: ["fqn"], status: "OPERATIONAL" },
      ],
      metaRows: [{ schema_version: CPG_SCHEMA.version }],
    };
    const { graph, writes } = makeFakeGraph(state);
    const { admin } = makeFakeAdmin(state);

    const report = await bootstrapSchema({ graph, admin });

    expect(report.indexesCreated).toEqual([]);
    expect(report.indexesExisting.toSorted()).toEqual(
      ["CPG(id)", "CPG(file)", "FILE(path)", "DIRECTORY(path)", "SYMBOL(fqn)"].toSorted(),
    );
    expect(writes.some((w) => w.query.startsWith("CREATE INDEX"))).toBe(false);
  });

  test("second run against an already-bootstrapped graph creates nothing", async () => {
    const state: FakeState = {
      indexRows: [
        { label: "CPG", properties: ["id", "file"] },
        { label: "FILE", properties: ["path"] },
        { label: "DIRECTORY", properties: ["path"] },
        { label: "SYMBOL", properties: ["fqn"] },
      ],
      constraintRows: [
        { type: "UNIQUE", label: "SYMBOL", properties: ["fqn"], status: "OPERATIONAL" },
      ],
      metaRows: [{ schema_version: CPG_SCHEMA.version }],
    };
    const { graph } = makeFakeGraph(state);
    const { admin, rawCalls } = makeFakeAdmin(state);

    const report = await bootstrapSchema({ graph, admin });

    expect(report.indexesCreated).toEqual([]);
    expect(report.constraintsCreated).toEqual([]);
    expect(rawCalls).toEqual([]);
    expect(report.schemaVersion.action).toBe("matched");
  });
});

describe("bootstrapSchema — constraint", () => {
  test("sends the exact GRAPH.CONSTRAINT CREATE argument array", async () => {
    const state: FakeState = {
      indexRows: [{ label: "SYMBOL", properties: ["fqn"] }],
      constraintRows: [],
      metaRows: [{ schema_version: CPG_SCHEMA.version }],
    };
    const { graph } = makeFakeGraph(state);
    const { admin, rawCalls } = makeFakeAdmin(state);

    await bootstrapSchema({ graph, admin });

    expect(rawCalls).toEqual([
      [
        "GRAPH.CONSTRAINT",
        "CREATE",
        "fake_graph",
        "UNIQUE",
        "NODE",
        "SYMBOL",
        "PROPERTIES",
        "1",
        "fqn",
      ],
    ]);
  });

  test("polls a PENDING reply through to OPERATIONAL before reporting created", async () => {
    const state: FakeState = { indexRows: [], constraintRows: [], metaRows: [] };
    const { graph: baseGraph } = makeFakeGraph(state);
    const { admin, onConstraintsRead } = makeFakeAdmin(state, { becomesOperationalAfterReads: 3 });
    const graph = withConstraintPolling(baseGraph, onConstraintsRead);

    const report = await bootstrapSchema(
      { graph, admin },
      { constraintPollIntervalMs: 1, constraintTimeoutMs: 1000 },
    );

    expect(report.constraintsCreated).toEqual(["UNIQUE SYMBOL(fqn)"]);
  });

  test("throws if the constraint never leaves PENDING within the timeout", async () => {
    const state: FakeState = { indexRows: [], constraintRows: [], metaRows: [] };
    const { graph } = makeFakeGraph(state);
    // becomesOperationalAfterReads left unset (0) but the raw() call still
    // seeds a PENDING row that never flips — simulating a stuck constraint.
    const admin: BootstrapAdmin = {
      async raw<T>(_args: string[]): Promise<T> {
        state.constraintRows.push({
          type: "UNIQUE",
          label: "SYMBOL",
          properties: ["fqn"],
          status: "PENDING",
        });
        return "PENDING" as unknown as T;
      },
    };

    await expect(
      bootstrapSchema({ graph, admin }, { constraintTimeoutMs: 20, constraintPollIntervalMs: 5 }),
    ).rejects.toThrow(/did not reach OPERATIONAL/);
  });
});

describe("bootstrapSchema — META_DATA", () => {
  test("creates the singleton with the current schema version when absent", async () => {
    const state: FakeState = {
      indexRows: [
        { label: "CPG", properties: ["id", "file"] },
        { label: "FILE", properties: ["path"] },
        { label: "DIRECTORY", properties: ["path"] },
        { label: "SYMBOL", properties: ["fqn"] },
      ],
      constraintRows: [
        { type: "UNIQUE", label: "SYMBOL", properties: ["fqn"], status: "OPERATIONAL" },
      ],
      metaRows: [],
    };
    const { graph, writes } = makeFakeGraph(state);
    const { admin } = makeFakeAdmin(state);

    const report = await bootstrapSchema({ graph, admin });

    expect(report.schemaVersion).toEqual({
      expected: CPG_SCHEMA.version,
      found: undefined,
      action: "created",
    });
    const metaWrite = writes.find((w) => w.query.startsWith("CREATE (:META_DATA"));
    expect(metaWrite?.params?.version).toBe(CPG_SCHEMA.version);
    expect(metaWrite?.params?.overlays).toBeUndefined(); // overlays is a literal `[]` in the query, not a param
  });

  test("reports 'matched' without writing when the version already agrees", async () => {
    const state: FakeState = {
      indexRows: [
        { label: "CPG", properties: ["id", "file"] },
        { label: "FILE", properties: ["path"] },
        { label: "DIRECTORY", properties: ["path"] },
        { label: "SYMBOL", properties: ["fqn"] },
      ],
      constraintRows: [
        { type: "UNIQUE", label: "SYMBOL", properties: ["fqn"], status: "OPERATIONAL" },
      ],
      metaRows: [{ schema_version: CPG_SCHEMA.version }],
    };
    const { graph, writes } = makeFakeGraph(state);
    const { admin } = makeFakeAdmin(state);

    const report = await bootstrapSchema({ graph, admin });

    expect(report.schemaVersion).toEqual({
      expected: CPG_SCHEMA.version,
      found: CPG_SCHEMA.version,
      action: "matched",
    });
    expect(writes.some((w) => w.query.startsWith("CREATE (:META_DATA"))).toBe(false);
  });

  test("reports 'mismatch' without acting when the recorded version differs — bootstrap reports, callers decide", async () => {
    const staleVersion = CPG_SCHEMA.version - 1;
    const state: FakeState = {
      indexRows: [
        { label: "CPG", properties: ["id", "file"] },
        { label: "FILE", properties: ["path"] },
        { label: "DIRECTORY", properties: ["path"] },
        { label: "SYMBOL", properties: ["fqn"] },
      ],
      constraintRows: [
        { type: "UNIQUE", label: "SYMBOL", properties: ["fqn"], status: "OPERATIONAL" },
      ],
      metaRows: [{ schema_version: staleVersion }],
    };
    const { graph, writes } = makeFakeGraph(state);
    const { admin } = makeFakeAdmin(state);

    const report = await bootstrapSchema({ graph, admin });

    expect(report.schemaVersion).toEqual({
      expected: CPG_SCHEMA.version,
      found: staleVersion,
      action: "mismatch",
    });
    expect(writes.some((w) => w.query.startsWith("CREATE (:META_DATA"))).toBe(false);
    expect(state.metaRows).toEqual([{ schema_version: staleVersion }]); // untouched
  });
});
