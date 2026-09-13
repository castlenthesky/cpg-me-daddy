/**
 * The `GrammarId -> LanguageAdapter` registry (M0.11-lite): which grammars
 * have a declaration adapter today, and — the correctness boundary this
 * file exists to guard — that `tsx` is a genuine clone of the TypeScript
 * adapter, not an alias that would parse `.tsx` files with the wrong
 * grammar.
 */
import { afterAll, describe, expect, test } from "bun:test";

import { extractFile } from "../../../src/extract/index.ts";
import { adapterFor, SUPPORTED_GRAMMAR_IDS } from "../../../src/extract/registry.ts";
import { tsxAdapter, typeScriptAdapter } from "../../../src/extract/typescript.ts";
import { WebTreeSitterBackend } from "../../../src/parser/web-tree-sitter-backend.ts";

const backend = new WebTreeSitterBackend();
afterAll(() => backend.dispose());

function shape(
  nodes: readonly { labels: string[]; properties: Record<string, unknown> }[],
): string[] {
  return nodes
    .map(
      (n) =>
        `${n.labels.toSorted().join("+")}:${n.properties["name"] ?? ""}:${n.properties["kind"] ?? ""}`,
    )
    .toSorted();
}

describe("SUPPORTED_GRAMMAR_IDS / adapterFor", () => {
  test("covers exactly typescript, tsx and python", () => {
    expect([...SUPPORTED_GRAMMAR_IDS].toSorted()).toEqual(["python", "tsx", "typescript"]);
  });

  test("returns the right adapter for each supported id", () => {
    expect(adapterFor("typescript")).toBe(typeScriptAdapter);
    expect(adapterFor("tsx")).toBe(tsxAdapter);
    expect(adapterFor("python")?.grammarId).toBe("python");
  });

  test("javascript has no adapter yet — undefined, not an alias to typescript", () => {
    expect(adapterFor("javascript")).toBeUndefined();
  });
});

describe("tsxAdapter", () => {
  test("carries the tsx grammar id, not typescript's", () => {
    expect(tsxAdapter.grammarId).toBe("tsx");
    expect(typeScriptAdapter.grammarId).toBe("typescript");
  });

  test("classifies plain TS-compatible source identically to the typescript adapter", async () => {
    // Syntax the tsx grammar and the typescript grammar both parse
    // identically (no JSX, no `<T>x` cast) — proves the classification
    // logic is genuinely shared, not merely coincidentally similar.
    const source = [
      "export class Greeter {",
      "  name: string;",
      "  greet(): string {",
      "    return this.name;",
      "  }",
      "}",
      "",
    ].join("\n");

    const tsDelta = await extractFile(backend, typeScriptAdapter, { path: "a.ts", text: source });
    const tsxDelta = await extractFile(backend, tsxAdapter, { path: "a.tsx", text: source });

    expect(shape(tsxDelta.nodes)).toEqual(shape(tsDelta.nodes));
  });
});
