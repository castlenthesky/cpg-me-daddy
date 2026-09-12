import { afterAll, describe, expect, test } from "bun:test";
/**
 * The Python declarations adapter against a real grammar and a real fixture
 * (`test/fixtures/python/hello_world.py`) — a small function, a class with
 * a typed field and two methods (one a constructor), a module-level
 * constant. Exact node/edge-set assertions, not "contains a METHOD": an
 * over-emitting adapter should fail these, not slip through.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { extractFile } from "../../../src/extract/index.ts";
import { pythonAdapter } from "../../../src/extract/python.ts";
import { WebTreeSitterBackend } from "../../../src/parser/web-tree-sitter-backend.ts";
import { assertGraphDeltaValid, type GraphDelta } from "../../../src/schema/validate.ts";

// `__dirname`, not `import.meta.url`: packages/engine/package.json declares
// `"type": "commonjs"`, so `tsc -p tsconfig.test.json` (the separate no-emit
// pass that typechecks test/tools code) rejects `import.meta` here even
// though `bun test` itself would run it fine.
const FIXTURE_PATH = join(__dirname, "../../fixtures/python/hello_world.py");
const SOURCE = readFileSync(FIXTURE_PATH, "utf-8");
const FILE = "python/hello_world.py";

const backend = new WebTreeSitterBackend();
afterAll(() => backend.dispose());

function extract(source: string = SOURCE): Promise<GraphDelta> {
  return extractFile(backend, pythonAdapter, { path: FILE, text: source });
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

function idsOf(delta: GraphDelta): string[] {
  return delta.nodes.map((n) => n.properties["id"] as string).toSorted();
}

describe("pythonAdapter: hello_world.py declarations", () => {
  test("emits exactly the expected node set", async () => {
    const delta = await extract();
    const ids = delta.nodes.map((n) => n.properties["id"] as string).toSorted();
    expect(ids).toEqual(
      [
        `${FILE}:MODULE:hello_world`,
        `${FILE}:MEMBER:GREETING`,
        `${FILE}:TYPE_DECL:Greeter`,
        `${FILE}:MEMBER:Greeter/prefix`,
        `${FILE}:METHOD:Greeter/__init__`,
        `${FILE}:PARAM:Greeter/__init__/self:0`,
        `${FILE}:PARAM:Greeter/__init__/prefix:1`,
        `${FILE}:METHOD:Greeter/greet`,
        `${FILE}:PARAM:Greeter/greet/self:0`,
        `${FILE}:PARAM:Greeter/greet/name:1`,
        `${FILE}:METHOD:greet_user`,
        `${FILE}:PARAM:greet_user/name:0`,
      ].toSorted(),
    );
  });

  test("MODULE carries the right properties", async () => {
    const delta = await extract();
    const moduleNode = byId(delta, `${FILE}:MODULE:hello_world`);
    expect(moduleNode.properties["name"]).toBe("hello_world");
    expect(moduleNode.properties["file"]).toBe(FILE);
    expect(moduleNode.properties["status"]).toBe("ready");
  });

  test("module-level GREETING is a MEMBER with no type_text", async () => {
    const delta = await extract();
    const member = byId(delta, `${FILE}:MEMBER:GREETING`);
    expect(member.properties["name"]).toBe("GREETING");
    expect(member.properties["type_text"]).toBeUndefined();
  });

  test("Greeter is a TYPE_DECL with its docstring and structural=true", async () => {
    const delta = await extract();
    const greeter = byId(delta, `${FILE}:TYPE_DECL:Greeter`);
    expect(greeter.properties["kind"]).toBe("class");
    expect(greeter.properties["exported"]).toBe(true);
    expect(greeter.properties["structural"]).toBe(true);
    expect(greeter.properties["docstring_head"]).toBe("Greets people.");
  });

  test("Greeter.prefix is a MEMBER with type_text 'str'", async () => {
    const delta = await extract();
    const prefix = byId(delta, `${FILE}:MEMBER:Greeter/prefix`);
    expect(prefix.properties["type_text"]).toBe("str");
  });

  test("__init__ is classified as a constructor, self is not exported by the heuristic", async () => {
    const delta = await extract();
    const init = byId(delta, `${FILE}:METHOD:Greeter/__init__`);
    expect(init.properties["kind"]).toBe("constructor");
    // Dunder names start with "_" — the `exported = !name.startsWith("_")`
    // heuristic (a documented PEP-8 approximation, not a language fact)
    // marks every dunder method unexported. Asserted here so a future
    // change to the heuristic has to look at this test, not discover the
    // behavior by surprise.
    expect(init.properties["exported"]).toBe(false);
    expect(init.properties["params_count"]).toBe(2);
    expect(init.properties["signature"]).toBe("__init__(self, prefix: str)");
  });

  test("greet has a full signature, is exported, params_count matches its params", async () => {
    const delta = await extract();
    const greet = byId(delta, `${FILE}:METHOD:Greeter/greet`);
    expect(greet.properties["kind"]).toBe("method");
    expect(greet.properties["exported"]).toBe(true);
    expect(greet.properties["async"]).toBe(false);
    expect(greet.properties["signature"]).toBe("greet(self, name: str) -> str");
    expect(greet.properties["params_count"]).toBe(2);
  });

  test("greet_user is a top-level function (not 'method') with an annotated param", async () => {
    const delta = await extract();
    const fn = byId(delta, `${FILE}:METHOD:greet_user`);
    expect(fn.properties["kind"]).toBe("function");
    expect(fn.properties["signature"]).toBe("greet_user(name: str) -> str");
    const param = byId(delta, `${FILE}:PARAM:greet_user/name:0`);
    expect(param.properties["ordinal"]).toBe(0);
    expect(param.properties["type_text"]).toBe("str");
  });

  test("assertGraphDeltaValid passes — the schema gate, wired into every extraction", async () => {
    const delta = await extract();
    expect(() => assertGraphDeltaValid(delta)).not.toThrow();
  });

  test("the schema gate has been SEEN to fail on this adapter's own output shape", async () => {
    const delta = await extract();
    // Corrupt a real emitted node the way a real adapter bug would: drop a
    // required property. This is GR6 applied to the extractor itself, not
    // just to validate.ts's own synthetic fixtures.
    const broken: GraphDelta = {
      ...delta,
      nodes: delta.nodes.map((n) =>
        n.properties["id"] === `${FILE}:METHOD:greet_user`
          ? Object.assign({}, n, {
              properties: Object.assign({}, n.properties, { signature: undefined }),
            })
          : n,
      ),
    };
    expect(() => assertGraphDeltaValid(broken)).toThrow(/missing required property 'signature'/);
  });

  test("every edge's fromKey/toKey resolves to a node actually in this delta", async () => {
    const delta = await extract();
    const ids = new Set(delta.nodes.map((n) => n.properties["id"]));
    expect(delta.edges.length).toBeGreaterThan(0);
    for (const edge of delta.edges) {
      expect(ids.has(edge.fromKey)).toBe(true);
      expect(ids.has(edge.toKey)).toBe(true);
    }
  });

  test("every METHOD's params_count matches its actual HAS_PARAM edge count", async () => {
    const delta = await extract();
    for (const node of delta.nodes.filter((n) => n.labels.includes("METHOD"))) {
      const methodId = node.properties["id"];
      const paramEdges = delta.edges.filter(
        (e) => e.type === "HAS_PARAM" && e.fromKey === methodId,
      );
      expect(paramEdges.length).toBe(node.properties["params_count"] as number);
    }
  });

  test("determinism: parsing the same source twice yields a byte-identical delta", async () => {
    const first = await extract();
    const second = await extract();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("M0.3 stability, for real: prepending a comment changes NO declaration id, only ranges", async () => {
    const before = await extract();
    const after = await extract(`# a leading comment\n${SOURCE}`);

    expect(idsOf(after)).toEqual(idsOf(before));

    // And the thing that DID change is exactly what should have: every
    // node's range shifted down by one line, nothing else.
    for (const beforeNode of before.nodes) {
      const afterNode = after.nodes.find(
        (n) => n.properties["id"] === beforeNode.properties["id"],
      )!;
      const { range: _beforeRange, ...beforeRest } = beforeNode.properties;
      const { range: _afterRange, ...afterRest } = afterNode.properties;
      expect(afterRest).toEqual(beforeRest);
    }
  });

  test("inserting a sibling declaration above another changes 0 existing ids", async () => {
    const before = await extract();
    const withSiblingAbove = `def inserted_above():\n    pass\n\n\n${SOURCE}`;
    const after = await extract(withSiblingAbove);

    const beforeIds = new Set(before.nodes.map((n) => n.properties["id"]));
    const afterIds = new Set(after.nodes.map((n) => n.properties["id"]));
    for (const id of beforeIds) {
      expect(afterIds.has(id)).toBe(true);
    }
    // Exactly the new function's own id is added; nothing else.
    const added = [...afterIds].filter((id) => !beforeIds.has(id));
    expect(added).toEqual([`${FILE}:METHOD:inserted_above`]);
  });
});
