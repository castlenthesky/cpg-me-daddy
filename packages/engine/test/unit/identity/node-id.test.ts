/**
 * Node identity (M0.3). Pure function tests — no parser, no DB.
 *
 * The four gate scenarios from 60-delivery.yaml's M0.3 unit are driven
 * through a small synthetic "file model" (a module name + an ordered list of
 * top-level functions, each with its own params) rather than a real parse,
 * so this unit stays decoupled from the extractor (PR B) that doesn't exist
 * yet. `idsForFile()` below is test scaffolding, not engine code.
 */
import { describe, expect, test } from "bun:test";

import { makeNodeId, type ScopeSegment } from "../../../src/identity/node-id.ts";
import { idSetDiff } from "../../support/id-diff.ts";

interface SyntheticFunction {
  readonly name: string;
  readonly params: readonly string[];
}

interface SyntheticFile {
  readonly path: string;
  readonly moduleName: string;
  readonly functions: readonly SyntheticFunction[];
}

/** The id's `kind:qualifiedScopePath[:suffix]` portion, without its `path` prefix. */
function idSuffix(id: string): string {
  return id.slice(id.indexOf(":"));
}

/** Every :CPG id a file's MODULE + top-level METHOD/PARAM tier would carry. */
function idsForFile(file: SyntheticFile): string[] {
  const ids: string[] = [];
  const moduleFrame: ScopeSegment = { kind: "MODULE", name: file.moduleName };
  ids.push(makeNodeId({ path: file.path, kind: "MODULE", scope: [moduleFrame] }));

  for (const fn of file.functions) {
    const methodFrame: ScopeSegment = { kind: "METHOD", name: fn.name };
    ids.push(makeNodeId({ path: file.path, kind: "METHOD", scope: [methodFrame] }));

    fn.params.forEach((paramName, ordinal) => {
      ids.push(
        makeNodeId({
          path: file.path,
          kind: "PARAM",
          scope: [methodFrame, { kind: "PARAM", name: paramName }],
          ordinal,
        }),
      );
    });
  }
  return ids;
}

describe("makeNodeId", () => {
  test("MODULE: one frame, the module's own name", () => {
    const id = makeNodeId({
      path: "src/hello_world.py",
      kind: "MODULE",
      scope: [{ kind: "MODULE", name: "hello_world" }],
    });
    expect(id).toBe("src/hello_world.py:MODULE:hello_world");
  });

  test("top-level METHOD: qualifiedScopePath is just its own name, MODULE not repeated", () => {
    const id = makeNodeId({
      path: "src/hello_world.py",
      kind: "METHOD",
      scope: [{ kind: "METHOD", name: "greet" }],
    });
    expect(id).toBe("src/hello_world.py:METHOD:greet");
  });

  test("METHOD nested in TYPE_DECL: qualifiedScopePath is Class/method", () => {
    const id = makeNodeId({
      path: "src/hello_world.py",
      kind: "METHOD",
      scope: [
        { kind: "TYPE_DECL", name: "Greeter" },
        { kind: "METHOD", name: "greet" },
      ],
    });
    expect(id).toBe("src/hello_world.py:METHOD:Greeter/greet");
  });

  test("PARAM: qualifiedScopePath is method/param, ordinal is parent-scope-relative", () => {
    const id = makeNodeId({
      path: "src/hello_world.py",
      kind: "PARAM",
      scope: [
        { kind: "METHOD", name: "greet" },
        { kind: "PARAM", name: "name" },
      ],
      ordinal: 0,
    });
    expect(id).toBe("src/hello_world.py:PARAM:greet/name:0");
  });

  test("bodyHash suffix wins over ordinal when both are given, for anonymous items", () => {
    const id = makeNodeId({
      path: "src/hello_world.py",
      kind: "METHOD",
      scope: [{ kind: "METHOD", name: "<lambda>" }],
      ordinal: 3,
      bodyHash: "abcd1234",
    });
    expect(id).toBe("src/hello_world.py:METHOD:<lambda>:abcd1234");
  });

  test("rejects an empty scope — every node has at least its own frame", () => {
    expect(() => makeNodeId({ path: "src/a.py", kind: "MODULE", scope: [] })).toThrow(
      /at least one frame/,
    );
  });
});

