/**
 * The DB-free schema validator (M0.0). Every check has a positive control (a
 * valid delta passes clean) and a negative control (one deliberately broken
 * field fails, with a specific message) — a check nobody has seen fail is
 * not a gate (F1's rule, applied here to the schema gate itself).
 */
import { describe, expect, test } from "bun:test";

import type { EdgeRow, GraphDelta, NodeRow } from "../../../src/schema/validate.ts";
import { assertGraphDeltaValid, validateGraphDelta } from "../../../src/schema/validate.ts";

const FILE = "src/a.ts";

function validNodes(): NodeRow[] {
  return [
    {
      labels: ["CPG", "MODULE"],
      properties: {
        id: "file:src/a.ts:MODULE:$root",
        name: "a",
        file: FILE,
        range: "1:0-10:0",
        status: "ready",
      },
    },
    {
      labels: ["CPG", "METHOD"],
      properties: {
        id: "file:src/a.ts:METHOD:foo",
        name: "foo",
        kind: "function",
        signature: "foo(): void",
        params_count: 0,
        file: FILE,
        range: "2:0-4:0",
        exported: true,
        async: false,
        status: "ready",
      },
    },
    {
      labels: ["CPG", "CALL"],
      properties: {
        id: "file:src/a.ts:CALL:foo:0",
        callee_name: "bar",
        args_count: 0,
        file: FILE,
        range: "3:0-3:5",
        kind: "call",
        status: "ready",
      },
    },
    {
      labels: ["SYMBOL"],
      properties: { fqn: "src/a.ts`bar()." },
    },
  ];
}

function validEdges(): EdgeRow[] {
  return [
    { type: "DECLARES", fromLabel: "MODULE", toLabel: "METHOD", properties: {} },
    { type: "IN_SCOPE", fromLabel: "CALL", toLabel: "METHOD", properties: {} },
    { type: "DEFINES", fromLabel: "METHOD", toLabel: "SYMBOL", properties: {} },
    { type: "CALLS", fromLabel: "CALL", toLabel: "SYMBOL", properties: { status: "resolved" } },
  ];
}

function validDelta(): GraphDelta {
  return { file: FILE, nodes: validNodes(), edges: validEdges() };
}

describe("a well-formed delta", () => {
  test("passes every check clean", () => {
    const result = validateGraphDelta(validDelta());
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("assertGraphDeltaValid does not throw", () => {
    expect(() => assertGraphDeltaValid(validDelta())).not.toThrow();
  });
});

describe("undeclared vocabulary", () => {
  test("undeclared node label fails", () => {
    const delta = validDelta();
    delta.nodes.push({ labels: ["CPG", "BOGUS"], properties: {} });
    const result = validateGraphDelta(delta);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("undeclared node label"))).toBe(true);
  });

  test("undeclared edge type fails", () => {
    const delta = validDelta();
    delta.edges.push({ type: "BOGUS_EDGE", fromLabel: "CALL", toLabel: "SYMBOL", properties: {} });
    const result = validateGraphDelta(delta);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("undeclared edge type"))).toBe(true);
  });

  test("undeclared property fails (drift in either direction)", () => {
    const delta = validDelta();
    delta.nodes[0]!.properties = { ...delta.nodes[0]!.properties, totallyMadeUp: "x" };
    const result = validateGraphDelta(delta);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("undeclared property 'totallyMadeUp'"))).toBe(
      true,
    );
  });
});

describe("required properties, types and enums", () => {
  test("missing required property fails", () => {
    const delta = validDelta();
    const { name: _name, ...rest } = delta.nodes[0]!.properties;
    delta.nodes[0]!.properties = rest;
    const result = validateGraphDelta(delta);
    expect(result.problems.some((p) => p.includes("missing required property 'name'"))).toBe(true);
  });

  test("wrong scalar type fails", () => {
    const delta = validDelta();
    delta.nodes[1]!.properties = { ...delta.nodes[1]!.properties, exported: "yes" };
    const result = validateGraphDelta(delta);
    expect(result.problems.some((p) => p.includes("should be bool"))).toBe(true);
  });

  test("enum violation fails", () => {
    const delta = validDelta();
    delta.nodes[0]!.properties = { ...delta.nodes[0]!.properties, status: "bogus" };
    const result = validateGraphDelta(delta);
    expect(result.problems.some((p) => p.includes("is not one of"))).toBe(true);
  });

  test("CALLS.status and IMPORTS.status accept the shared resolution enum", () => {
    const delta = validDelta();
    delta.edges[3]!.properties = { status: "dynamic" };
    expect(validateGraphDelta(delta).ok).toBe(true);
  });
});

