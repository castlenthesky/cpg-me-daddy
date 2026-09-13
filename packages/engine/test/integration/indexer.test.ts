/**
 * M0.11-lite's gate, live: `cpg index --workspace .` sanity checks (a MODULE
 * per walked file, every METHOD has an inbound DECLARES edge) against a real
 * FalkorDB, plus the property nothing else in the repo tests today — running
 * the same index twice yields identical counts, proving the per-file scope
 * delete actually replaces rather than accumulates.
 *
 * This builds `FalkorGraphStore` directly from `openTestGraph`'s harness
 * connection, not via `openCpgStore` — deliberately: `openCpgStore` refuses
 * port 6381 by design (`assertNotTestHarness`), which is the guard working,
 * not something to route around.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { defineCpgConfig } from "../../src/config/workspace-config.ts";
import { indexWorkspace } from "../../src/indexer/index-workspace.ts";
import { WebTreeSitterBackend } from "../../src/parser/web-tree-sitter-backend.ts";
import { FalkorGraphStore } from "../../src/store/falkordb-store.ts";
import { openTestGraph, type TestGraph } from "../support/falkordb.ts";
import { assertGraphInvariants, checkGraphInvariants } from "../support/invariants.ts";
import { assertSchemaConformance } from "../support/schema-conformance.ts";
import { makeTmpWorkspace, type TmpWorkspace } from "../support/tmp-workspace.ts";

const backend = new WebTreeSitterBackend();
afterAll(() => backend.dispose());

const open: TestGraph[] = [];
let workspace: TmpWorkspace | undefined;

afterEach(async () => {
  await Promise.all(open.splice(0).map((g) => g.close()));
  await workspace?.dispose();
  workspace = undefined;
});

async function graph(label: string): Promise<TestGraph> {
  const g = await openTestGraph(label);
  open.push(g);
  return g;
}

function makeStore(g: TestGraph): FalkorGraphStore {
  return new FalkorGraphStore({
    graph: g.falkor.graph,
    admin: g.falkor.admin,
    close: () => Promise.resolve(),
  });
}

describe("indexWorkspace — live FalkorDB", () => {
  test("indexes a small workspace: MODULE count matches walked files, every METHOD has an inbound DECLARES", async () => {
    workspace = await makeTmpWorkspace({
      "a.ts": "export function greet(): string {\n  return 'hi';\n}\n",
      "b.ts": "export class Greeter {\n  greet(): string {\n    return 'hi';\n  }\n}\n",
      "c.py": "def greet():\n    return 'hi'\n",
    });

    const g = await graph("indexer small workspace");
    const store = makeStore(g);
    await store.bootstrap();

    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const report = await indexWorkspace(config, { store, backend });

    expect(report.filesIndexed).toBe(3);
    expect(report.warnings).toEqual([]);

    const moduleCount = await g.falkor.graph.scalar("MATCH (m:MODULE) RETURN count(m) AS n");
    expect(moduleCount).toBe(3);

    const undeclaredMethods = await g.falkor.graph.scalar(
      "MATCH (m:METHOD) WHERE NOT (m)<-[:DECLARES]-() RETURN count(m) AS n",
    );
    expect(undeclaredMethods).toBe(0);

    const fileCount = await g.falkor.graph.scalar("MATCH (f:FILE) RETURN count(f) AS n");
    expect(fileCount).toBe(3);

    await assertGraphInvariants(g.falkor.graph);
    await assertSchemaConformance(g.falkor.graph, { requireIndexes: true });
  });

  test("indexes a small workspace: every FILE has an inbound HAS_ENTRY, the tree is fully reachable from the root", async () => {
    workspace = await makeTmpWorkspace({
      "a.ts": "export function greet(): string {\n  return 'hi';\n}\n",
      "nested/b.py": "def greet():\n    return 'hi'\n",
      "README.md": "# not source\n",
    });

    const g = await graph("indexer filesystem tier");
    const store = makeStore(g);
    await store.bootstrap();

    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const report = await indexWorkspace(config, { store, backend });

    expect(report.filesIndexed).toBe(3);
    expect(report.directoriesWritten).toBe(2); // "." and "nested"

    const fileCount = await g.falkor.graph.scalar("MATCH (f:FILE) RETURN count(f) AS n");
    expect(fileCount).toBe(3);

    const orphanFiles = await g.falkor.graph.scalar(
      "MATCH (f:FILE) WHERE NOT ()-[:HAS_ENTRY]->(f) RETURN count(f) AS n",
    );
    expect(orphanFiles).toBe(0);

    const orphanDirs = await g.falkor.graph.scalar(
      "MATCH (d:DIRECTORY) WHERE d.path <> '.' AND NOT ()-[:HAS_ENTRY]->(d) RETURN count(d) AS n",
    );
    expect(orphanDirs).toBe(0);

    const reachable = await g.falkor.graph.scalar(
      "MATCH (:DIRECTORY {path: '.'})-[:HAS_ENTRY*]->(n) RETURN count(DISTINCT n) AS n",
    );
    const nonRootNodes = await g.falkor.graph.scalar(
      "MATCH (n) WHERE n:FILE OR (n:DIRECTORY AND n.path <> '.') RETURN count(n) AS n",
    );
    expect(reachable).toBe(nonRootNodes);

    const readmeRow = await g.falkor.graph.read<{ language: string }>(
      "MATCH (f:FILE {path: 'README.md'}) RETURN f.language AS language",
    );
    expect(readmeRow.data[0]?.language).toBe("none");

    await assertGraphInvariants(g.falkor.graph);
    await assertSchemaConformance(g.falkor.graph, { requireIndexes: true });
  });

  test("moving a file (deleteFile + rebuild) never leaves an orphan or a duplicate", async () => {
    workspace = await makeTmpWorkspace({
      "src/a.ts": "export function greet(): string {\n  return 'hi';\n}\n",
    });

    const g = await graph("indexer filesystem move");
    const store = makeStore(g);
    await store.bootstrap();

    const config = defineCpgConfig({ root: workspace.root, env: {} });
    await indexWorkspace(config, { store, backend });

    await store.writeFilesystem({
      directories: [{ path: "lib", name: "lib", parent: "." }],
      moves: [
        { fromPath: "src/a.ts", toPath: "lib/a.ts", toName: "a.ts", toParent: "lib", kind: "file" },
      ],
    });

    const moved = await g.falkor.graph.scalar(
      "MATCH (d:DIRECTORY {path: 'lib'})-[:HAS_ENTRY]->(f:FILE {path: 'lib/a.ts'}) RETURN count(f) AS n",
    );
    expect(moved).toBe(1);
    const oldPathGone = await g.falkor.graph.scalar(
      "MATCH (f:FILE {path: 'src/a.ts'}) RETURN count(f) AS n",
    );
    expect(oldPathGone).toBe(0);
    const totalFiles = await g.falkor.graph.scalar("MATCH (f:FILE) RETURN count(f) AS n");
    expect(totalFiles).toBe(1); // moved in place, never duplicated

    // KNOWN GAP (M0.7/M0.9 mint SYMBOLs; SYMBOL garbage collection on
    // delete/move is not yet built — that is M1.2's "zero orphan SYMBOLs
    // among touched fqns" gate, for the incremental/watcher-driven replace
    // path, which does not exist yet). `writeFilesystem`'s move handler only
    // moves the FILE/DIRECTORY tier; the OLD path's :CPG nodes (whose ids
    // are path-prefixed) are removed with nothing to re-extract at the new
    // path in this test, so `greet`'s own DEFINES-owned SYMBOL is correctly
    // left with zero inbound edges. Assert that SPECIFIC, understood gap by
    // name — via the non-throwing `checkGraphInvariants` — rather than
    // silently accepting it or weakening the shared assertion every other
    // integration test still holds to zero orphans.
    const result = await checkGraphInvariants(g.falkor.graph);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["1 orphan SYMBOL(s) globally: `src/a.ts`/greet()."]);
    await assertSchemaConformance(g.falkor.graph, { requireIndexes: true });
  });

  test("re-running the same index yields identical counts — the per-file replace actually replaces", async () => {
    workspace = await makeTmpWorkspace({
      "a.ts": "export function greet(): string {\n  return 'hi';\n}\n",
      "b.py": "def greet():\n    return 'hi'\n",
    });

    const g = await graph("indexer re-run idempotent");
    const store = makeStore(g);
    await store.bootstrap();

    const config = defineCpgConfig({ root: workspace.root, env: {} });

    const first = await indexWorkspace(config, { store, backend });
    const countsAfterFirst = await g.falkor.graph.scalar("MATCH (n:CPG) RETURN count(n) AS n");
    const filesAfterFirst = await g.falkor.graph.scalar("MATCH (f:FILE) RETURN count(f) AS n");

    const second = await indexWorkspace(config, { store, backend });
    const countsAfterSecond = await g.falkor.graph.scalar("MATCH (n:CPG) RETURN count(n) AS n");
    const filesAfterSecond = await g.falkor.graph.scalar("MATCH (f:FILE) RETURN count(f) AS n");

    expect(second.nodesWritten).toBe(first.nodesWritten);
    expect(countsAfterSecond).toBe(countsAfterFirst);
    expect(filesAfterSecond).toBe(filesAfterFirst);

    await assertGraphInvariants(g.falkor.graph);
    await assertSchemaConformance(g.falkor.graph, { requireIndexes: true });
  });
});
