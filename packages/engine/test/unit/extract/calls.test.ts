/**
 * Pass B (M0.7/M0.9's call/SYMBOL/data-flow spine in `walk.ts`), tested
 * against hand-built fake nodes — no wasm, no real grammar, the same
 * strategy `walk.test.ts` uses for Pass A. Real-grammar coverage of the
 * exact same rules lives in `python.test.ts`/`typescript.test.ts` and the
 * golden-matching `test/unit/golden/extractor-matches-golden.test.ts`.
 */
import { describe, expect, test } from "bun:test";

import type {
  CalleeAttribution,
  ContainerKind,
  DeclarationInfo,
  ExpressionVerdict,
  LanguageAdapter,
} from "../../../src/extract/adapter.ts";
import type { SyntaxNode, SyntaxPoint } from "../../../src/extract/syntax.ts";
import { extractDeclarations } from "../../../src/extract/walk.ts";
import { idSetDiff } from "../../support/id-diff.ts";

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

/** `fake_identifier "x"` — a bare-name argument REACHING_DEF can match. */
function id(name: string): FakeNode {
  return new FakeNode("fake_identifier", name);
}

/** `fake_call "callee"`, optionally with a `receiver` field and argument children. */
function call(callee: string, opts: { receiver?: FakeNode; args?: FakeNode[] } = {}): FakeNode {
  const node = new FakeNode("fake_call", callee);
  if (opts.receiver !== undefined) {
    node.setField("receiver", opts.receiver);
  }
  for (const arg of opts.args ?? []) {
    node.addChild(arg);
  }
  return node;
}

/** A transparent region (an inline callback) wrapping the given statements. */
function lambda(...body: FakeNode[]): FakeNode {
  const node = new FakeNode("fake_lambda", "");
  for (const stmt of body) {
    node.addChild(stmt);
  }
  return node;
}

/** A hard-stop region (a nested named declaration) — never descended by Pass B. */
function nestedDecl(...body: FakeNode[]): FakeNode {
  const node = new FakeNode("fake_nested_decl", "");
  for (const stmt of body) {
    node.addChild(stmt);
  }
  return node;
}

function attributeCallee(node: FakeNode): CalleeAttribution {
  const receiver = node.childForFieldName("receiver") as FakeNode | null;
  if (receiver === null) {
    return {
      kind: "local-name",
      name: node.text,
      fallback:
        node.text === "builtinFn"
          ? { scheme: "test", package: "stdlib", segments: [{ kind: "method", name: "builtinFn" }] }
          : undefined,
    };
  }
  if (receiver.type === "fake_this") {
    return { kind: "local-this", name: node.text };
  }
  if (receiver.type === "fake_identifier" && receiver.text === "knownGlobal") {
    return {
      kind: "builtin",
      scheme: "test",
      package: "stdlib",
      segments: [
        { kind: "term", name: "knownGlobal" },
        { kind: "method", name: node.text },
      ],
    };
  }
  return { kind: "none" };
}

function classifyExpressionFake(node: SyntaxNode): ExpressionVerdict | undefined {
  switch (node.type) {
    case "fake_call": {
      const fakeNode = node as FakeNode;
      const receiver = fakeNode.childForFieldName("receiver") as FakeNode | null;
      return {
        emits: "CALL",
        kind: "call",
        calleeName: fakeNode.text,
        receiverText: receiver?.text,
        args: fakeNode.namedChildren.map((child) => ({
          node: child,
          identifier: child.type === "fake_identifier" ? child.text : undefined,
        })),
        callee: attributeCallee(fakeNode),
      };
    }
    case "fake_lambda":
      return { emits: "none", descend: "transparent" };
    case "fake_nested_decl":
      return { emits: "none", descend: "stop" };
    default:
      return undefined;
  }
}