describe(":CPG co-label rule (both directions)", () => {
  test("a file-owned node missing :CPG fails", () => {
    const delta = validDelta();
    delta.nodes[0]!.labels = ["MODULE"];
    const result = validateGraphDelta(delta);
    expect(result.problems.some((p) => p.includes("must carry the :CPG label"))).toBe(true);
  });

  test("SYMBOL carrying :CPG fails", () => {
    const delta = validDelta();
    delta.nodes[3]!.labels = ["CPG", "SYMBOL"];
    const result = validateGraphDelta(delta);
    expect(result.problems.some((p) => p.includes("must NOT carry the :CPG label"))).toBe(true);
  });
});

describe("`file` property rule (both directions) — D5 / per-file replace safety", () => {
  test("SYMBOL carrying a `file` property fails", () => {
    const delta = validDelta();
    delta.nodes[3]!.properties = { ...delta.nodes[3]!.properties, file: FILE };
    const result = validateGraphDelta(delta);
    expect(result.problems.some((p) => p.includes("must NOT carry a 'file' property"))).toBe(true);
  });

  test("a file-owned node missing `file` fails", () => {
    const delta = validDelta();
    const { file: _file, ...rest } = delta.nodes[0]!.properties;
    delta.nodes[0]!.properties = rest;
    const result = validateGraphDelta(delta);
    expect(result.problems.some((p) => p.includes("must carry a 'file' property"))).toBe(true);
  });
});

describe("identity key", () => {
  test("missing key property fails", () => {
    const delta = validDelta();
    const { id: _id, ...rest } = delta.nodes[0]!.properties;
    delta.nodes[0]!.properties = rest;
    const result = validateGraphDelta(delta);
    expect(result.problems.some((p) => p.includes("missing key property 'id'"))).toBe(true);
  });
});

describe("edge endpoint labels", () => {
  test("a source label outside the declared 'from' set fails", () => {
    const delta = validDelta();
    delta.edges[2] = { ...delta.edges[2]!, fromLabel: "CALL" }; // DEFINES.from does not include CALL
    const result = validateGraphDelta(delta);
    expect(result.problems.some((p) => p.includes("is not in the declared 'from' set"))).toBe(true);
  });

  test("a target label outside the declared 'to' set fails", () => {
    const delta = validDelta();
    delta.edges[3] = { ...delta.edges[3]!, toLabel: "METHOD" }; // CALLS.to is SYMBOL only
    const result = validateGraphDelta(delta);
    expect(result.problems.some((p) => p.includes("is not in the declared 'to' set"))).toBe(true);
  });
});

describe("the overlay-in-replace rule", () => {
  test("an overlay node inside a per-file replace fails", () => {
    const delta = validDelta();
    delta.nodes.push({
      labels: ["COMMUNITY"],
      properties: { algorithm: "louvain", run_id: "r1", size: 3, computed_at: "now" },
    });
    const result = validateGraphDelta(delta);
    expect(
      result.problems.some((p) =>
        p.includes("overlay-owned node written inside a per-file replace"),
      ),
    ).toBe(true);
  });

  test("an overlay edge inside a per-file replace fails", () => {
    const delta = validDelta();
    delta.edges.push({
      type: "TARGETS",
      fromLabel: "CALL",
      toLabel: "METHOD",
      properties: { computed_at: "now", run_id: "r1" },
    });
    const result = validateGraphDelta(delta);
    expect(
      result.problems.some((p) =>
        p.includes("overlay-owned edge written inside a per-file replace"),
      ),
    ).toBe(true);
  });

  test("the same overlay node/edge are fine outside a per-file replace", () => {
    const withoutFile: GraphDelta = {
      nodes: [
        {
          labels: ["COMMUNITY"],
          properties: {
            id: "community:1",
            algorithm: "louvain",
            run_id: "r1",
            size: 3,
            computed_at: "now",
          },
        },
      ],
      edges: [],
    };
    expect(validateGraphDelta(withoutFile).ok).toBe(true);
  });
});

