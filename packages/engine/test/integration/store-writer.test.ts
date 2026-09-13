/**
 * M0.4b gate, live half: `FalkorGraphStore`/`planDelta` against a real
 * FalkorDB — EXPLAIN really shows an index scan on every op that should have
 * one, a duplicate-endpoint-label mistake really plans as a label scan (and
 * dropping the `WITH` barrier really plans as a Cartesian Product — both
 * proven and reverted, pasted below), and cross-file CALLS really survive a
 * rewrite of the defining file. Requires a running harness instance —
 * `bun run db:up`. The DB-free half (grouping/chunking/pruning logic against
 * hand-built deltas) is `test/unit/store/cypher.test.ts` and
 * `test/unit/store/falkordb-store.test.ts`.
 *
 * One finding from verifying this gate, worth recording: on a `:CPG
 * {file:$file}`-scoped match, FalkorDB's plain `DELETE n` and `DETACH DELETE
 * n` were confirmed EMPIRICALLY IDENTICAL — both remove exactly the matched
 * node's own relationships and leave everything else (a shared SYMBOL, a
 * cross-file CALLS edge into it) untouched. The protection 50-schema.md
 * attributes to avoiding `DETACH DELETE` is real, but it comes from the
 * `:CPG` label restriction in the MATCH clause, not from the DELETE keyword
 * — a label-less or over-broad match is the actual hazard (the legacy
 * `FalkorDBStore.ts` shape this project rejected). `planDelta` still emits
 * plain `DELETE` per the spec; this note exists so a future reader does not
 * assume a keyword swap alone is a reproducible negative control.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { EdgeRow, GraphDelta, NodeRow } from "../../src/schema/validate.ts";
import { planDelta } from "../../src/store/cypher.ts";
import { FalkorGraphStore } from "../../src/store/falkordb-store.ts";
import { openTestGraph, type TestGraph } from "../support/falkordb.ts";
import { assertGraphInvariants } from "../support/invariants.ts";
import { assertSchemaConformance } from "../support/schema-conformance.ts";

const open: TestGraph[] = [];

async function graph(label: string): Promise<TestGraph> {
  const g = await openTestGraph(label);
  open.push(g);
  return g;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((g) => g.close()));
});

function makeStore(g: TestGraph): FalkorGraphStore {
  return new FalkorGraphStore({
    graph: g.falkor.graph,
    admin: g.falkor.admin,
    close: () => Promise.resolve(),
  });
}

/**
 * A ~1k-node synthetic delta for one file: one MODULE declaring 400 METHODs
 * and 400 CALLs, each METHOD defining a SYMBOL, each CALL resolved to one of
 * them — enough scale to exercise every op kind and a real chunk boundary
 * when a small `batchSize` is used.
 */
function moduleProps(id: string, file: string): Record<string, unknown> {
  return { id, file, name: file, range: "1:0-1:0", status: "ready" };
}

function methodProps(id: string, file: string, name: string): Record<string, unknown> {
  return {
    id,
    file,
    name,
    kind: "method",
    signature: `${name}()`,
    params_count: 0,
    range: "1:0-1:0",
    exported: false,
    async: false,
    status: "ready",
  };
}

function callProps(id: string, file: string, calleeName: string): Record<string, unknown> {
  return {
    id,
    file,
    callee_name: calleeName,
    args_count: 0,
    range: "1:0-1:0",
    kind: "call",
    status: "ready",
  };
}

function bigDelta(file: string, methodCount: number): GraphDelta {
  const nodes: NodeRow[] = [
    { labels: ["CPG", "MODULE"], properties: moduleProps(`module:${file}`, file) },
  ];
  const edges: EdgeRow[] = [];
  for (let i = 0; i < methodCount; i++) {
    const methodId = `method:${file}:${i}`;
    const callId = `call:${file}:${i}`;
    const fqn = `${file}#m${i}`;
    nodes.push({ labels: ["CPG", "METHOD"], properties: methodProps(methodId, file, `m${i}`) });
    nodes.push({ labels: ["CPG", "CALL"], properties: callProps(callId, file, `m${i}`) });
    nodes.push({ labels: ["SYMBOL"], properties: { fqn, kind: "method" } });
    edges.push({
      type: "DEFINES",
      fromLabel: "METHOD",
      toLabel: "SYMBOL",
      fromKey: methodId,
      toKey: fqn,
      properties: {},
    });
    edges.push({
      type: "CALLS",
      fromLabel: "CALL",
      toLabel: "SYMBOL",
      fromKey: callId,
      toKey: fqn,
      properties: { status: "resolved" },
    });
  }
  return { file, nodes, edges };
}