/** A minimal declarations+calls adapter over the same made-up grammar `walk.test.ts` uses. */
const fakeAdapter: LanguageAdapter = {
  grammarId: "python",
  language: "fake",
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
          params: node.namedChildren
            .filter((c) => c.type === "fake_param")
            .map((p) => ({ name: p.text, node: p })),
          body: node.childForFieldName("body") ?? undefined,
        };
      case "fake_member":
        return {
          declares: "MEMBER",
          name: node.text,
          value: node.childForFieldName("value") ?? undefined,
        };
      default:
        return undefined;
    }
  },
  classifyExpression: classifyExpressionFake,
  localBindings(regionRoot: SyntaxNode): readonly string[] {
    const names: string[] = [];
    function visit(node: SyntaxNode): void {
      if (node.type === "fake_local_decl") {
        names.push(node.text);
        return;
      }
      if (node.type === "fake_lambda" || node.type === "fake_nested_decl") {
        return;
      }
      for (const child of node.namedChildren) {
        visit(child);
      }
    }
    visit(regionRoot);
    return names;
  },
};

/** Builds `path.fake` with one top-level METHOD `name` whose body is the given statements. */
function moduleWithMethodBody(name: string, ...body: FakeNode[]): FakeNode {
  const bodyNode = new FakeNode("fake_body", "");
  for (const stmt of body) {
    bodyNode.addChild(stmt);
  }
  const method = new FakeNode("fake_method", name).setField("body", bodyNode);
  const root = new FakeNode("fake_module", "");
  root.addChild(method);
  return root;
}

function extract(root: FakeNode) {
  return extractDeclarations({ path: "a.fake", root, adapter: fakeAdapter });
}

function cpgIds(delta: ReturnType<typeof extract>): string[] {
  return delta.nodes
    .filter((n) => n.labels.includes("CPG"))
    .map((n) => n.properties["id"] as string);
}

function callNode(delta: ReturnType<typeof extract>, nodeId: string) {
  return delta.nodes.find((n) => n.properties["id"] === nodeId)!;
}

describe("Pass B: bounded descent", () => {
  test("a call inside a transparent region (inline callback) is IN_SCOPE-attributed to the enclosing METHOD, no extra scope frame", () => {
    const root = moduleWithMethodBody("outer", lambda(call("inner")));
    const delta = extract(root);

    const inner = callNode(delta, "a.fake:CALL:outer/inner:0");
    expect(inner).toBeDefined();
    const inScope = delta.edges.find(
      (e) => e.type === "IN_SCOPE" && e.fromKey === inner.properties["id"],
    );
    expect(inScope?.toLabel).toBe("METHOD");
    expect(inScope?.toKey).toBe("a.fake:METHOD:outer");
  });

  test("a call inside a stop region (nested named declaration) is not emitted at all", () => {
    const root = moduleWithMethodBody("outer", nestedDecl(call("insideNested")));
    const delta = extract(root);

    expect(delta.nodes.some((n) => n.labels.includes("CALL"))).toBe(false);
  });

  test("a call in a class field initializer is IN_SCOPE-attributed to MODULE, scoped under the field's own frame", () => {
    const memberValue = call("mk");
    const member = new FakeNode("fake_member", "field").setField("value", memberValue);
    const classBody = new FakeNode("fake_body", "").addChild(member);
    const klass = new FakeNode("fake_class", "C").setField("body", classBody);
    const root = new FakeNode("fake_module", "").addChild(klass);

    const delta = extract(root);
    const callId = "a.fake:CALL:C/field/mk:0";
    const node = callNode(delta, callId);
    expect(node).toBeDefined();
    const inScope = delta.edges.find((e) => e.type === "IN_SCOPE" && e.fromKey === callId);
    expect(inScope?.toLabel).toBe("MODULE");
  });

  test("nested calls (a call inside another call's arguments) both get emitted, both IN_SCOPE-attributed", () => {
    const root = moduleWithMethodBody(
      "outer",
      call("log", { args: [call("fmt", { args: [id("x")] })] }),
    );
    const delta = extract(root);

    const log = callNode(delta, "a.fake:CALL:outer/log:0");
    const fmt = callNode(delta, "a.fake:CALL:outer/fmt:0");
    expect(log).toBeDefined();
    expect(fmt).toBeDefined();
    for (const c of [log, fmt]) {
      expect(
        delta.edges.some((e) => e.type === "IN_SCOPE" && e.fromKey === c.properties["id"]),
      ).toBe(true);
    }
  });

  test("every CALL node has exactly one IN_SCOPE edge", () => {
    const root = moduleWithMethodBody(
      "outer",
      call("a"),
      lambda(call("b")),
      call("c", { args: [call("d")] }),
    );
    const delta = extract(root);
    const calls = delta.nodes.filter((n) => n.labels.includes("CALL"));
    expect(calls.length).toBe(4);
    for (const c of calls) {
      const inScopeEdges = delta.edges.filter(
        (e) => e.type === "IN_SCOPE" && e.fromKey === c.properties["id"],
      );
      expect(inScopeEdges.length).toBe(1);
    }
  });
});

