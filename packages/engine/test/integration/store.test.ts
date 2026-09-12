/**
 * F2 gate: the harness connects to a pinned FalkorDB, writes a handful of
 * nodes, reads them back, asserts the global invariants and drops its graph.
 *
 * Requires a running harness instance — `bun run db:up`. It is deliberately not
 * part of `test:unit`, which stays DB-free so the standing gates run anywhere.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { openTestGraph, type TestGraph } from "../support/falkordb.ts";
import { assertGraphInvariants, checkGraphInvariants } from "../support/invariants.ts";
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

/**
 * A minimal well-formed slice of the schema (M0.0): one ready FILE, a MODULE
 * DEFINES-ing two SYMBOLs, and a CALL resolved into one of them. Satisfies
 * every invariant AND every schema rule, so a test that breaks one has
 * broken it deliberately.
 *
 * Schema-shaped on purpose, not just invariant-shaped: SYMBOL carries no
 * `file` property (D5 — that is what makes it survive a per-file replace);
 * DEFINES originates from a MODULE, not a FILE (FILE is not in DEFINES'
 * declared `from` set); CALL carries the `:CPG` co-label plus its required
 * properties and an `id`.
 */
async function seed(g: TestGraph, file = "src/a.ts"): Promise<void> {
  const name = file.split("/").pop();
  await g.falkor.graph.write(
    `CREATE (f:FILE {path:$file, name:$name, language:'typescript', content_hash:'seed', status:'ready', version:1})
     CREATE (m:CPG:MODULE {id:$moduleId, name:$name, file:$file, range:'1:0-1:0', status:'ready'})
     CREATE (a:SYMBOL {fqn:$fqnA})
     CREATE (b:SYMBOL {fqn:$fqnB})
     CREATE (c:CPG:CALL {id:$callId, callee_name:'alpha', args_count:0, file:$file, range:'1:0-1:0', kind:'call', status:'ready'})
     CREATE (m)-[:DEFINES]->(a)
     CREATE (m)-[:DEFINES]->(b)
     CREATE (c)-[:CALLS {status:'resolved'}]->(a)`,
    {
      file,
      name,
      moduleId: `module:${file}`,
      callId: `call:${file}:0`,
      fqnA: `${file}#alpha`,
      fqnB: `${file}#beta`,
    },
  );
}

describe("FalkorDB store client", () => {
  test("writes nodes, reads them back, and satisfies the invariants", async () => {
    const g = await graph("round trip");
    await seed(g);

    const files = await g.falkor.graph.scalar("MATCH (f:FILE) RETURN count(f) AS n");
    expect(files).toBe(1);

    const symbols = await g.falkor.graph.read<{ fqn: string }>(
      "MATCH (s:SYMBOL) RETURN s.fqn AS fqn ORDER BY s.fqn",
    );
    expect(symbols.data.map((r) => r.fqn)).toEqual(["src/a.ts#alpha", "src/a.ts#beta"]);

    // Both timings are reported on every query.
    expect(symbols.wallMs).toBeGreaterThan(0);
    expect(Number.isNaN(symbols.serverMs)).toBe(false);

    await assertGraphInvariants(g.falkor.graph);
    await assertSchemaConformance(g.falkor.graph);
  });

  test("read() is read-only at the server, not by convention", async () => {
    const g = await graph("ro enforcement");
    // GRAPH.RO_QUERY rejects write clauses inside FalkorDB itself.
    await expect(g.falkor.graph.read("CREATE (:SYMBOL {fqn:'nope'})")).rejects.toThrow(
      /read-only/i,
    );
    const count = await g.falkor.graph.scalar("MATCH (n) RETURN count(n) AS n");
    expect(count).toBe(0);
  });

  test("explain returns a plan", async () => {
    const g = await graph("explain");
    const plan = await g.falkor.graph.explain("MATCH (s:SYMBOL {fqn:'x'}) RETURN s");
    expect(plan.join("\n")).toMatch(/Scan/i);
  });

  test("dropGraph removes the key and is safe to repeat", async () => {
    const g = await graph("drop");
    await seed(g);
    expect(await g.falkor.admin.listGraphs()).toContain(g.key);
    await g.falkor.admin.dropGraph();
    await g.falkor.admin.dropGraph();
    expect(await g.falkor.admin.listGraphs()).not.toContain(g.key);
  });
});

describe("graph invariants", () => {
  test("a duplicate SYMBOL fqn is caught", async () => {
    const g = await graph("dup fqn");
    await seed(g);
    await g.falkor.graph.write(
      "CREATE (f:FILE {path:'src/b.ts', status:'ready'}) WITH f CREATE (f)-[:DEFINES]->(:SYMBOL {fqn:'src/a.ts#alpha'})",
    );

    const result = await checkGraphInvariants(g.falkor.graph);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/duplicate SYMBOL fqn/);
    await expect(assertGraphInvariants(g.falkor.graph)).rejects.toThrow(/duplicate SYMBOL fqn/);
  });

  test("an orphan SYMBOL is caught", async () => {
    const g = await graph("orphan");
    await seed(g);
    await g.falkor.graph.write("CREATE (:SYMBOL {fqn:'src/a.ts#stranded', file:'src/a.ts'})");

    const result = await checkGraphInvariants(g.falkor.graph);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/orphan SYMBOL\(s\) globally: src\/a\.ts#stranded/);
  });

  test("a FILE left mid-replace is caught", async () => {
    const g = await graph("non ready file");
    await seed(g);
    await g.falkor.graph.write("MATCH (f:FILE {path:'src/a.ts'}) SET f.status = 'updating'");

    const result = await checkGraphInvariants(g.falkor.graph);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/non-ready status: src\/a\.ts=updating/);
  });

  test("all three violations are reported together, not just the first", async () => {
    const g = await graph("all three");
    await seed(g);
    await g.falkor.graph.write(
      `CREATE (:SYMBOL {fqn:'src/a.ts#alpha'})
       CREATE (:SYMBOL {fqn:'src/a.ts#stranded'})`,
    );
    await g.falkor.graph.write("MATCH (f:FILE {path:'src/a.ts'}) SET f.status = 'updating'");

    const result = await checkGraphInvariants(g.falkor.graph);
    expect(result.problems).toHaveLength(3);
  });

  test("repairing the graph makes the invariants green again", async () => {
    const g = await graph("repair");
    await seed(g);
    await g.falkor.graph.write("CREATE (:SYMBOL {fqn:'src/a.ts#stranded'})");
    expect((await checkGraphInvariants(g.falkor.graph)).ok).toBe(false);

    await g.falkor.graph.write("MATCH (s:SYMBOL {fqn:'src/a.ts#stranded'}) DELETE s");
    await assertGraphInvariants(g.falkor.graph);
  });
});
