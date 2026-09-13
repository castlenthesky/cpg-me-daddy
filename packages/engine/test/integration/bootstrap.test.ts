/**
 * M0.4a gate, live half: `bootstrapSchema` against a real FalkorDB — the
 * indexes and the UNIQUE SYMBOL.fqn constraint are really created, the
 * constraint really reaches OPERATIONAL, and a duplicate SYMBOL.fqn is
 * really rejected by the server, not by a test assertion. Requires a running
 * harness instance — `bun run db:up`. The DB-free half (pure logic, the
 * merged-index-row regression, the PENDING-polling and timeout paths against
 * a fake) is `test/unit/store/bootstrap.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { CPG_SCHEMA } from "../../src/schema/index.ts";
import { bootstrapSchema } from "../../src/store/bootstrap.ts";
import { openTestGraph, type TestGraph } from "../support/falkordb.ts";
import { assertGraphInvariants } from "../support/invariants.ts";
import { assertSchemaConformance, checkSchemaConformance } from "../support/schema-conformance.ts";

const open: TestGraph[] = [];

async function graph(label: string): Promise<TestGraph> {
  const g = await openTestGraph(label);
  open.push(g);
  return g;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((g) => g.close()));
});

describe("bootstrapSchema — fresh graph", () => {
  test("creates every declared index and the constraint, reaching OPERATIONAL", async () => {
    const g = await graph("bootstrap fresh");

    const report = await bootstrapSchema({ graph: g.falkor.graph, admin: g.falkor.admin });

    expect(report.indexesCreated.toSorted()).toEqual(
      ["CPG(id)", "CPG(file)", "FILE(path)", "DIRECTORY(path)", "SYMBOL(fqn)"].toSorted(),
    );
    expect(report.indexesExisting).toEqual([]);
    expect(report.constraintsCreated).toEqual(["UNIQUE SYMBOL(fqn)"]);
    expect(report.constraintsExisting).toEqual([]);
    expect(report.schemaVersion).toEqual({
      expected: CPG_SCHEMA.version,
      found: undefined,
      action: "created",
    });

    const indexes = await g.falkor.graph.read<{ label: string; properties: string[] }>(
      "CALL db.indexes()",
    );
    const cpgRow = indexes.data.find((r) => r.label === "CPG");
    expect(cpgRow?.properties.toSorted()).toEqual(["file", "id"]);
    expect(indexes.data.map((r) => r.label).toSorted()).toEqual(
      ["CPG", "DIRECTORY", "FILE", "SYMBOL"].toSorted(),
    );

    const constraints = await g.falkor.graph.read<{
      type: string;
      label: string;
      properties: string[];
      entitytype: string;
      status: string;
    }>("CALL db.constraints()");
    expect(constraints.data).toEqual([
      {
        type: "UNIQUE",
        label: "SYMBOL",
        properties: ["fqn"],
        entitytype: "NODE",
        status: "OPERATIONAL",
      },
    ]);

    await assertSchemaConformance(g.falkor.graph, { requireIndexes: true });
    await assertGraphInvariants(g.falkor.graph);
  });

  test("a duplicate SYMBOL.fqn insert is rejected by the server, not by a test assertion", async () => {
    const g = await graph("bootstrap unique constraint");
    await bootstrapSchema({ graph: g.falkor.graph, admin: g.falkor.admin });

    await g.falkor.graph.write("CREATE (:SYMBOL {fqn: 'src/a.ts#alpha'})");
    await expect(
      g.falkor.graph.write("CREATE (:SYMBOL {fqn: 'src/a.ts#alpha'})"),
    ).rejects.toThrow();

    // Exactly one SYMBOL exists — the server refused the second CREATE outright.
    const count = await g.falkor.graph.scalar(
      "MATCH (s:SYMBOL {fqn: 'src/a.ts#alpha'}) RETURN count(s) AS n",
    );
    expect(count).toBe(1);
  });
});

describe("bootstrapSchema — re-run against an already-bootstrapped graph", () => {
  test("creates nothing the second time", async () => {
    const g = await graph("bootstrap idempotent");
    const deps = { graph: g.falkor.graph, admin: g.falkor.admin };
    const first = await bootstrapSchema(deps);
    expect(first.indexesCreated.length).toBe(5);
    expect(first.constraintsCreated.length).toBe(1);

    const second = await bootstrapSchema(deps);
    expect(second.indexesCreated).toEqual([]);
    expect(second.constraintsCreated).toEqual([]);
    expect(second.indexesExisting.toSorted()).toEqual(first.indexesCreated.toSorted());
    expect(second.constraintsExisting).toEqual(first.constraintsCreated);
    expect(second.schemaVersion.action).toBe("matched");

    await assertSchemaConformance(g.falkor.graph, { requireIndexes: true });
    await assertGraphInvariants(g.falkor.graph);
  });

  test("a tampered schema_version reports a mismatch rather than acting on it", async () => {
    const g = await graph("bootstrap version mismatch");
    const deps = { graph: g.falkor.graph, admin: g.falkor.admin };
    await bootstrapSchema(deps);

    await g.falkor.graph.write("MATCH (m:META_DATA) SET m.schema_version = -1");

    const report = await bootstrapSchema(deps);
    expect(report.schemaVersion).toEqual({
      expected: CPG_SCHEMA.version,
      found: -1,
      action: "mismatch",
    });
    // Bootstrap reports; it does not drop or rewrite on mismatch.
    const stillTampered = await g.falkor.graph.scalar(
      "MATCH (m:META_DATA {schema_version: -1}) RETURN count(m) AS n",
    );
    expect(stillTampered).toBe(1);
  });
});

describe("bootstrapSchema — the conformance gate before and after", () => {
  test("requireIndexes fails before bootstrap and passes after", async () => {
    const g = await graph("bootstrap gate flip");

    const before = await checkSchemaConformance(g.falkor.graph, { requireIndexes: true });
    expect(before.ok).toBe(false);
    expect(before.problems.some((p) => p.includes("missing declared index"))).toBe(true);
    expect(before.problems.some((p) => p.includes("missing declared constraint"))).toBe(true);

    await bootstrapSchema({ graph: g.falkor.graph, admin: g.falkor.admin });

    await assertSchemaConformance(g.falkor.graph, { requireIndexes: true });
  });
});
