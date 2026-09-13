/**
 * `SYMBOL.fqn` grammar (M0.7/M0.9). The four checked table rows reproduce
 * the two golden fixtures' four SYMBOLs byte-exactly — see
 * `test/fixtures/golden/simple/{typescript,python}/hello_world.cpg.json`.
 */
import { describe, expect, test } from "bun:test";

import {
  descriptorPath,
  descriptorsForScope,
  externalOwner,
  localOwner,
  makeSymbolFqn,
  type SymbolSegment,
} from "../../../src/identity/symbol-id.ts";

describe("makeSymbolFqn", () => {
  test("reproduces the TypeScript golden's local SYMBOL", () => {
    const fqn = makeSymbolFqn(localOwner("hello_world.ts"), [
      { kind: "term", name: "DISPLAY_TEXT" },
    ]);
    expect(fqn).toBe("`hello_world.ts`/DISPLAY_TEXT.");
  });

  test("reproduces the Python golden's local SYMBOL", () => {
    const fqn = makeSymbolFqn(localOwner("hello_world.py"), [
      { kind: "term", name: "DISPLAY_TEXT" },
    ]);
    expect(fqn).toBe("`hello_world.py`/DISPLAY_TEXT.");
  });

  test("reproduces the TypeScript golden's external SYMBOL (console.log)", () => {
    const fqn = makeSymbolFqn(externalOwner("site", "node"), [
      { kind: "term", name: "console" },
      { kind: "method", name: "log" },
    ]);
    expect(fqn).toBe("site:node`console.log().");
  });

  test("reproduces the Python golden's external SYMBOL (print)", () => {
    const fqn = makeSymbolFqn(externalOwner("site", "python-stdlib"), [
      { kind: "method", name: "print" },
    ]);
    expect(fqn).toBe("site:python-stdlib`print().");
  });

  test("a method on a class, at depth", () => {
    const fqn = makeSymbolFqn(localOwner("hello_world.ts"), [
      { kind: "type", name: "Greeter" },
      { kind: "method", name: "greet" },
    ]);
    expect(fqn).toBe("`hello_world.ts`/Greeter#greet().");
  });

  test("a member on a class, at depth", () => {
    const fqn = makeSymbolFqn(localOwner("hello_world.ts"), [
      { kind: "type", name: "Greeter" },
      { kind: "term", name: "prefix" },
    ]);
    expect(fqn).toBe("`hello_world.ts`/Greeter#prefix.");
  });

  test("a top-level function", () => {
    const fqn = makeSymbolFqn(localOwner("hello_world.ts"), [
      { kind: "method", name: "greetUser" },
    ]);
    expect(fqn).toBe("`hello_world.ts`/greetUser().");
  });

  test("a namespace/module symbol (no descriptors) renders just the owner", () => {
    const segments: readonly SymbolSegment[] = [];
    expect(makeSymbolFqn(localOwner("pkg/sub.ts"), segments)).toBe("`pkg/sub.ts`/");
  });
});

describe("descriptorPath", () => {
  test("concatenates suffixes per kind", () => {
    expect(
      descriptorPath([
        { kind: "namespace", name: "pkg" },
        { kind: "type", name: "T" },
        { kind: "method", name: "m" },
        { kind: "term", name: "x" },
      ]),
    ).toBe("pkg/T#m().x.");
  });

  test("empty segments render empty", () => {
    expect(descriptorPath([])).toBe("");
  });
});

describe("descriptorsForScope", () => {
  test("drops MODULE and maps TYPE_DECL/METHOD/MEMBER to type/method/term", () => {
    const segments = descriptorsForScope([
      { kind: "MODULE", name: "hello_world" },
      { kind: "TYPE_DECL", name: "Greeter" },
      { kind: "METHOD", name: "greet" },
    ]);
    expect(segments).toEqual([
      { kind: "type", name: "Greeter" },
      { kind: "method", name: "greet" },
    ]);
  });

  test("a bare MEMBER scope maps to one term segment", () => {
    expect(descriptorsForScope([{ kind: "MEMBER", name: "DISPLAY_TEXT" }])).toEqual([
      { kind: "term", name: "DISPLAY_TEXT" },
    ]);
  });

  test("throws on a scope kind with no SYMBOL mapping (e.g. CALL, PARAM)", () => {
    expect(() => descriptorsForScope([{ kind: "CALL", name: "log" }])).toThrow();
    expect(() => descriptorsForScope([{ kind: "PARAM", name: "x" }])).toThrow();
  });
});

describe("localOwner / externalOwner", () => {
  test("localOwner backtick-escapes and slash-terminates the path", () => {
    expect(localOwner("hello_world.ts")).toBe("`hello_world.ts`/");
  });

  test("externalOwner joins scheme:package with a trailing backtick", () => {
    expect(externalOwner("site", "node")).toBe("site:node`");
  });
});
