/**
 * The M0.11-lite gate, rehearsed with a fake `IGraphStore` — no database, no
 * CLI, just the real `WebTreeSitterBackend` and a tmp workspace. This is the
 * pipeline `cpg index` runs end to end: walk -> parse -> extract -> write,
 * plus the filesystem tier (every walked file gets a FILE node regardless of
 * whether it parses) that now runs alongside it.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { defineCpgConfig } from "../../../src/config/workspace-config.ts";
import { indexWorkspace } from "../../../src/indexer/index-workspace.ts";
import { WebTreeSitterBackend } from "../../../src/parser/web-tree-sitter-backend.ts";
import type { GraphDelta } from "../../../src/schema/validate.ts";
import type { BootstrapReport } from "../../../src/store/bootstrap.ts";
import type { FilesystemDelta } from "../../../src/store/cypher.ts";
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
  readonly fsDeltas: FilesystemDelta[] = [];
  readonly deletedFiles: string[] = [];

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

  async writeFilesystem(delta: FilesystemDelta): Promise<WriteReport> {
    this.fsDeltas.push(delta);
    const nodesWritten = (delta.directories?.length ?? 0) + (delta.files?.length ?? 0);
    const edgesWritten =
      (delta.directories?.filter((d) => d.parent !== undefined).length ?? 0) +
      (delta.files?.length ?? 0);
    return { nodesWritten, edgesWritten, opsExecuted: 1 };
  }

  async deleteFile(file: string): Promise<void> {
    this.deletedFiles.push(file);
  }

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

    // All three walked files get a FILE node (the filesystem tier); only
    // a.ts and b.py additionally produce an AST delta.
    expect(report.filesIndexed).toBe(3);
    expect(store.deltas.length).toBe(2);
    expect(report.cancelled).toBe(false);

    // The .mjs file yields exactly one deduplicated warning and no AST delta.
    expect(report.warnings).toEqual([
      {
        kind: "unsupported-grammar",
        language: "javascript",
        message: "javascript has no declaration adapter yet (M0.7).",
      },
    ]);

    // node_modules was never visited: only a.ts and b.py produced deltas,
    // identified by their MODULE node's own `file` property (FILE nodes
    // themselves now live in the filesystem tier, not in a per-file delta).
    const filePaths = store.deltas
      .map((d) => d.nodes.find((n) => n.labels.includes("MODULE"))?.properties["file"])
      .toSorted();
    expect(filePaths).toEqual(["a.ts", "b.py"]);

    // Every delta validates and every METHOD has an inbound DECLARES edge.
    for (const delta of store.deltas) {
      const methodIds = delta.nodes
        .filter((n) => n.labels.includes("METHOD"))
        .map((n) => n.properties["id"] as string);
      expect(methodIds.length).toBeGreaterThan(0);
      for (const id of methodIds) {
        expect(delta.edges.some((e) => e.type === "DECLARES" && e.toKey === id)).toBe(true);
      }

      // Every delta's MODULE root also carries a SOURCE_FILE edge to its own
      // FILE node — the bridge that connects the filesystem tier to the
      // :CPG tier (previously the only join was the `file` property).
      const moduleNode = delta.nodes.find((n) => n.labels.includes("MODULE"))!;
      const moduleId = moduleNode.properties["id"] as string;
      const fileNode = delta.nodes.find((n) => n.labels.includes("FILE"))!;
      expect(fileNode.labels).toEqual(["FILE"]);
      expect(fileNode.properties["path"]).toBe(moduleNode.properties["file"]);
      expect(
        delta.edges.some(
          (e) =>
            e.type === "SOURCE_FILE" &&
            e.fromKey === moduleId &&
            e.toKey === fileNode.properties["path"],
        ),
      ).toBe(true);
    }

    // The filesystem tier still carries every file's content hash.
    const fsFiles = store.fsDeltas[0]!.files ?? [];
    const a = fsFiles.find((f) => f.path === "a.ts")!;
    expect(a.content_hash).toBe(hashBytes(new TextEncoder().encode(tsSource)));
    const b = fsFiles.find((f) => f.path === "b.py")!;
    expect(b.content_hash).toBe(hashBytes(new TextEncoder().encode(pySource)));
  });

  test("writes the filesystem tier for every non-ignored file, parseable or not, excluding node_modules", async () => {
    const tsSource = "export function greet(): string {\n  return 'hi';\n}\n";
    workspace = await makeTmpWorkspace({
      "a.ts": tsSource,
      "b.py": "def greet():\n    return 'hi'\n",
      "c.mjs": "export const x = 1;\n",
      "README.md": "# not source\n",
      "node_modules/pkg/index.ts": "SHOULD_NEVER_APPEAR",
    });

    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const store = new FakeGraphStore();

    const report = await indexWorkspace(config, { store, backend });

    expect(report.cancelled).toBe(false);
    // Every walked file gets a FILE node — a.ts, b.py, c.mjs, README.md.
    expect(report.filesIndexed).toBe(4);
    expect(store.fsDeltas.length).toBe(1);
    const fsDelta = store.fsDeltas[0]!;
    const files = fsDelta.files ?? [];

    expect(files.map((f) => f.path).toSorted()).toEqual(
      ["README.md", "a.ts", "b.py", "c.mjs"].toSorted(),
    );

    const readme = files.find((f) => f.path === "README.md")!;
    expect(readme.language).toBe("none");
    const ts = files.find((f) => f.path === "a.ts")!;
    expect(ts.language).toBe("typescript");
    expect(ts.content_hash).toBe(hashBytes(new TextEncoder().encode(tsSource)));
    expect(ts.parent).toBe(".");

    // node_modules was never visited.
    expect(files.some((f) => f.path.includes("node_modules"))).toBe(false);
    const directories = fsDelta.directories ?? [];
    expect(directories.some((d) => d.path.includes("node_modules"))).toBe(false);

    // The workspace root is present, has no parent, and every other
    // directory/file names a real parent directory.
    expect(directories.some((d) => d.path === "." && d.parent === undefined)).toBe(true);
    const dirPaths = new Set(directories.map((d) => d.path));
    for (const f of files) {
      expect(dirPaths.has(f.parent)).toBe(true);
    }
  });

  test("reports progress through walk, index, filesystem, and done phases", async () => {
    workspace = await makeTmpWorkspace({ "a.ts": "export function f(): void {}\n" });
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const store = new FakeGraphStore();

    const phases: string[] = [];
    await indexWorkspace(config, { store, backend }, { onProgress: (p) => phases.push(p.phase) });

    expect(phases).toEqual(["walk", "index", "filesystem", "done"]);
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

    // Both files still get a FILE node (the filesystem tier doesn't gate on
    // parse success) — only the AST delta for bad.ts is skipped.
    expect(report.filesIndexed).toBe(2);
    expect(store.deltas.length).toBe(1);
    expect(report.warnings.some((w) => w.kind === "parse-failed")).toBe(true);
  });
});
