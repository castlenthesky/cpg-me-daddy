/**
 * F2 gate: two tests running at the same time must not see each other's data.
 *
 * Graph-key isolation is the whole reason the harness hands out a unique key
 * per test rather than sharing one. This proves it under genuine concurrency —
 * the two sides interleave through Promise.all on separate connections, not one
 * after the other — because a sequential check would also pass if the keys were
 * shared and merely cleaned up in between.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { openTestGraph, type TestGraph } from "../support/falkordb.ts";
import { assertGraphInvariants } from "../support/invariants.ts";

const open: TestGraph[] = [];

async function graph(label: string): Promise<TestGraph> {
  const g = await openTestGraph(label);
  open.push(g);
  return g;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((g) => g.close()));
});

describe("graph isolation", () => {
  test("two concurrent tests do not see each other's data", async () => {
    const [a, b] = await Promise.all([graph("concurrent a"), graph("concurrent b")]);

    expect(a.key).not.toBe(b.key);

    // Interleaved writes on two live connections.
    await Promise.all([
      a.falkor.graph.write(
        "CREATE (f:FILE {path:'a.ts', status:'ready'}) WITH f CREATE (f)-[:DEFINES]->(:SYMBOL {fqn:'a.ts#only_a'})",
      ),
      b.falkor.graph.write(
        "CREATE (f:FILE {path:'b.ts', status:'ready'}) WITH f CREATE (f)-[:DEFINES]->(:SYMBOL {fqn:'b.ts#only_b'})",
      ),
      a.falkor.graph.write("CREATE (:CALL {file:'a.ts'})-[:CALLS]->(:SYMBOL {fqn:'a.ts#second'})"),
      b.falkor.graph.write("CREATE (:CALL {file:'b.ts'})-[:CALLS]->(:SYMBOL {fqn:'b.ts#second'})"),
    ]);

    const [fqnsA, fqnsB] = await Promise.all([
      a.falkor.graph.read<{ fqn: string }>("MATCH (s:SYMBOL) RETURN s.fqn AS fqn ORDER BY s.fqn"),
      b.falkor.graph.read<{ fqn: string }>("MATCH (s:SYMBOL) RETURN s.fqn AS fqn ORDER BY s.fqn"),
    ]);

    expect(fqnsA.data.map((r) => r.fqn)).toEqual(["a.ts#only_a", "a.ts#second"]);
    expect(fqnsB.data.map((r) => r.fqn)).toEqual(["b.ts#only_b", "b.ts#second"]);

    // Neither side sees the other's FILE either.
    expect(await a.falkor.graph.scalar("MATCH (f:FILE {path:'b.ts'}) RETURN count(f) AS n")).toBe(
      0,
    );
    expect(await b.falkor.graph.scalar("MATCH (f:FILE {path:'a.ts'}) RETURN count(f) AS n")).toBe(
      0,
    );

    // And each side's invariants are evaluated only against its own graph.
    await assertGraphInvariants(a.falkor.graph);
    await assertGraphInvariants(b.falkor.graph);
  });

  test("one test's violation does not fail its neighbour", async () => {
    const [a, b] = await Promise.all([graph("violator"), graph("bystander")]);

    await Promise.all([
      a.falkor.graph.write("CREATE (:SYMBOL {fqn:'orphan'})"),
      b.falkor.graph.write(
        "CREATE (f:FILE {path:'b.ts', status:'ready'}) WITH f CREATE (f)-[:DEFINES]->(:SYMBOL {fqn:'b.ts#ok'})",
      ),
    ]);

    await expect(assertGraphInvariants(a.falkor.graph)).rejects.toThrow(/orphan SYMBOL/);
    await assertGraphInvariants(b.falkor.graph);
  });

  test("a dropped graph leaves nothing behind for the next test", async () => {
    const first = await openTestGraph("reuse");
    await first.falkor.graph.write("CREATE (:SYMBOL {fqn:'ghost'})");
    await first.close();

    const second = await graph("reuse");
    expect(second.key).not.toBe(first.key);
    expect(await second.falkor.graph.scalar("MATCH (n) RETURN count(n) AS n")).toBe(0);
  });
});
