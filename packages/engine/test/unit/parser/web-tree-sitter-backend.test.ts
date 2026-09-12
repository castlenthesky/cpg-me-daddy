import { afterAll, describe, expect, test } from "bun:test";
/**
 * The F4 load gate (spike SP1).
 *
 * "All four grammars load and parse a smoke file to a non-error root." This is
 * the test that would have caught an ABI drift, a wasm that ships but does not
 * load, or a grammar routed at the wrong file extension — all of which fail as
 * a silent ERROR root rather than as an exception.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GRAMMARS, type GrammarId } from "../../../src/parser/grammars.ts";
import { WebTreeSitterBackend } from "../../../src/parser/web-tree-sitter-backend.ts";

const backend = new WebTreeSitterBackend();

afterAll(() => {
  backend.dispose();
});

/** Realistic snippets: each one uses syntax only its own grammar accepts. */
const SMOKE: Readonly<Record<GrammarId, string>> = {
  typescript: [
    "import { readFile } from 'node:fs/promises';",
    "",
    "export interface Config { readonly root: string; depth?: number }",
    "",
    "export async function load(path: string): Promise<Config> {",
    "  const raw: string = await readFile(path, 'utf8');",
    "  return JSON.parse(raw) as Config;",
    "}",
    "",
  ].join("\n"),
  tsx: [
    "import * as React from 'react';",
    "",
    "interface Props { readonly name: string; items: string[] }",
    "",
    "export const List = ({ name, items }: Props): React.JSX.Element => (",
    '  <section className="list" aria-label={name}>',
    "    {items.map((item) => (",
    "      <li key={item}>{item}</li>",
    "    ))}",
    "  </section>",
    ");",
    "",
  ].join("\n"),
  javascript: [
    "const { join } = require('node:path');",
    "",
    "class Store {",
    "  #entries = new Map();",
    "  put(key, value) { this.#entries.set(key, value); return this; }",
    "  *[Symbol.iterator]() { yield* this.#entries; }",
    "}",
    "",
    "module.exports = { Store, join };",
    "",
  ].join("\n"),
  python: [
    "from dataclasses import dataclass",
    "",
    "",
    "@dataclass",
    "class Config:",
    "    root: str",
    "    depth: int = 0",
    "",
    "",
    "def load(path: str) -> Config:",
    "    with open(path) as handle:",
    "        return Config(**{k: v for k, v in enumerate(handle)})",
    "",
  ].join("\n"),
};

describe("WebTreeSitterBackend", () => {
  test("reports its ABI range only after init()", async () => {
    const fresh = new WebTreeSitterBackend();
    expect(() => fresh.abiSupport()).toThrow(/before init\(\) resolved/);
    await fresh.init();
    const range = fresh.abiSupport();
    expect(range.minCompatible).toBeLessThanOrEqual(range.languageVersion);
    expect(Number.isInteger(range.minCompatible)).toBe(true);
    expect(Number.isInteger(range.languageVersion)).toBe(true);
    fresh.dispose();
  });

  test("init() is idempotent under concurrency", async () => {
    await Promise.all([backend.init(), backend.init(), backend.init()]);
    expect(backend.abiSupport().languageVersion).toBeGreaterThan(0);
  });

  for (const id of Object.keys(GRAMMARS) as GrammarId[]) {
    test(`${id}: loads with an in-range ABI and parses to a non-error root`, async () => {
      const loaded = await backend.loadGrammar(id);
      const range = backend.abiSupport();

      expect(loaded.id).toBe(id);
      expect(loaded.abiVersion).toBeGreaterThanOrEqual(range.minCompatible);
      expect(loaded.abiVersion).toBeLessThanOrEqual(range.languageVersion);

      const parsed = await backend.parse(id, SMOKE[id]);
      expect(parsed.grammarId).toBe(id);
      expect(parsed.rootType).toBe(GRAMMARS[id].rootNodeType);
      // The gate: SP1's "fail on empty Error".
      expect(parsed.hasError).toBe(false);
      expect(parsed.tree.rootNode.childCount).toBeGreaterThan(0);

      parsed.tree.delete();
    });
  }

  test("caches: a second loadGrammar returns the same ABI without re-reading", async () => {
    const first = await backend.loadGrammar("python");
    const second = await backend.loadGrammar("python");
    expect(second).toEqual(first);
  });
});

describe("the typescript/tsx split is load-bearing", () => {
  // Why two grammars exist for one language. If either of these ever stops
  // being true, the extension routing in grammars.ts can be simplified — and
  // until then, routing .tsx at the typescript grammar corrupts the tree.
  test("the typescript grammar rejects JSX that the tsx grammar accepts", async () => {
    const jsx = 'const el = <div className="a">{x}</div>;\n';
    expect((await backend.parse("typescript", jsx)).hasError).toBe(true);
    expect((await backend.parse("tsx", jsx)).hasError).toBe(false);
  });

  test("the tsx grammar rejects the <T>x cast that the typescript grammar accepts", async () => {
    const cast = "const n = <number>value;\n";
    expect((await backend.parse("typescript", cast)).hasError).toBe(false);
    expect((await backend.parse("tsx", cast)).hasError).toBe(true);
  });
});

describe("failure reporting", () => {
  test("a missing grammar directory names the file and the override", async () => {
    const broken = new WebTreeSitterBackend({ grammarDir: "/nonexistent/cpg-f4-grammars" });
    await expect(broken.loadGrammar("python")).rejects.toThrow(
      /cannot read its wasm at \/nonexistent\/cpg-f4-grammars\/tree-sitter-python\.wasm/,
    );
    await expect(broken.loadGrammar("python")).rejects.toThrow(/CPG_GRAMMAR_DIR/);
    broken.dispose();
  });

  test("a file that is present but is not a grammar is refused, not parsed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cpg-f4-"));
    writeFileSync(join(dir, GRAMMARS.python.wasmFile), "this is not webassembly\n");
    const notWasm = new WebTreeSitterBackend({ grammarDir: dir });
    expect(notWasm.grammarDirectory).toBe(dir);
    await expect(notWasm.loadGrammar("python")).rejects.toThrow(
      /is not a loadable tree-sitter grammar/,
    );
    notWasm.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
});
