import { describe, expect, test } from "bun:test";
/**
 * Exhaustiveness gate for the Joern alignment decision (M0.0, 50-schema.md
 * §1/§10). Every one of the 39 concrete node names and 29 edge names in the
 * vendored `joern-cpg-schema.json` — the canonical published Joern CPG spec
 * — must be accounted for exactly once: either cited as the `joernName` of
 * one of our shipped labels/edges (adopted or renamed), or listed in
 * `tools/schema-doc.ts`'s `REJECTED_JOERN_NODES`/`REJECTED_JOERN_EDGES`.
 * This turns "we align where we overlap and document every divergence"
 * (§1's alignment decision) from prose into an executable claim.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REJECTED_JOERN_EDGES, REJECTED_JOERN_NODES } from "../../../../../tools/schema-doc.ts";
import { CPG_SCHEMA } from "../../../src/schema/index.ts";
import type { JoernAlignment } from "../../../src/schema/index.ts";

interface JoernSchemaEntry {
  name: string;
  isAbstract?: boolean;
}
interface JoernSchema {
  nodes: JoernSchemaEntry[];
  edges: JoernSchemaEntry[];
}

const joernSchema: JoernSchema = JSON.parse(
  readFileSync(join(__dirname, "../../support/joern-cpg-schema.json"), "utf8"),
);

const CONCRETE_JOERN_NODES = new Set(
  joernSchema.nodes.filter((n) => !n.isAbstract).map((n) => n.name),
);
const JOERN_EDGES = new Set(joernSchema.edges.map((e) => e.name));

function citedJoernNames(entries: readonly { joern: JoernAlignment }[]): Set<string> {
  return new Set(entries.map((e) => e.joern.joernName).filter((n): n is string => n !== undefined));
}

describe("vendored Joern schema", () => {
  test("has exactly 39 concrete nodes and 29 edges (the numbers 50-schema.md cites)", () => {
    expect(CONCRETE_JOERN_NODES.size).toBe(39);
    expect(JOERN_EDGES.size).toBe(29);
  });
});

describe("node exhaustiveness", () => {
  const cited = citedJoernNames(CPG_SCHEMA.nodes);
  // IMPORT is cited as our IMPORT node's Joern analogue, but IMPORT is not in
  // the published spec (it lives only in Joern's Hidden.scala) — it never
  // appears in the vendored concrete-node set, so it consumes nothing here.
  const consumed = [...cited].filter((n) => CONCRETE_JOERN_NODES.has(n));
  const rejected = REJECTED_JOERN_NODES.map((r) => r.name);

  test("every REJECTED_JOERN_NODES entry names a real, concrete Joern node", () => {
    for (const name of rejected) {
      expect(CONCRETE_JOERN_NODES.has(name)).toBe(true);
    }
  });

  test("no name is both cited (adopted/renamed) and rejected", () => {
    const overlap = consumed.filter((n) => rejected.includes(n));
    expect(overlap).toEqual([]);
  });

  test("no name is rejected twice", () => {
    expect(new Set(rejected).size).toBe(rejected.length);
  });

  test("every concrete Joern node is accounted for exactly once", () => {
    const accounted = new Set([...consumed, ...rejected]);
    const missing = [...CONCRETE_JOERN_NODES].filter((n) => !accounted.has(n));
    expect(missing).toEqual([]);
    expect(accounted.size).toBe(CONCRETE_JOERN_NODES.size);
  });
});

describe("edge exhaustiveness", () => {
  const cited = citedJoernNames(CPG_SCHEMA.edges);
  // IMPORTS is cited as our IMPORTS edge's Joern analogue but is unpublished
  // (Hidden.scala) — not in the vendored edge set, consumes nothing here.
  const consumed = [...cited].filter((n) => JOERN_EDGES.has(n));
  const rejected = REJECTED_JOERN_EDGES.map((r) => r.name);

  test("every REJECTED_JOERN_EDGES entry names a real Joern edge", () => {
    for (const name of rejected) {
      expect(JOERN_EDGES.has(name)).toBe(true);
    }
  });

  test("no name is both cited (adopted/renamed) and rejected", () => {
    const overlap = consumed.filter((n) => rejected.includes(n));
    expect(overlap).toEqual([]);
  });

  test("no name is rejected twice", () => {
    expect(new Set(rejected).size).toBe(rejected.length);
  });

  test("every Joern edge is accounted for exactly once", () => {
    const accounted = new Set([...consumed, ...rejected]);
    const missing = [...JOERN_EDGES].filter((n) => !accounted.has(n));
    expect(missing).toEqual([]);
    expect(accounted.size).toBe(JOERN_EDGES.size);
  });
});

describe("the two unpublished citations are exactly IMPORT/IMPORTS", () => {
  test("every joernName our schema cites that is absent from the vendored spec is IMPORT or IMPORTS", () => {
    const allCited = new Set([
      ...citedJoernNames(CPG_SCHEMA.nodes),
      ...citedJoernNames(CPG_SCHEMA.edges),
    ]);
    const unpublished = [...allCited].filter(
      (n) => !CONCRETE_JOERN_NODES.has(n) && !JOERN_EDGES.has(n),
    );
    expect(unpublished.toSorted()).toEqual(["IMPORT", "IMPORTS"]);
  });
});
