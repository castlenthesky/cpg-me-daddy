import { afterAll, describe, expect, test } from "bun:test";
/**
 * The TypeScript declarations adapter against a real grammar and a real
 * fixture (`test/fixtures/typescript/hello_world.ts`) — deliberately
 * parallel to `python.test.ts`'s fixture, so the two deltas can be compared
 * side by side and any accidental language-specific leakage into the
 * shared spine (`walk.ts`) would show up as an unexplained asymmetry.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { extractFile } from "../../../src/extract/index.ts";
import { typeScriptAdapter } from "../../../src/extract/typescript.ts";
import { WebTreeSitterBackend } from "../../../src/parser/web-tree-sitter-backend.ts";
import { assertGraphDeltaValid, type GraphDelta } from "../../../src/schema/validate.ts";

// See python.test.ts's identical comment: `__dirname`, not `import.meta.url`
// — packages/engine/package.json is `"type": "commonjs"`.
const FIXTURE_PATH = join(__dirname, "../../fixtures/typescript/hello_world.ts");
const SOURCE = readFileSync(FIXTURE_PATH, "utf-8");
const FILE = "typescript/hello_world.ts";

const backend = new WebTreeSitterBackend();
afterAll(() => backend.dispose());

function extract(source: string = SOURCE): Promise<GraphDelta> {
  return extractFile(backend, typeScriptAdapter, { path: FILE, text: source });
}

function byId(delta: GraphDelta, id: string) {
  const node = delta.nodes.find((n) => n.properties["id"] === id);
  if (!node) {
    throw new Error(
      `no node with id ${id} in delta (have: ${delta.nodes.map((n) => n.properties["id"]).join(", ")})`,
    );
  }
  return node;
}

/** A node's own identity key — `id` for a `:CPG` node, `fqn` for a SYMBOL (M0.7). */
function keyOf(node: GraphDelta["nodes"][number]): string {
  const key = node.properties["id"] ?? node.properties["fqn"];
  if (typeof key !== "string") {
    throw new Error(`node has neither 'id' nor 'fqn': ${JSON.stringify(node)}`);
  }
  return key;
}

function idsOf(delta: GraphDelta): string[] {
  return delta.nodes
    .filter((n) => n.labels.includes("CPG"))
    .map((n) => n.properties["id"] as string)
    .toSorted();
}

function symbolFqnsOf(delta: GraphDelta): string[] {
  return delta.nodes
    .filter((n) => n.labels.length === 1 && n.labels[0] === "SYMBOL")
    .map((n) => n.properties["fqn"] as string)
    .toSorted();
}

