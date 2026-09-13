/**
 * `queryParamsToString` — the `CYPHER key=value ...` prefix `GraphService.explain`
 * builds when EXPLAIN needs a parameter the planner consumes directly (M0.4b,
 * cpg-me-daddy). Reimplements the `falkordb` driver's own internal serializer
 * (unexported from the package), so its escaping edge cases get a DB-free
 * test of their own rather than only incidental coverage from a live query.
 */
import { describe, expect, test } from "bun:test";

import { queryParamsToString } from "../../src/client.ts";

describe("queryParamsToString", () => {
  test("joins multiple params space-separated", () => {
    expect(queryParamsToString({ a: 1, b: 2 })).toBe("a=1 b=2");
  });

  test("quotes strings", () => {
    expect(queryParamsToString({ file: "src/a.ts" })).toBe('file="src/a.ts"');
  });

  test("escapes embedded quotes and backslashes in strings", () => {
    expect(queryParamsToString({ s: 'a"b\\c' })).toBe('s="a\\"b\\\\c"');
  });

  test("renders numbers and booleans literally, unquoted", () => {
    expect(queryParamsToString({ n: 42, f: 3.5, t: true, f2: false })).toBe(
      "n=42 f=3.5 t=true f2=false",
    );
  });

  test("renders null as the literal null", () => {
    expect(queryParamsToString({ x: null })).toBe("x=null");
  });

  test("renders arrays as [...]", () => {
    expect(queryParamsToString({ ids: ["a", "b", 1] })).toBe('ids=["a","b",1]');
  });

  test("renders plain objects as {key:value,...}", () => {
    expect(queryParamsToString({ row: { id: "x", n: 1 } })).toBe('row={id:"x",n:1}');
  });

  test("round-trips the exact shape a scope-delete op needs", () => {
    // MATCH (n:CPG {file: $file}) DELETE n — the case GRAPH.EXPLAIN cannot
    // plan without a supplied value (verified live: "Missing parameters").
    expect(queryParamsToString({ file: "src/a.ts" })).toBe('file="src/a.ts"');
  });
});
