/** The grammar registry and the extension routing it drives (F4). */
import { describe, expect, test } from "bun:test";

import {
  EXTENSION_TO_GRAMMAR,
  GRAMMAR_IDS,
  GRAMMARS,
  grammarForExtension,
  grammarForPath,
  isGrammarId,
} from "../../../src/parser/grammars.ts";

describe("grammar registry", () => {
  test("registers exactly the four v1 grammars", () => {
    expect([...GRAMMAR_IDS]).toEqual(["typescript", "tsx", "javascript", "python"]);
    expect(Object.keys(GRAMMARS).toSorted()).toEqual(["javascript", "python", "tsx", "typescript"]);
  });

  test("every spec is self-consistent and points at a .wasm", () => {
    for (const id of GRAMMAR_IDS) {
      const spec = GRAMMARS[id];
      expect(spec.id).toBe(id);
      expect(spec.wasmFile).toMatch(/^tree-sitter-[a-z-]+\.wasm$/);
      expect(spec.extensions.length).toBeGreaterThan(0);
    }
  });

  test("no extension routes to two grammars", () => {
    const all = GRAMMAR_IDS.flatMap((id) => GRAMMARS[id].extensions);
    expect(new Set(all).size).toBe(all.length);
    expect(EXTENSION_TO_GRAMMAR.size).toBe(all.length);
  });
});

describe("extension routing", () => {
  // 40-research.yaml adopted_defaults.parsing.grammars.
  const cases: ReadonlyArray<readonly [string, string]> = [
    [".ts", "typescript"],
    [".mts", "typescript"],
    [".cts", "typescript"],
    [".tsx", "tsx"],
    [".js", "javascript"],
    [".jsx", "javascript"],
    [".mjs", "javascript"],
    [".cjs", "javascript"],
    [".py", "python"],
  ];

  for (const [ext, expected] of cases) {
    test(`${ext} -> ${expected}`, () => {
      expect(grammarForExtension(ext)).toBe(expected);
      expect(grammarForPath(`/repo/src/thing${ext}`)).toBe(expected);
    });
  }

  test("tolerates a missing dot and upper case", () => {
    expect(grammarForExtension("ts")).toBe("typescript");
    expect(grammarForExtension(".TSX")).toBe("tsx");
    expect(grammarForPath("/repo/A.PY")).toBe("python");
  });

  test("returns undefined for anything we do not parse", () => {
    expect(grammarForExtension(".rs")).toBeUndefined();
    expect(grammarForPath("/repo/README.md")).toBeUndefined();
    expect(grammarForPath("/repo/Makefile")).toBeUndefined();
    expect(grammarForPath("/repo/.gitignore")).toBeUndefined();
    expect(grammarForPath("")).toBeUndefined();
  });

  test("takes only the last extension", () => {
    expect(grammarForPath("/repo/types.d.ts")).toBe("typescript");
    expect(grammarForPath("/repo/a.py.bak")).toBeUndefined();
  });

  test("a dot in a parent directory does not leak into the decision", () => {
    expect(grammarForPath("/repo/v1.2/Makefile")).toBeUndefined();
  });
});

describe("isGrammarId", () => {
  test("accepts the four ids and nothing else", () => {
    for (const id of GRAMMAR_IDS) {
      expect(isGrammarId(id)).toBe(true);
    }
    expect(isGrammarId("rust")).toBe(false);
    expect(isGrammarId("toString")).toBe(false);
  });
});
