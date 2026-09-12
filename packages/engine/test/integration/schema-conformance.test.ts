/**
 * M0.0 gate, live half: `checkSchemaConformance`/`assertSchemaConformance`
 * against a real FalkorDB. Requires a running harness instance —
 * `bun run db:up`. Mirrors `store.test.ts`'s "graph invariants" describe
 * block in shape: seed a schema-valid slice, corrupt one thing at a time,
 * confirm the check catches it, confirm repair clears it.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { openTestGraph, type TestGraph } from "../support/falkordb.ts";
import { checkSchemaConformance } from "../support/schema-conformance.ts";

const open: TestGraph[] = [];

async function graph(label: string): Promise<TestGraph> {
  const g = await openTestGraph(label);
  open.push(g);
  return g;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((g) => g.close()));
});

/** A minimal schema-valid slice: FILE, MODULE, one SYMBOL it DEFINES. */
async function seed(g: TestGraph): Promise<void> {
  await g.falkor.graph.write(
    `CREATE (:FILE {path:'src/a.ts', name:'a.ts', language:'typescript', content_hash:'seed', status:'ready', version:1})
     CREATE (m:CPG:MODULE {id:'module:src/a.ts', name:'a.ts', file:'src/a.ts', range:'1:0-1:0', status:'ready'})
     CREATE (m)-[:DEFINES]->(:SYMBOL {fqn:'src/a.ts#alpha'})`,
  );
}

describe("schema conformance — clean graph", () => {
  test("a schema-valid graph passes every check", async () => {
    const g = await graph("conformance clean");
    await seed(g);
    const result = await checkSchemaConformance(g.falkor.graph);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("schema conformance — live violations", () => {
  test("an undeclared node label with live nodes is caught", async () => {
    const g = await graph("undeclared label");
    await seed(g);
    await g.falkor.graph.write("CREATE (:BOGUS_LABEL {x:1})");

    const result = await checkSchemaConformance(g.falkor.graph);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(
      /undeclared node label\(s\) with live nodes: BOGUS_LABEL/,
    );
  });

  test("an undeclared edge type with live edges is caught", async () => {
    const g = await graph("undeclared edge");
    await seed(g);
    await g.falkor.graph.write("MATCH (m:MODULE), (s:SYMBOL) CREATE (m)-[:BOGUS_EDGE]->(s)");

    const result = await checkSchemaConformance(g.falkor.graph);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(
      /undeclared edge type\(s\) with live edges: BOGUS_EDGE/,
    );
  });

  test("a SYMBOL wrongly carrying a `file` property is caught (D5)", async () => {
    const g = await graph("symbol file");
    await seed(g);
    await g.falkor.graph.write("MATCH (s:SYMBOL) SET s.file = 'src/a.ts'");

    const result = await checkSchemaConformance(g.falkor.graph);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/SYMBOL:.*wrongly carry a 'file' property/);
  });

  test("a MODULE missing the :CPG co-label is caught", async () => {
    const g = await graph("missing cpg");
    await seed(g);
    await g.falkor.graph.write("MATCH (m:MODULE) REMOVE m:CPG");

    const result = await checkSchemaConformance(g.falkor.graph);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/MODULE:.*missing the :CPG co-label/);
  });

  test("an edge whose endpoint label is outside the declared set is caught", async () => {
    const g = await graph("bad endpoint");
    await seed(g);
    // CALLS.from is [CALL], not MODULE.
    await g.falkor.graph.write(
      "MATCH (m:MODULE), (s:SYMBOL) CREATE (m)-[:CALLS {status:'resolved'}]->(s)",
    );

    const result = await checkSchemaConformance(g.falkor.graph);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(
      /CALLS:.*endpoint label outside the declared from\/to sets/,
    );
  });

  test("repairing the graph makes conformance green again", async () => {
    const g = await graph("repair");
    await seed(g);
    await g.falkor.graph.write("CREATE (:BOGUS_LABEL {x:1})");
    expect((await checkSchemaConformance(g.falkor.graph)).ok).toBe(false);

    await g.falkor.graph.write("MATCH (n:BOGUS_LABEL) DELETE n");
    // The label registry stays sticky even after every node is gone (verified
    // live against this harness) — conformance must still read clean because
    // the check only flags a registry hit with a NON-ZERO live count.
    expect((await checkSchemaConformance(g.falkor.graph)).ok).toBe(true);
  });
});