describe("FalkorGraphStore.writeDelta — scale + EXPLAIN", () => {
  test("writes a ~1k-node delta, EXPLAIN confirms the right plan shape per op kind", async () => {
    const g = await graph("writer scale");
    const store = makeStore(g);
    await store.bootstrap();

    const delta = bigDelta("src/big.ts", 400);
    const report = await store.writeDelta(delta);
    expect(report.nodesWritten).toBe(delta.nodes.length);
    expect(report.edgesWritten).toBe(delta.edges.length);

    const nodeCount = await g.falkor.graph.scalar(
      "MATCH (n:CPG {file: 'src/big.ts'}) RETURN count(n) AS n",
    );
    expect(nodeCount).toBe(1 + 400 + 400); // MODULE + METHODs + CALLs
    const symbolCount = await g.falkor.graph.scalar("MATCH (s:SYMBOL) RETURN count(s) AS n");
    expect(symbolCount).toBe(400);
    const definesCount = await g.falkor.graph.scalar(
      "MATCH ()-[r:DEFINES]->() RETURN count(r) AS n",
    );
    expect(definesCount).toBe(400);
    const callsCount = await g.falkor.graph.scalar("MATCH ()-[r:CALLS]->() RETURN count(r) AS n");
    expect(callsCount).toBe(400);

    const ops = planDelta(delta);
    for (const op of ops) {
      // eslint-disable-next-line no-await-in-loop
      const plan = (await g.falkor.graph.explain(op.cypher, op.params)).join("\n");
      // Every op: never a full scan, never a bare label scan.
      expect(plan).not.toMatch(/All Node Scan/);
      expect(plan).not.toMatch(/Label Scan/);
      if (op.kind === "edge" || op.kind === "node-merge" || op.kind === "scope-delete") {
        expect(plan).toMatch(/Node By Index Scan/);
      }
      if (op.kind === "edge") {
        expect(plan).toMatch(/Project/);
      }
      if (op.kind === "node-create") {
        // No scan at all: UNWIND -> CREATE -> SET, nothing indexed to look up.
        expect(plan).not.toMatch(/Scan/);
      }
    }

    await assertGraphInvariants(g.falkor.graph);
    await assertSchemaConformance(g.falkor.graph, { requireIndexes: true });
  });

  test("re-writing the same delta yields identical counts", async () => {
    const g = await graph("writer rewrite idempotent");
    const store = makeStore(g);
    await store.bootstrap();
    const delta = bigDelta("src/small.ts", 20);

    const first = await store.writeDelta(delta);
    const countsAfterFirst = await g.falkor.graph.scalar(
      "MATCH (n:CPG {file: 'src/small.ts'}) RETURN count(n) AS n",
    );
    const second = await store.writeDelta(delta);
    const countsAfterSecond = await g.falkor.graph.scalar(
      "MATCH (n:CPG {file: 'src/small.ts'}) RETURN count(n) AS n",
    );

    expect(second.nodesWritten).toBe(first.nodesWritten);
    expect(second.edgesWritten).toBe(first.edgesWritten);
    expect(countsAfterSecond).toBe(countsAfterFirst);
    // SYMBOLs are merge-on-key: no duplicates from the second write.
    const symbolCount = await g.falkor.graph.scalar("MATCH (s:SYMBOL) RETURN count(s) AS n");
    expect(symbolCount).toBe(20);

    await assertGraphInvariants(g.falkor.graph);
  });

  test("chunks at a small batch size and still produces the same graph", async () => {
    const g = await graph("writer chunking");
    const store = makeStore(g);
    await store.bootstrap();
    const delta = bigDelta("src/chunked.ts", 25);

    const ops = planDelta(delta, { batchSize: 4 });
    // At least one kind genuinely split into more than one op.
    const methodCreateOps = ops.filter((op) => op.kind === "node-create" && op.group === "METHOD");
    expect(methodCreateOps.length).toBeGreaterThan(1);

    for (const op of ops) {
      // eslint-disable-next-line no-await-in-loop
      await g.falkor.graph.write(op.cypher, op.params);
    }

    const methodCount = await g.falkor.graph.scalar(
      "MATCH (n:METHOD {file: 'src/chunked.ts'}) RETURN count(n) AS n",
    );
    expect(methodCount).toBe(25);
    await assertGraphInvariants(g.falkor.graph);
  });
});