describe("cross-file rule", () => {
  test("a node whose `file` disagrees with the replace's own file fails", () => {
    const delta = validDelta();
    delta.nodes[0]!.properties = { ...delta.nodes[0]!.properties, file: "src/other.ts" };
    const result = validateGraphDelta(delta);
    expect(result.problems.some((p) => p.includes("does not match the replace's own file"))).toBe(
      true,
    );
  });
});

describe("referential integrity (fromKey/toKey) — added for the AST-to-CPG conversion unit", () => {
  test("edges with no fromKey/toKey are still valid — existing callers are unaffected", () => {
    // validEdges() carries no fromKey/toKey at all; the check only fires
    // when a caller actually supplies one.
    expect(validateGraphDelta(validDelta()).ok).toBe(true);
  });

  test("fromKey/toKey resolving to real nodes in the same delta pass clean", () => {
    const delta = validDelta();
    delta.edges[0] = {
      ...delta.edges[0]!,
      fromKey: "file:src/a.ts:MODULE:$root",
      toKey: "file:src/a.ts:METHOD:foo",
    };
    expect(validateGraphDelta(delta).ok).toBe(true);
  });

  test("a dangling fromKey fails, naming the missing endpoint", () => {
    const delta = validDelta();
    delta.edges[0] = { ...delta.edges[0]!, fromKey: "file:src/a.ts:MODULE:does-not-exist" };
    const result = validateGraphDelta(delta);
    expect(result.ok).toBe(false);
    expect(
      result.problems.some((p) => p.includes("'fromKey'") && p.includes("does-not-exist")),
    ).toBe(true);
  });

  test("a dangling toKey fails, naming the missing endpoint", () => {
    const delta = validDelta();
    delta.edges[0] = { ...delta.edges[0]!, toKey: "file:src/a.ts:METHOD:does-not-exist" };
    const result = validateGraphDelta(delta);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("'toKey'") && p.includes("does-not-exist"))).toBe(
      true,
    );
  });

  test("a key resolving to the right value but wrong label still fails", () => {
    const delta = validDelta();
    // "foo" is a real METHOD id, not a SYMBOL fqn — CALLS.to is SYMBOL only.
    delta.edges[3] = { ...delta.edges[3]!, toKey: "file:src/a.ts:METHOD:foo" };
    const result = validateGraphDelta(delta);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("'toKey'"))).toBe(true);
  });
});

describe("aggregation", () => {
  test("every problem is reported together, not just the first", () => {
    const delta = validDelta();
    delta.nodes.push({ labels: ["CPG", "BOGUS"], properties: {} });
    delta.edges.push({ type: "BOGUS_EDGE", fromLabel: "CALL", toLabel: "SYMBOL", properties: {} });
    delta.nodes[0]!.properties = { ...delta.nodes[0]!.properties, status: "bogus" };
    const result = validateGraphDelta(delta);
    expect(result.problems.length).toBeGreaterThanOrEqual(3);
  });

  test("REACHING_DEF (MEMBER -> CALL) with variable is accepted", () => {
    const delta = validDelta();
    delta.nodes.push({
      labels: ["CPG", "MEMBER"],
      properties: {
        id: "file:src/a.ts:MEMBER:x",
        name: "x",
        file: FILE,
        range: "1:0-1:10",
      },
    });
    delta.edges.push({
      type: "REACHING_DEF",
      fromLabel: "MEMBER",
      toLabel: "CALL",
      properties: { variable: "x" },
    });
    expect(validateGraphDelta(delta).ok).toBe(true);
  });

  test("REACHING_DEF missing variable fails", () => {
    const delta = validDelta();
    delta.edges.push({
      type: "REACHING_DEF",
      fromLabel: "MEMBER",
      toLabel: "CALL",
      properties: {},
    });
    const result = validateGraphDelta(delta);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("missing required property 'variable'"))).toBe(
      true,
    );
  });

  test("assertGraphDeltaValid throws listing every problem", () => {
    const delta = validDelta();
    delta.nodes.push({ labels: ["CPG", "BOGUS"], properties: {} });
    delta.edges.push({ type: "BOGUS_EDGE", fromLabel: "CALL", toLabel: "SYMBOL", properties: {} });
    expect(() => assertGraphDeltaValid(delta)).toThrow(/BOGUS[\s\S]*BOGUS_EDGE/);
  });
});
