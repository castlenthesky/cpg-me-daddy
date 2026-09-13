/**
 * The M0.11-lite gate, rehearsed with a fake `IGraphStore` — no database, no
 * CLI, just the real `WebTreeSitterBackend` and a tmp workspace. This is the
 * pipeline `cpg index` runs end to end: walk -> parse -> extract -> write.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { defineCpgConfig } from "../../../src/config/workspace-config.ts";
import { indexWorkspace } from "../../../src/indexer/index-workspace.ts";
import { WebTreeSitterBackend } from "../../../src/parser/web-tree-sitter-backend.ts";
import type { GraphDelta } from "../../../src/schema/validate.ts";
import { assertGraphDeltaValid } from "../../../src/schema/validate.ts";
import type { BootstrapReport } from "../../../src/store/bootstrap.ts";
import type { GraphMetadata, IGraphStore, WriteReport } from "../../../src/store/store.ts";
import { hashBytes } from "../../../src/workspace/hash.ts";
import { makeTmpWorkspace, type TmpWorkspace } from "../../support/tmp-workspace.ts";

const backend = new WebTreeSitterBackend();
afterAll(() => backend.dispose());

let workspace: TmpWorkspace | undefined;
afterEach(async () => {
  await workspace?.dispose();
  workspace = undefined;
});

class FakeGraphStore implements IGraphStore {
  readonly deltas: GraphDelta[] = [];

  async bootstrap(): Promise<BootstrapReport> {
    return {
      indexesCreated: [],
      indexesExisting: [],
      constraintsCreated: [],
      constraintsExisting: [],
      schemaVersion: { expected: 1, found: 1, action: "matched" },
    };
  }

  async writeDelta(delta: GraphDelta): Promise<WriteReport> {
    this.deltas.push(delta);
    return { nodesWritten: delta.nodes.length, edgesWritten: delta.edges.length, opsExecuted: 1 };
  }

  async deleteFile(): Promise<void> {}

  async readMetadata(): Promise<GraphMetadata | undefined> {
    return undefined;
  }

  async close(): Promise<void> {}
}

describe("indexWorkspace", () => {
  test("walks, parses, extracts and writes — skipping unsupported grammars and node_modules", async () => {
    const tsSource = "export function greet(): string {\n  return 'hi';\n}\n";
    const pySource = "def greet():\n    return 'hi'\n";
    workspace = await makeTmpWorkspace({
      "a.ts": tsSource,
      "b.py": pySource,
      "c.mjs": "export const x = 1;\n",
      "node_modules/pkg/index.ts": "SHOULD_NEVER_APPEAR",
    });

    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const store = new FakeGraphStore();

    const report = await indexWorkspace(config, { store, backend });

    expect(report.filesIndexed).toBe(2);
    expect(store.deltas.length).toBe(2);
    expect(report.cancelled).toBe(false);

    // The .mjs file yields exactly one deduplicated warning and no delta.
    expect(report.warnings).toEqual([
      {
        kind: "unsupported-grammar",
        language: "javascript",
        message: "javascript has no declaration adapter yet (M0.7).",
      },
    ]);

    // node_modules was never visited: only a.ts and b.py produced deltas.
    const filePaths = store.deltas
      .map((d) => d.nodes.find((n) => n.labels.includes("FILE"))?.properties["path"])
      .toSorted();
    expect(filePaths).toEqual(["a.ts", "b.py"]);

    // Every delta validates, carries exactly one FILE node with the right
    // hash, and every METHOD has an inbound DECLARES edge.
    for (const delta of store.deltas) {
      expect(() => assertGraphDeltaValid(delta)).not.toThrow();

      const fileNodes = delta.nodes.filter((n) => n.labels.includes("FILE"));
      expect(fileNodes.length).toBe(1);
      const fileNode = fileNodes[0]!;
      const path = fileNode.properties["path"] as string;
      const source = path === "a.ts" ? tsSource : pySource;
      expect(fileNode.properties["content_hash"]).toBe(hashBytes(new TextEncoder().encode(source)));

      const methodIds = delta.nodes
        .filter((n) => n.labels.includes("METHOD"))
        .map((n) => n.properties["id"] as string);
      expect(methodIds.length).toBeGreaterThan(0);
      for (const id of methodIds) {
        expect(delta.edges.some((e) => e.type === "DECLARES" && e.toKey === id)).toBe(true);
      }
    }
  });

  test("reports progress through walk, index, and done phases", async () => {
    workspace = await makeTmpWorkspace({ "a.ts": "export function f(): void {}\n" });
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const store = new FakeGraphStore();

    const phases: string[] = [];
    await indexWorkspace(config, { store, backend }, { onProgress: (p) => phases.push(p.phase) });

    expect(phases).toEqual(["walk", "index", "done"]);
  });

  test("an AbortSignal stops the run between files, not mid-file", async () => {
    workspace = await makeTmpWorkspace({
      "a.ts": "export function f(): void {}\n",
      "b.ts": "export function g(): void {}\n",
    });
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const store = new FakeGraphStore();
    const controller = new AbortController();
    controller.abort();

    const report = await indexWorkspace(config, { store, backend }, { signal: controller.signal });

    expect(report.cancelled).toBe(true);
    expect(report.filesIndexed).toBe(0);
  });

  test("a file that throws during extraction is a warning, not a fatal error", async () => {
    workspace = await makeTmpWorkspace({
      "good.ts": "export function f(): void {}\n",
      "bad.ts": "export function g(): void {}\n",
    });
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const store = new FakeGraphStore();

    const failingBackend: typeof backend = Object.create(backend);
    let callCount = 0;
    failingBackend.parse = (async (...args: Parameters<typeof backend.parse>) => {
      callCount++;
      if (callCount === 2) {
        throw new Error("boom");
      }
      return backend.parse(...args);
    }) as typeof backend.parse;

    const report = await indexWorkspace(config, { store, backend: failingBackend });

    expect(report.filesIndexed).toBe(1);
    expect(report.warnings.some((w) => w.kind === "parse-failed")).toBe(true);
  });
});