describe("FalkorGraphStore.writeDelta — cross-file correctness", () => {
  test("a cross-file CALLS edge survives a rewrite of the defining file", async () => {
    const g = await graph("cross-file survives rewrite");
    const store = makeStore(g);
    await store.bootstrap();

    // File A defines the SYMBOL; file B's CALL resolves to it.
    const fileA: GraphDelta = {
      file: "src/a.ts",
      nodes: [
        { labels: ["CPG", "MODULE"], properties: moduleProps("module:a", "src/a.ts") },
        {
          labels: ["CPG", "METHOD"],
          properties: methodProps("method:a.alpha", "src/a.ts", "alpha"),
        },
        { labels: ["SYMBOL"], properties: { fqn: "src/a.ts#alpha", kind: "function" } },
      ],
      edges: [
        {
          type: "DEFINES",
          fromLabel: "METHOD",
          toLabel: "SYMBOL",
          fromKey: "method:a.alpha",
          toKey: "src/a.ts#alpha",
          properties: {},
        },
      ],
    };
    const fileB: GraphDelta = {
      file: "src/b.ts",
      nodes: [
        { labels: ["CPG", "MODULE"], properties: moduleProps("module:b", "src/b.ts") },
        { labels: ["CPG", "CALL"], properties: callProps("call:b.0", "src/b.ts", "alpha") },
      ],
      edges: [
        {
          type: "CALLS",
          fromLabel: "CALL",
          toLabel: "SYMBOL",
          fromKey: "call:b.0",
          toKey: "src/a.ts#alpha",
          properties: { status: "resolved" },
        },
      ],
    };

    await store.writeDelta(fileA);
    await store.writeDelta(fileB);

    const before = await g.falkor.graph.scalar(
      "MATCH (:CALL {id:'call:b.0'})-[:CALLS]->(:SYMBOL {fqn:'src/a.ts#alpha'}) RETURN count(*) AS n",
    );
    expect(before).toBe(1);

    // Re-save file A — a body-only change, same declarations. The DEFINES
    // edge is recreated, but the SYMBOL (merge-on-key, no `file` property)
    // and B's CALLS edge into it must be untouched by A's scope delete.
    await store.writeDelta(fileA);

    const after = await g.falkor.graph.scalar(
      "MATCH (:CALL {id:'call:b.0'})-[:CALLS]->(:SYMBOL {fqn:'src/a.ts#alpha'}) RETURN count(*) AS n",
    );
    expect(after).toBe(1);
    const symbolCount = await g.falkor.graph.scalar(
      "MATCH (s:SYMBOL {fqn:'src/a.ts#alpha'}) RETURN count(s) AS n",
    );
    expect(symbolCount).toBe(1); // not duplicated, not orphaned

    await assertGraphInvariants(g.falkor.graph);
    await assertSchemaConformance(g.falkor.graph, { requireIndexes: true });
  });
});

describe("planDelta — negative controls (proven live, then not applicable)", () => {
  test("an edge endpoint matched on its kind label plans as a Label Scan, not an Index Scan", async () => {
    const g = await graph("negative control label scan");
    await g.falkor.graph.write(
      "CREATE (:CPG:METHOD {id:'m1', file:'x.ts'}) CREATE (:SYMBOL {fqn:'x.ts#m1'})",
    );
    // The mistake planDelta's own endpointShape() exists to make impossible:
    // matching by the kind label instead of :CPG.
    const bad =
      "UNWIND $rows AS row MATCH (s:METHOD {id: row.from}) WITH s, row " +
      "MATCH (t:SYMBOL {fqn: row.to}) CREATE (s)-[r:DEFINES]->(t) SET r = row.props";
    const plan = (await g.falkor.graph.explain(bad, { rows: [] })).join("\n");
    expect(plan).toMatch(/Label Scan/);
  });

  test("dropping the WITH barrier plans as a Cartesian Product, not two index scans", async () => {
    const g = await graph("negative control cartesian");
    const bad =
      "UNWIND $rows AS row MATCH (s:CPG {id: row.from}), (t:SYMBOL {fqn: row.to}) " +
      "CREATE (s)-[r:DEFINES]->(t) SET r = row.props";
    const plan = (await g.falkor.graph.explain(bad, { rows: [] })).join("\n");
    expect(plan).toMatch(/Cartesian Product/);
  });
});
