import { afterEach, describe, expect, test } from "bun:test";
/** Grammar .wasm discovery (F4). */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { GRAMMARS, GRAMMAR_IDS } from "../../../src/parser/grammars.ts";
import { GRAMMAR_DIR_ENV, resolveGrammarDir } from "../../../src/parser/wasm-locator.ts";

const originalEnv = process.env[GRAMMAR_DIR_ENV];

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env[GRAMMAR_DIR_ENV];
  } else {
    process.env[GRAMMAR_DIR_ENV] = originalEnv;
  }
});

describe("resolveGrammarDir", () => {
  test("finds a directory that actually holds all four grammars", () => {
    const dir = resolveGrammarDir();
    for (const id of GRAMMAR_IDS) {
      expect(existsSync(join(dir, GRAMMARS[id].wasmFile))).toBe(true);
    }
  });

  test("an explicit directory wins over the environment", () => {
    process.env[GRAMMAR_DIR_ENV] = "/from/env";
    expect(resolveGrammarDir("/explicit")).toBe("/explicit");
  });

  test("the environment wins over package resolution", () => {
    process.env[GRAMMAR_DIR_ENV] = "/from/env";
    expect(resolveGrammarDir()).toBe("/from/env");
  });

  test("an empty override falls through rather than resolving to nothing", () => {
    delete process.env[GRAMMAR_DIR_ENV];
    expect(resolveGrammarDir("")).toBe(resolveGrammarDir());
  });
});