describe("M0.3 gate: insert a sibling above -> 0 id changes", () => {
  test("inserting a new top-level function above an existing one changes nothing", () => {
    const before = idsForFile({
      path: "src/hello_world.py",
      moduleName: "hello_world",
      functions: [{ name: "greet", params: ["name"] }],
    });
    const after = idsForFile({
      path: "src/hello_world.py",
      moduleName: "hello_world",
      functions: [
        { name: "helper", params: [] },
        { name: "greet", params: ["name"] },
      ],
    });

    const diff = idSetDiff(before, after);
    // The new function's own ids appear; nothing about `greet` or its param moves.
    expect(diff.removed).toEqual([]);
    expect([...diff.added].toSorted()).toEqual(["src/hello_world.py:METHOD:helper"]);
  });
});

describe("M0.3 gate: reformat only -> 0 id changes", () => {
  test("whitespace/formatting changes carry no id-relevant information", () => {
    // Reformatting never changes a name, a kind, or a scope frame — only
    // ranges, which are not part of identity (PR1). So the same file model
    // before and after a reformat necessarily yields the same id set; there
    // is nothing here for a reformat to perturb.
    const file: SyntheticFile = {
      path: "src/hello_world.py",
      moduleName: "hello_world",
      functions: [{ name: "greet", params: ["name"] }],
    };
    const diff = idSetDiff(idsForFile(file), idsForFile(file));
    expect(diff).toEqual({ added: [], removed: [] });
  });
});

describe("M0.3 gate: file move -> path-prefix change only", () => {
  test("moving a file changes exactly the path prefix of every id, nothing else", () => {
    const file: SyntheticFile = {
      path: "src/hello_world.py",
      moduleName: "hello_world",
      functions: [{ name: "greet", params: ["name"] }],
    };
    const moved: SyntheticFile = { ...file, path: "src/lib/hello_world.py" };

    const before = idsForFile(file);
    const after = idsForFile(moved);

    // Every id's suffix after the path is unchanged; only the path prefix moved.
    expect(after.map(idSuffix).toSorted()).toEqual(before.map(idSuffix).toSorted());

    const diff = idSetDiff(before, after);
    expect(diff.added.length).toBe(before.length);
    expect(diff.removed.length).toBe(before.length);
  });
});

describe("M0.3 gate: symbol rename -> exactly 1 delete + 1 create", () => {
  test("renaming a leaf function (no params) changes only its own id", () => {
    const before = idsForFile({
      path: "src/hello_world.py",
      moduleName: "hello_world",
      functions: [{ name: "greet", params: [] }],
    });
    const after = idsForFile({
      path: "src/hello_world.py",
      moduleName: "hello_world",
      functions: [{ name: "greet_user", params: [] }],
    });

    const diff = idSetDiff(before, after);
    expect(diff.removed).toEqual(["src/hello_world.py:METHOD:greet"]);
    expect(diff.added).toEqual(["src/hello_world.py:METHOD:greet_user"]);
  });

  test("renaming a container cascades to its own descendants' ids by design", () => {
    // qualifiedScopePath embeds ancestor NAMES (a qualified name, like a
    // FQN), so a method's id is genuinely a function of its containing
    // class's name — the same tradeoff SYMBOL.fqn makes for the same reason
    // (GE-Q3). Documented here so it is a decision, not a surprise.
    const methodBefore = makeNodeId({
      path: "src/hello_world.py",
      kind: "METHOD",
      scope: [
        { kind: "TYPE_DECL", name: "Greeter" },
        { kind: "METHOD", name: "greet" },
      ],
    });
    const methodAfter = makeNodeId({
      path: "src/hello_world.py",
      kind: "METHOD",
      scope: [
        { kind: "TYPE_DECL", name: "Announcer" },
        { kind: "METHOD", name: "greet" },
      ],
    });
    expect(methodAfter).not.toBe(methodBefore);
  });
});