describe("Pass B: CALL ordinal keying", () => {
  test("ordinal is keyed per callee name, not position — inserting an unrelated call shifts nothing", () => {
    const before = extract(
      moduleWithMethodBody("outer", call("foo"), call("log"), call("bar"), call("log")),
    );
    expect(callNode(before, "a.fake:CALL:outer/foo:0")).toBeDefined();
    expect(callNode(before, "a.fake:CALL:outer/log:0")).toBeDefined();
    expect(callNode(before, "a.fake:CALL:outer/bar:0")).toBeDefined();
    expect(callNode(before, "a.fake:CALL:outer/log:1")).toBeDefined();

    const after = extract(
      moduleWithMethodBody(
        "outer",
        call("baz"),
        call("foo"),
        call("log"),
        call("bar"),
        call("log"),
      ),
    );
    const diff = idSetDiff(cpgIds(before), cpgIds(after));
    // Only the new call's own id is added; every existing id (including all
    // four original CALL ids) survives untouched.
    expect(diff.removed).toEqual([]);
    expect(diff.added).toEqual(["a.fake:CALL:outer/baz:0"]);
  });
});

describe("Pass B: SYMBOL attribution (README rule 2 — no bare-name SYMBOLs)", () => {
  test("an unattributable call (unknown receiver) mints a CALL with no SYMBOL and no CALLS edge", () => {
    const root = moduleWithMethodBody("outer", call("method", { receiver: id("unknownObj") }));
    const delta = extract(root);
    // Exactly one SYMBOL exists — the enclosing METHOD's own DEFINES target
    // (M0.7/M0.9 mints that unconditionally). The unattributable CALL adds none.
    const symbols = delta.nodes.filter((n) => n.labels.length === 1 && n.labels[0] === "SYMBOL");
    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.properties["fqn"]).toBe("`a.fake`/outer().");
    expect(delta.edges.some((e) => e.type === "CALLS")).toBe(false);
    expect(delta.nodes.some((n) => n.labels.includes("CALL"))).toBe(true);
  });

  test("a bare call to a builtin fallback name mints an external SYMBOL", () => {
    const root = moduleWithMethodBody("outer", call("builtinFn"));
    const delta = extract(root);
    const callsEdge = delta.edges.find((e) => e.type === "CALLS");
    expect(callsEdge?.toKey).toBe("test:stdlib`builtinFn().");
    expect(callsEdge?.properties["status"]).toBe("external");
    const symbol = delta.nodes.find(
      (n) =>
        n.labels.length === 1 &&
        n.labels[0] === "SYMBOL" &&
        n.properties["fqn"] === callsEdge?.toKey,
    );
    expect(symbol).toBeDefined();
  });

  test("this.method() resolves against the nearest enclosing TYPE_DECL — status resolved", () => {
    const method = new FakeNode("fake_method", "m").setField(
      "body",
      new FakeNode("fake_body", "").addChild(
        call("helper", { receiver: new FakeNode("fake_this", "this") }),
      ),
    );
    const classBody = new FakeNode("fake_body", "").addChild(method);
    const klass = new FakeNode("fake_class", "C").setField("body", classBody);
    const root = new FakeNode("fake_module", "").addChild(klass);

    const delta = extract(root);
    const callsEdge = delta.edges.find((e) => e.type === "CALLS");
    expect(callsEdge?.toKey).toBe("`a.fake`/C#helper().");
    expect(callsEdge?.properties["status"]).toBe("resolved");
  });

  test("a bare call resolving to a sibling top-level METHOD is 'resolved', forward references included", () => {
    const root = new FakeNode("fake_module", "");
    const caller = new FakeNode("fake_method", "caller").setField(
      "body",
      new FakeNode("fake_body", "").addChild(call("callee")),
    );
    const callee = new FakeNode("fake_method", "callee").setField(
      "body",
      new FakeNode("fake_body", ""),
    );
    // `callee` declared AFTER `caller` in source order — forward reference.
    root.addChild(caller).addChild(callee);

    const delta = extract(root);
    const callsEdge = delta.edges.find((e) => e.type === "CALLS");
    expect(callsEdge?.toKey).toBe("`a.fake`/callee().");
    expect(callsEdge?.properties["status"]).toBe("resolved");
  });
});

