/**
 * DB-free coverage for `FalkorGraphStore`'s own orchestration logic — not
 * `planDelta` (covered by `cypher.test.ts`) or `bootstrapSchema` (covered by
 * `bootstrap.test.ts`), both of which this class only delegates to. Exercised
 * against a fake `BootstrapGraph`/`BootstrapAdmin` pair, no live server.
 */
import { describe, expect, test } from "bun:test";

import type { Timed } from "../../../../falkordb-service/src/index.ts";
import type { BootstrapAdmin, BootstrapGraph } from "../../../src/store/bootstrap.ts";
import { FalkorGraphStore } from "../../../src/store/falkordb-store.ts";

function timed<T>(data: T[]): Timed<T> {
  return { data, wallMs: 0, serverMs: 0, meta: [] };
}

interface FakeCall {
  query: string;
  params?: Record<string, unknown>;
}

interface ConstraintRow {
  type: string;
  label: string;
  properties: string[];
  status: string;
}

function makeFakeGraph(metaRow?: Record<string, unknown>) {
  const writes: FakeCall[] = [];
  const constraintRows: ConstraintRow[] = [];
  const graph: BootstrapGraph = {
    name: "fake_graph",
    async read<T>(query: string): Promise<Timed<T>> {
      if (query.includes("META_DATA")) {
        return timed((metaRow ? [metaRow] : []) as unknown as T[]);
      }
      if (query.includes("db.constraints")) {
        return timed(constraintRows as unknown as T[]);
      }
      if (query.includes("db.indexes")) {
        return timed([] as T[]);
      }
      throw new Error(`fake graph: unexpected read query: ${query}`);
    },
    async write<T>(query: string, params?: Record<string, unknown>): Promise<Timed<T>> {
      writes.push({ query, params });
      return timed([] as T[]);
    },
  };
  return { graph, writes, constraintRows };
}

/**
 * A fake admin whose GRAPH.CONSTRAINT CREATE reports OPERATIONAL immediately
 * (appending straight into the shared graph's constraint rows) — this file
 * is testing `FalkorGraphStore`'s own delegation, not `bootstrapSchema`'s
 * PENDING-polling behaviour (covered by `bootstrap.test.ts`), so there is no
 * reason to make this test wait out a real poll loop.
 */
function makeFakeAdmin(constraintRows: ConstraintRow[]): BootstrapAdmin {
  return {
    async raw<T>(args: string[]): Promise<T> {
      if (args[0] === "GRAPH.CONSTRAINT" && args[1] === "CREATE") {
        const [, , , type, , label, , , ...properties] = args;
        constraintRows.push({ type: type!, label: label!, properties, status: "OPERATIONAL" });
      }
      return "PENDING" as unknown as T;
    },
  };
}

describe("FalkorGraphStore.writeDelta", () => {
  test("executes every planned op, in order, via graph.write", async () => {
    const { graph, writes, constraintRows } = makeFakeGraph();
    const closed: boolean[] = [];
    const store = new FalkorGraphStore({
      graph,
      admin: makeFakeAdmin(constraintRows),
      close: async () => {
        closed.push(true);
      },
    });

    const report = await store.writeDelta({
      file: "src/a.ts",
      nodes: [{ labels: ["CPG", "METHOD"], properties: { id: "m1" } }],
      edges: [],
    });

    expect(report).toEqual({ nodesWritten: 1, edgesWritten: 0, opsExecuted: 2 });
    // Scope delete first, then the node-create op — planDelta's own order.
    expect(writes[0]!.query).toBe("MATCH (n:CPG {file: $file}) DELETE n");
    expect(writes[0]!.params).toEqual({ file: "src/a.ts" });
    expect(writes[1]!.query).toBe("UNWIND $rows AS row CREATE (n:CPG:METHOD) SET n = row");

    await store.close();
    expect(closed).toEqual([true]);
  });
});

describe("FalkorGraphStore.writeFilesystem", () => {
  test("plans and executes planFilesystem's ops in order, reporting the right counts", async () => {
    const { graph, writes, constraintRows } = makeFakeGraph();
    const store = new FalkorGraphStore({
      graph,
      admin: makeFakeAdmin(constraintRows),
      close: async () => {},
    });

    const report = await store.writeFilesystem({
      directories: [
        { path: ".", name: ".", parent: undefined },
        { path: "src", name: "src", parent: "." },
      ],
      files: [
        {
          path: "src/a.ts",
          name: "a.ts",
          parent: "src",
          language: "typescript",
          content_hash: "abc",
          status: "ready",
          version: 1,
          indexed_at: "2026-01-01T00:00:00.000Z",
          loc: 1,
        },
      ],
    });

    // 2 directories + 1 file merged, 1 dir link + 1 file link.
    expect(report).toEqual({ nodesWritten: 3, edgesWritten: 2, opsExecuted: 4 });
    expect(writes.some((w) => w.query.includes("MERGE (d:DIRECTORY"))).toBe(true);
    expect(writes.some((w) => w.query.includes("MERGE (f:FILE"))).toBe(true);
    expect(writes.some((w) => w.query.includes("MERGE (p)-[:HAS_ENTRY]->(c)"))).toBe(true);
  });
});

describe("FalkorGraphStore.deleteFile", () => {
  test("issues only the scope delete, with no replacement", async () => {
    const { graph, writes, constraintRows } = makeFakeGraph();
    const store = new FalkorGraphStore({
      graph,
      admin: makeFakeAdmin(constraintRows),
      close: async () => {},
    });

    await store.deleteFile("src/gone.ts");

    expect(writes).toHaveLength(1);
    expect(writes[0]!.query).toBe("MATCH (n:CPG {file: $file}) DELETE n");
    expect(writes[0]!.params).toEqual({ file: "src/gone.ts" });
  });
});

describe("FalkorGraphStore.readMetadata", () => {
  test("returns undefined when no META_DATA node exists", async () => {
    const { graph, constraintRows } = makeFakeGraph(undefined);
    const store = new FalkorGraphStore({
      graph,
      admin: makeFakeAdmin(constraintRows),
      close: async () => {},
    });

    expect(await store.readMetadata()).toBeUndefined();
  });

  test("maps the META_DATA row, defaulting a null engine_version/overlays", async () => {
    const { graph, constraintRows } = makeFakeGraph({
      schema_version: 2,
      engine_version: null,
      overlays: null,
    });
    const store = new FalkorGraphStore({
      graph,
      admin: makeFakeAdmin(constraintRows),
      close: async () => {},
    });

    expect(await store.readMetadata()).toEqual({
      schemaVersion: 2,
      engineVersion: undefined,
      overlays: [],
    });
  });

  test("passes through a real engine_version/overlays", async () => {
    const { graph, constraintRows } = makeFakeGraph({
      schema_version: 2,
      engine_version: "0.0.1",
      overlays: ["community"],
    });
    const store = new FalkorGraphStore({
      graph,
      admin: makeFakeAdmin(constraintRows),
      close: async () => {},
    });

    expect(await store.readMetadata()).toEqual({
      schemaVersion: 2,
      engineVersion: "0.0.1",
      overlays: ["community"],
    });
  });
});

describe("FalkorGraphStore.bootstrap", () => {
  test("delegates to bootstrapSchema with this store's own graph/admin", async () => {
    const { graph, constraintRows } = makeFakeGraph();
    const store = new FalkorGraphStore({
      graph,
      admin: makeFakeAdmin(constraintRows),
      close: async () => {},
    });

    const report = await store.bootstrap();

    expect(report.indexesCreated.length).toBeGreaterThan(0);
    expect(report.schemaVersion.action).toBe("created");
  });
});
