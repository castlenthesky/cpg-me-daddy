/**
 * The shared walking spine, tested against hand-built fake nodes — no wasm,
 * no real grammar. This is what the structural `SyntaxNode` seam buys:
 * `walk.ts`'s own logic (scope nesting, id assignment, DECLARES/HAS_PARAM
 * edges, referential integrity) is verified independent of any language's
 * quirks. Real-grammar coverage lives in `python.test.ts`/`typescript.test.ts`.
 */
import { describe, expect, test } from "bun:test";

import type {
  ContainerKind,
  DeclarationInfo,
  LanguageAdapter,
} from "../../../src/extract/adapter.ts";
import type { SyntaxNode, SyntaxPoint } from "../../../src/extract/syntax.ts";
import { extractDeclarations } from "../../../src/extract/walk.ts";
import { assertGraphDeltaValid } from "../../../src/schema/validate.ts";

class FakeNode implements SyntaxNode {
  readonly namedChildren: SyntaxNode[] = [];
  readonly startPosition: SyntaxPoint;
  readonly endPosition: SyntaxPoint;
  readonly startIndex = 0;
  readonly endIndex: number;
  private readonly fields = new Map<string, SyntaxNode>();

  constructor(
    readonly type: string,
    readonly text: string,
  ) {
    this.startPosition = { row: 0, column: 0 };
    this.endPosition = { row: 0, column: text.length };
    this.endIndex = text.length;
  }

  childForFieldName(name: string): SyntaxNode | null {
    return this.fields.get(name) ?? null;
  }

  setField(name: string, node: SyntaxNode): this {
    this.fields.set(name, node);
    return this;
  }

  addChild(node: SyntaxNode): this {
    this.namedChildren.push(node);
    return this;
  }
}

/** A minimal adapter over a made-up grammar: fake_module/fake_class/fake_method/fake_member/fake_param. */
const fakeAdapter: LanguageAdapter = {
  grammarId: "python", // arbitrary — unused beyond satisfying the type
  moduleRootType: "fake_module",
  moduleName(path: string): string {
    return path
      .split("/")
      .pop()!
      .replace(/\.fake$/, "");
  },
  classify(node: SyntaxNode, container: ContainerKind): DeclarationInfo | undefined {
    switch (node.type) {
      case "fake_class":
        return {
          declares: "TYPE_DECL",
          name: node.text,
          kind: "class",
          exported: true,
          structural: true,
          body: node.childForFieldName("body") ?? undefined,
        };
      case "fake_method":
        return {
          declares: "METHOD",
          name: node.text,
          kind: container === "TYPE_DECL" ? "method" : "function",
          signature: `${node.text}()`,
          exported: true,
          async: false,
          params: node.namedChildren.map((p) => ({ name: p.text, node: p })),
        };
      case "fake_member":
        return { declares: "MEMBER", name: node.text };
      default:
        return undefined;
    }
  },
};

describe("extractDeclarations: generic walking behavior", () => {
  test("a module with no children yields exactly the MODULE node, no edges", () => {
    const root = new FakeNode("fake_module", "");
    const delta = extractDeclarations({ path: "a.fake", root, adapter: fakeAdapter });

    expect(delta.nodes).toHaveLength(1);
    expect(delta.edges).toHaveLength(0);
    expect(delta.nodes[0]!.properties["id"]).toBe("a.fake:MODULE:a");
    assertGraphDeltaValid(delta);
  });

  test("an unrecognized node type is skipped, not an error", () => {
    const root = new FakeNode("fake_module", "");
    root.addChild(new FakeNode("something_else_entirely", "junk"));
    const delta = extractDeclarations({ path: "a.fake", root, adapter: fakeAdapter });
    expect(delta.nodes).toHaveLength(1); // MODULE only
  });

  test("nested TYPE_DECL -> METHOD -> PARAM: correct ids, scope, and referential integrity", () => {
    const root = new FakeNode("fake_module", "");
    const param0 = new FakeNode("fake_param", "p0");
    const param1 = new FakeNode("fake_param", "p1");
    const method = new FakeNode("fake_method", "b");
    method.addChild(param0).addChild(param1);
    const classBody = new FakeNode("fake_body", "");
    classBody.addChild(method);
    const klass = new FakeNode("fake_class", "A").setField("body", classBody);
    root.addChild(klass);

    const delta = extractDeclarations({ path: "a.fake", root, adapter: fakeAdapter });
    assertGraphDeltaValid(delta);

    const ids = delta.nodes.map((n) => n.properties["id"]);
    expect(ids.toSorted()).toEqual(
      [
        "a.fake:MODULE:a",
        "a.fake:TYPE_DECL:A",
        "a.fake:METHOD:A/b",
        "a.fake:PARAM:A/b/p0:0",
        "a.fake:PARAM:A/b/p1:1",
      ].toSorted(),
    );

    const methodNode = delta.nodes.find((n) => n.labels.includes("METHOD"))!;
    expect(methodNode.properties["kind"]).toBe("method"); // inside a TYPE_DECL body
    expect(methodNode.properties["params_count"]).toBe(2);

    // Every edge's fromKey/toKey resolves to a real node emitted in this same delta.
    const nodeIds = new Set(ids);
    for (const edge of delta.edges) {
      expect(nodeIds.has(edge.fromKey)).toBe(true);
      expect(nodeIds.has(edge.toKey)).toBe(true);
    }

    // params_count agrees with the actual number of HAS_PARAM edges — a real
    // cross-check, not just trusting the adapter's own count.
    const hasParamCount = delta.edges.filter((e) => e.type === "HAS_PARAM").length;
    expect(hasParamCount).toBe(methodNode.properties["params_count"] as number);
  });

  test("a top-level function has kind 'function', not 'method'", () => {
    const root = new FakeNode("fake_module", "");
    root.addChild(new FakeNode("fake_method", "top_level"));
    const delta = extractDeclarations({ path: "a.fake", root, adapter: fakeAdapter });
    const method = delta.nodes.find((n) => n.labels.includes("METHOD"))!;
    expect(method.properties["kind"]).toBe("function");
  });

  test("a MEMBER at module level and one nested in a TYPE_DECL get distinct ids", () => {
    const root = new FakeNode("fake_module", "");
    root.addChild(new FakeNode("fake_member", "TOP"));
    const classBody = new FakeNode("fake_body", "");
    classBody.addChild(new FakeNode("fake_member", "field"));
    root.addChild(new FakeNode("fake_class", "A").setField("body", classBody));

    const delta = extractDeclarations({ path: "a.fake", root, adapter: fakeAdapter });
    const memberIds = delta.nodes
      .filter((n) => n.labels.includes("MEMBER"))
      .map((n) => n.properties["id"]);
    expect(memberIds.toSorted()).toEqual(["a.fake:MEMBER:TOP", "a.fake:MEMBER:A/field"].toSorted());
  });

  test("root type mismatch throws rather than silently misparsing", () => {
    const root = new FakeNode("not_the_expected_root", "");
    expect(() => extractDeclarations({ path: "a.fake", root, adapter: fakeAdapter })).toThrow(
      /root node type/,
    );
  });

  test("determinism: the same tree shape yields a byte-identical delta", () => {
    function buildRoot(): SyntaxNode {
      const root = new FakeNode("fake_module", "");
      root.addChild(new FakeNode("fake_member", "X"));
      root.addChild(new FakeNode("fake_method", "f"));
      return root;
    }
    const first = extractDeclarations({ path: "a.fake", root: buildRoot(), adapter: fakeAdapter });
    const second = extractDeclarations({ path: "a.fake", root: buildRoot(), adapter: fakeAdapter });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