describe("Pass B: REACHING_DEF", () => {
  test("a module-level MEMBER's definition reaches a later call's bare-name argument", () => {
    const member = new FakeNode("fake_member", "X").setField(
      "value",
      new FakeNode("fake_literal", "1"),
    );
    const root = new FakeNode("fake_module", "")
      .addChild(member)
      .addChild(call("use", { args: [id("X")] }));

    const delta = extract(root);
    const reaching = delta.edges.find((e) => e.type === "REACHING_DEF");
    expect(reaching?.fromLabel).toBe("MEMBER");
    expect(reaching?.fromKey).toBe("a.fake:MEMBER:X");
    expect(reaching?.properties["variable"]).toBe("X");
  });

  test("a METHOD's own PARAM reaches a call inside its body", () => {
    const method = new FakeNode("fake_method", "m")
      .addChild(new FakeNode("fake_param", "p"))
      .setField("body", new FakeNode("fake_body", "").addChild(call("use", { args: [id("p")] })));
    const root = new FakeNode("fake_module", "").addChild(method);

    const delta = extract(root);
    const reaching = delta.edges.find((e) => e.type === "REACHING_DEF");
    expect(reaching?.fromLabel).toBe("PARAM");
    expect(reaching?.fromKey).toBe("a.fake:PARAM:m/p:0");
  });

  test("no forward reference: a call BEFORE a module MEMBER's declaration draws no edge from it", () => {
    const member = new FakeNode("fake_member", "X").setField(
      "value",
      new FakeNode("fake_literal", "1"),
    );
    const root = new FakeNode("fake_module", "")
      .addChild(call("use", { args: [id("X")] }))
      .addChild(member);

    const delta = extract(root);
    expect(delta.edges.some((e) => e.type === "REACHING_DEF")).toBe(false);
  });

  test("a local redeclaration shadows the outer MEMBER of the same name — no edge", () => {
    const member = new FakeNode("fake_member", "X").setField(
      "value",
      new FakeNode("fake_literal", "1"),
    );
    const shadowed = new FakeNode("fake_local_decl", "X");
    const root = moduleWithMethodBody("m", shadowed, call("use", { args: [id("X")] }));
    // The module-level member must exist BEFORE the method for the snapshot to include it.
    const fullRoot = new FakeNode("fake_module", "");
    fullRoot.addChild(member);
    for (const child of root.namedChildren) {
      fullRoot.addChild(child);
    }

    const delta = extract(fullRoot);
    expect(delta.edges.some((e) => e.type === "REACHING_DEF")).toBe(false);
  });

  test("f(x, x) — the same variable passed twice — yields exactly one REACHING_DEF edge (dedupe)", () => {
    const member = new FakeNode("fake_member", "X").setField(
      "value",
      new FakeNode("fake_literal", "1"),
    );
    const root = new FakeNode("fake_module", "")
      .addChild(member)
      .addChild(call("use", { args: [id("X"), id("X")] }));

    const delta = extract(root);
    const reachingEdges = delta.edges.filter((e) => e.type === "REACHING_DEF");
    expect(reachingEdges.length).toBe(1);
  });

  test("a non-bare-name argument (not a fake_identifier) draws no edge", () => {
    const member = new FakeNode("fake_member", "X").setField(
      "value",
      new FakeNode("fake_literal", "1"),
    );
    const nonBareArg = new FakeNode("fake_literal", "42");
    const root = new FakeNode("fake_module", "")
      .addChild(member)
      .addChild(call("use", { args: [nonBareArg] }));

    const delta = extract(root);
    expect(delta.edges.some((e) => e.type === "REACHING_DEF")).toBe(false);
  });
});