describe("typeScriptAdapter: hello_world.ts declarations", () => {
  test("emits exactly the expected declaration node set", async () => {
    const delta = await extract();
    expect(idsOf(delta)).toEqual(
      [
        `${FILE}:MODULE:hello_world`,
        `${FILE}:MEMBER:GREETING`,
        `${FILE}:TYPE_DECL:Greeter`,
        `${FILE}:MEMBER:Greeter/prefix`,
        `${FILE}:METHOD:Greeter/constructor`,
        `${FILE}:PARAM:Greeter/constructor/prefix:0`,
        `${FILE}:METHOD:Greeter/greet`,
        `${FILE}:PARAM:Greeter/greet/name:0`,
        `${FILE}:CALL:Greeter/greet/log:0`,
        `${FILE}:METHOD:greetUser`,
        `${FILE}:PARAM:greetUser/name:0`,
      ].toSorted(),
    );
  });

  test("MEMBER/METHOD/TYPE_DECL each mint their own SYMBOL (M0.7)", async () => {
    const delta = await extract();
    expect(symbolFqnsOf(delta)).toEqual(
      [
        `\`${FILE}\`/GREETING.`,
        `\`${FILE}\`/Greeter#`,
        `\`${FILE}\`/Greeter#prefix.`,
        `\`${FILE}\`/Greeter#constructor().`,
        `\`${FILE}\`/Greeter#greet().`,
        `\`${FILE}\`/greetUser().`,
        "site:node`console.log().",
      ].toSorted(),
    );
  });

  test("greet's console.log(name) call mints a CALL, an external SYMBOL, and REACHING_DEF from PARAM name", async () => {
    const delta = await extract();
    const call = byId(delta, `${FILE}:CALL:Greeter/greet/log:0`);
    expect(call.properties["callee_name"]).toBe("log");
    expect(call.properties["receiver_text"]).toBe("console");
    expect(call.properties["args_count"]).toBe(1);
    expect(call.properties["kind"]).toBe("call");

    const inScope = delta.edges.find(
      (e) => e.type === "IN_SCOPE" && e.fromKey === call.properties["id"],
    );
    expect(inScope?.toKey).toBe(`${FILE}:METHOD:Greeter/greet`);

    const calls = delta.edges.find(
      (e) => e.type === "CALLS" && e.fromKey === call.properties["id"],
    );
    expect(calls?.toKey).toBe("site:node`console.log().");
    expect(calls?.properties["status"]).toBe("external");

    const reachingDef = delta.edges.find(
      (e) => e.type === "REACHING_DEF" && e.toKey === call.properties["id"],
    );
    expect(reachingDef?.fromLabel).toBe("PARAM");
    expect(reachingDef?.fromKey).toBe(`${FILE}:PARAM:Greeter/greet/name:0`);
    expect(reachingDef?.properties["variable"]).toBe("name");
  });

  test("export_statement is unwrapped: the top-level const, class and function are all exported=true", async () => {
    const delta = await extract();
    expect(byId(delta, `${FILE}:TYPE_DECL:Greeter`).properties["exported"]).toBe(true);
    expect(byId(delta, `${FILE}:METHOD:greetUser`).properties["exported"]).toBe(true);
  });

  test("class members are never independently 'exported' — the class itself carries that", async () => {
    const delta = await extract();
    expect(byId(delta, `${FILE}:METHOD:Greeter/constructor`).properties["exported"]).toBe(false);
    expect(byId(delta, `${FILE}:METHOD:Greeter/greet`).properties["exported"]).toBe(false);
  });

  test("constructor is classified as 'constructor', not 'method'", async () => {
    const delta = await extract();
    const ctor = byId(delta, `${FILE}:METHOD:Greeter/constructor`);
    expect(ctor.properties["kind"]).toBe("constructor");
    expect(ctor.properties["signature"]).toBe("constructor(prefix: string)");
    expect(ctor.properties["params_count"]).toBe(1);
  });

  test("greet has a colon-style return type annotation, stripped of its leading ':'", async () => {
    const delta = await extract();
    const greet = byId(delta, `${FILE}:METHOD:Greeter/greet`);
    expect(greet.properties["kind"]).toBe("method");
    expect(greet.properties["signature"]).toBe("greet(name: string): string");
  });

  test("Greeter.prefix MEMBER has type_text 'string' (annotation stripped of ': ')", async () => {
    const delta = await extract();
    const prefix = byId(delta, `${FILE}:MEMBER:Greeter/prefix`);
    expect(prefix.properties["type_text"]).toBe("string");
  });

  test("top-level function greetUser is kind 'function'", async () => {
    const delta = await extract();
    const fn = byId(delta, `${FILE}:METHOD:greetUser`);
    expect(fn.properties["kind"]).toBe("function");
    expect(fn.properties["signature"]).toBe("greetUser(name: string): string");
  });

  test("assertGraphDeltaValid passes", async () => {
    const delta = await extract();
    expect(() => assertGraphDeltaValid(delta)).not.toThrow();
  });

  test("every edge's fromKey/toKey resolves to a node actually in this delta", async () => {
    const delta = await extract();
    const keys = new Set(delta.nodes.map(keyOf));
    expect(delta.edges.length).toBeGreaterThan(0);
    for (const edge of delta.edges) {
      expect(keys.has(edge.fromKey!)).toBe(true);
      expect(keys.has(edge.toKey!)).toBe(true);
    }
  });

  test("every METHOD's params_count matches its actual HAS_PARAM edge count", async () => {
    const delta = await extract();
    for (const node of delta.nodes.filter((n) => n.labels.includes("METHOD"))) {
      const paramEdges = delta.edges.filter(
        (e) => e.type === "HAS_PARAM" && e.fromKey === node.properties["id"],
      );
      expect(paramEdges.length).toBe(node.properties["params_count"] as number);
    }
  });

  test("determinism: parsing the same source twice yields a byte-identical delta", async () => {
    const first = await extract();
    const second = await extract();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("stability: prepending a comment line changes no declaration id, only ranges", async () => {
    const before = await extract();
    const after = await extract(`// a leading comment\n${SOURCE}`);

    expect(idsOf(after)).toEqual(idsOf(before));
    expect(symbolFqnsOf(after)).toEqual(symbolFqnsOf(before));

    for (const beforeNode of before.nodes) {
      const afterNode = after.nodes.find((n) => keyOf(n) === keyOf(beforeNode))!;
      const { range: _beforeRange, ...beforeRest } = beforeNode.properties;
      const { range: _afterRange, ...afterRest } = afterNode.properties;
      expect(afterRest).toEqual(beforeRest);
    }
  });

  test("a multi-declarator const statement is skipped, not partially emitted", async () => {
    const delta = await extract(`export const a = 1, b = 2;\n${SOURCE}`);
    const ids = delta.nodes.map((n) => n.properties["id"]);
    expect(ids).not.toContain(`${FILE}:MEMBER:a`);
    expect(ids).not.toContain(`${FILE}:MEMBER:b`);
  });
});
