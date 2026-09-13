/**
 * The loop `hello-world.cpg.test.ts` documents as still open: this is what
 * actually runs the real adapters against the golden sources and asserts
 * the produced delta is byte-identical to the checked-in JSON. Before this
 * test existed, nothing did — the hand-authored goldens were only ever
 * validated against the schema, never against real extractor output, which
 * is exactly how the TS golden's CALL range (an off-by-one against the
 * statement's extent, not the call expression's) went unnoticed until this
 * unit (M0.7/M0.9).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { extractFile } from "../../../src/extract/index.ts";
import { pythonAdapter } from "../../../src/extract/python.ts";
import { typeScriptAdapter } from "../../../src/extract/typescript.ts";
import { WebTreeSitterBackend } from "../../../src/parser/web-tree-sitter-backend.ts";
import type { GraphDelta } from "../../../src/schema/validate.ts";

// Same convention as test/unit/extract/{python,typescript}.test.ts and this
// directory's own hello-world.cpg.test.ts: `__dirname`, not `import.meta.url`.
const FIXTURE_ROOT = join(__dirname, "../../../../../test/fixtures/golden/simple");

const backend = new WebTreeSitterBackend();
afterAll(() => backend.dispose());

function loadGoldenDelta(lang: "python" | "typescript"): GraphDelta {
  const path = join(FIXTURE_ROOT, lang, "hello_world.cpg.json");
  const golden = JSON.parse(readFileSync(path, "utf8")) as { file: string } & GraphDelta;
  return { file: golden.file, nodes: golden.nodes, edges: golden.edges };
}

describe("extractor output matches the checked-in goldens byte-exactly", () => {
  test("typescript", async () => {
    const path = join(FIXTURE_ROOT, "typescript", "hello_world.ts");
    const text = readFileSync(path, "utf8");
    const delta = await extractFile(backend, typeScriptAdapter, { path: "hello_world.ts", text });
    expect(delta).toEqual(loadGoldenDelta("typescript"));
  });

  test("python", async () => {
    const path = join(FIXTURE_ROOT, "python", "hello_world.py");
    const text = readFileSync(path, "utf8");
    const delta = await extractFile(backend, pythonAdapter, { path: "hello_world.py", text });
    expect(delta).toEqual(loadGoldenDelta("python"));
  });
});
