/**
 * `attachSourceFile` — the bridge between the filesystem tier and the
 * per-file `:CPG` tier. DB-free: a hand-built `GraphDelta` and `FsFileRow`,
 * no parser, no store.
 */
import { describe, expect, test } from "bun:test";

import { attachSourceFile } from "../../../src/indexer/source-file.ts";
import type { GraphDelta, NodeRow } from "../../../src/schema/validate.ts";
import { assertGraphDeltaValid } from "../../../src/schema/validate.ts";
import type { FsFileRow } from "../../../src/store/cypher.ts";

function moduleRow(id: string, file: string): NodeRow {
  return {
    labels: ["CPG", "MODULE"],
    properties: { id, name: "m", file, range: "1:0-1:0", status: "ready" },
  };
}

function fileRow(path: string): FsFileRow {
  return {
    path,
    name: path,
    parent: ".",
    language: "typescript",
    content_hash: "deadbeef",
    status: "ready",
    version: 1,
    indexed_at: "2026-09-13T00:00:00.000Z",
    loc: 3,
  };
}

describe("attachSourceFile", () => {
  test("appends a FILE row and a SOURCE_FILE edge from the delta's MODULE", () => {
    const delta: GraphDelta = {
      file: "a.ts",
      nodes: [moduleRow("a.ts:MODULE:a", "a.ts")],
      edges: [],
    };

    const { delta: bridged, attached } = attachSourceFile(delta, fileRow("a.ts"));

    expect(attached).toBe(true);
    expect(bridged.nodes).toHaveLength(2);
    const fileNode = bridged.nodes.find((n) => n.labels.includes("FILE"));
    expect(fileNode?.labels).toEqual(["FILE"]);
    expect(fileNode?.properties["path"]).toBe("a.ts");
    expect(fileNode?.properties["content_hash"]).toBe("deadbeef");

    expect(bridged.edges).toHaveLength(1);
    const edge = bridged.edges[0]!;
    expect(edge.type).toBe("SOURCE_FILE");
    expect(edge.fromLabel).toBe("MODULE");
    expect(edge.toLabel).toBe("FILE");
    expect(edge.fromKey).toBe("a.ts:MODULE:a");
    expect(edge.toKey).toBe("a.ts");
  });

  test("the bridged delta passes assertGraphDeltaValid", () => {
    const delta: GraphDelta = {
      file: "a.ts",
      nodes: [moduleRow("a.ts:MODULE:a", "a.ts")],
      edges: [],
    };
    const { delta: bridged } = attachSourceFile(delta, fileRow("a.ts"));
    expect(() => assertGraphDeltaValid(bridged)).not.toThrow();
  });

  test("leaves nodes/edges untouched (attached: false) when the delta has no MODULE root", () => {
    const delta: GraphDelta = { file: "a.ts", nodes: [], edges: [] };
    const { delta: bridged, attached } = attachSourceFile(delta, fileRow("a.ts"));

    expect(attached).toBe(false);
    expect(bridged).toEqual(delta);
  });

  test("original delta's node/edge arrays are not mutated", () => {
    const nodes = [moduleRow("a.ts:MODULE:a", "a.ts")];
    const edges: GraphDelta["edges"] = [];
    const delta: GraphDelta = { file: "a.ts", nodes, edges };

    attachSourceFile(delta, fileRow("a.ts"));

    expect(nodes).toHaveLength(1);
    expect(edges).toHaveLength(0);
  });
});
