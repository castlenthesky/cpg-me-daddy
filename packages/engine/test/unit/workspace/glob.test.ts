/** The M0.2 glob subset: anchoring, `**`, `*`, `?`, and directory-only patterns. */
import { describe, expect, test } from "bun:test";

import { compileMatcher } from "../../../src/workspace/glob.ts";

describe("compileMatcher", () => {
  test("anchored /src/** excludes root src/ but not packages/engine/src/ — the load-bearing case", () => {
    const m = compileMatcher(["/src/**"]);
    expect(m.test("src/a.ts", false)).toBe(true);
    expect(m.test("src/nested/b.ts", false)).toBe(true);
    // The bug this test exists to catch: an unanchored equivalent would also
    // exclude every package's own src/, silently indexing nothing.
    expect(m.test("packages/engine/src/a.ts", false)).toBe(false);
    expect(m.test("packages/engine/src/nested/b.ts", false)).toBe(false);
  });

  test("**/node_modules/** matches at any depth, unanchored", () => {
    const m = compileMatcher(["**/node_modules/**"]);
    expect(m.test("node_modules/x.js", false)).toBe(true);
    expect(m.test("node_modules/pkg/index.js", false)).toBe(true);
    expect(m.test("a/b/node_modules/pkg/index.js", false)).toBe(true);
    expect(m.test("a/b/node_modules_extra/index.js", false)).toBe(false);
  });

  test("directory pattern also prunes the directory itself, not just its contents", () => {
    const m = compileMatcher(["**/node_modules/**"]);
    // The walker tests directories directly (isDirectory=true) to decide
    // whether to descend at all — this must match without enumerating first.
    expect(m.test("a/b/node_modules", true)).toBe(true);
    expect(m.test("node_modules", true)).toBe(true);
    expect(m.test("a/b/node_modules_extra", true)).toBe(false);
  });

  test("* matches within one segment only", () => {
    const m = compileMatcher(["**/*.d.ts"]);
    expect(m.test("index.d.ts", false)).toBe(true);
    expect(m.test("packages/engine/src/index.d.ts", false)).toBe(true);
    expect(m.test("packages/engine/src/index.ts", false)).toBe(false);
  });

  test("? matches exactly one character", () => {
    const m = compileMatcher(["a?.txt"]);
    expect(m.test("ab.txt", false)).toBe(true);
    expect(m.test("a.txt", false)).toBe(false);
    expect(m.test("abc.txt", false)).toBe(false);
  });

  test("** alone matches zero segments (a/**/b matches a/b)", () => {
    const m = compileMatcher(["a/**/b.ts"]);
    expect(m.test("a/b.ts", false)).toBe(true);
    expect(m.test("a/x/b.ts", false)).toBe(true);
    expect(m.test("a/x/y/b.ts", false)).toBe(true);
  });

  test("trailing / is directory-only: never matches a file of the same name", () => {
    const m = compileMatcher(["dist/"]);
    expect(m.test("dist", true)).toBe(true);
    expect(m.test("dist", false)).toBe(false);
    expect(m.test("packages/cli/dist", true)).toBe(true);
  });

  test("literal characters in a pattern are escaped, not treated as regex metacharacters", () => {
    const m = compileMatcher(["**/*.min.js"]);
    expect(m.test("app.min.js", false)).toBe(true);
    // "." must not act as "any character" — "aXminXjs" would match a naive
    // pattern-to-regex translation that forgot to escape dots.
    expect(m.test("aXminXjs", false)).toBe(false);
  });

  test("an empty pattern set matches nothing", () => {
    const m = compileMatcher([]);
    expect(m.test("anything.ts", false)).toBe(false);
  });
});
