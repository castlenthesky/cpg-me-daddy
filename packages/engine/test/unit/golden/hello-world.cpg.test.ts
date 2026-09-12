/**
 * Hello-world sparse CPG goldens (schema v2).
 *
 * Hand-authored contracts under test/fixtures/golden/simple/ — not produced by
 * an extractor yet. Future M0.6–M0.10 adapters must match these.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CPG_SCHEMA } from "../../../src/schema/schema.ts";
import type { EdgeRow, GraphDelta, NodeRow } from "../../../src/schema/validate.ts";
import { assertGraphDeltaValid } from "../../../src/schema/validate.ts";

interface GoldenCpg {
  schemaVersion: number;
  file: string;
  nodes: NodeRow[];
  edges: EdgeRow[];
}

// `__dirname`, not `import.meta.url`: packages/engine/package.json declares
// `"type": "commonjs"`, so `tsc -p tsconfig.test.json` (the separate no-emit
// pass that typechecks test/tools code) rejects `import.meta` here even
// though `bun test` itself would run it fine. Same convention as
// test/unit/extract/{python,typescript}.test.ts.
const FIXTURE_ROOT = join(__dirname, "../../../../../test/fixtures/golden/simple");

function loadGolden(lang: "python" | "typescript"): GoldenCpg {
  const path = join(FIXTURE_ROOT, lang, "hello_world.cpg.json");
  return JSON.parse(readFileSync(path, "utf8")) as GoldenCpg;
}

function toDelta(golden: GoldenCpg): GraphDelta {
  return { file: golden.file, nodes: golden.nodes, edges: golden.edges };
}

function kindLabel(node: NodeRow): string {
  return node.labels.find((l) => l !== "CPG") ?? node.labels.join(",");
}

function assertSparseHelloWorldShape(golden: GoldenCpg, opts: { callee: string }): void {
  expect(golden.schemaVersion).toBe(CPG_SCHEMA.version);

  const counts = new Map<string, number>();
  for (const node of golden.nodes) {
    const kind = kindLabel(node);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  expect(counts.get("MODULE")).toBe(1);
  expect(counts.get("MEMBER")).toBe(1);
  expect(counts.get("CALL")).toBe(1);
  expect(counts.get("SYMBOL")).toBe(2);
  expect(counts.has("LOCAL")).toBe(false);
  expect(counts.has("IDENTIFIER")).toBe(false);
  expect(counts.has("LITERAL")).toBe(false);

  const member = golden.nodes.find((n) => kindLabel(n) === "MEMBER");
  expect(member?.properties["name"]).toBe("DISPLAY_TEXT");

  const call = golden.nodes.find((n) => kindLabel(n) === "CALL");
  expect(call?.properties["callee_name"]).toBe(opts.callee);
  expect(call?.properties["args_count"]).toBe(1);

  const edgeTypes = golden.edges.map((e) => e.type).toSorted();
  expect(edgeTypes).toEqual(
    ["CALLS", "DECLARES", "DEFINES", "IN_SCOPE", "REACHING_DEF"].toSorted(),
  );

  const reaching = golden.edges.find((e) => e.type === "REACHING_DEF");
  expect(reaching).toBeDefined();
  expect(reaching?.fromLabel).toBe("MEMBER");
  expect(reaching?.toLabel).toBe("CALL");
  expect(reaching?.properties["variable"]).toBe("DISPLAY_TEXT");
  expect(reaching?.fromKey).toBe(member?.properties["id"] as string | undefined);
  expect(reaching?.toKey).toBe(call?.properties["id"] as string | undefined);

  const calls = golden.edges.find((e) => e.type === "CALLS");
  expect(calls?.properties["status"]).toBe("external");
}

describe("golden simple hello_world CPG", () => {
  test("python golden validates and has sparse data-flow shape", () => {
    const golden = loadGolden("python");
    assertGraphDeltaValid(toDelta(golden));
    assertSparseHelloWorldShape(golden, { callee: "print" });
  });

  test("typescript golden validates and has sparse data-flow shape", () => {
    const golden = loadGolden("typescript");
    assertGraphDeltaValid(toDelta(golden));
    assertSparseHelloWorldShape(golden, { callee: "log" });

    const call = golden.nodes.find((n) => kindLabel(n) === "CALL");
    expect(call?.properties["receiver_text"]).toBe("console");
  });

  test("source fixtures exist beside the goldens and match the two-line contract", () => {
    const py = readFileSync(join(FIXTURE_ROOT, "python/hello_world.py"), "utf8");
    const ts = readFileSync(join(FIXTURE_ROOT, "typescript/hello_world.ts"), "utf8");
    expect(py).toBe('DISPLAY_TEXT = "Hello World"\nprint(DISPLAY_TEXT)\n');
    expect(ts).toBe('const DISPLAY_TEXT = "Hello World";\nconsole.log(DISPLAY_TEXT);\n');
  });
});
