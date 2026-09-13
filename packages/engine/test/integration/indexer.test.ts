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
import { assertGraphInvariants } from "../support/invariants.ts";
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
