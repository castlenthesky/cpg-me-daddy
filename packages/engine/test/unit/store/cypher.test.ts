/**
 * DB-free half of M0.4b's gate: `planDelta` exercised against hand-built
 * `GraphDelta` shapes, asserting the exact Cypher strings and grouping
 * strategy it must produce — no client, no live server. The live half
 * (EXPLAIN really shows an index scan, a duplicate-endpoint-label mistake
 * really plans as a label scan, cross-file CALLS really survive a rewrite)
 * is `test/integration/store-writer.test.ts`.
 */
import { describe, expect, test } from "bun:test";

import { NODE_LABELS } from "../../../src/schema/nodes.ts";
import type { EdgeRow, GraphDelta, NodeRow } from "../../../src/schema/validate.ts";
import { planDelta, planFilesystem } from "../../../src/store/cypher.ts";
import type { FsDirectoryRow, FsFileRow, FsMove, FsRemoval } from "../../../src/store/cypher.ts";

function node(labels: string[], properties: Record<string, unknown>): NodeRow {
  return { labels, properties };
}

function edge(
  type: string,
  fromLabel: string,
  toLabel: string,
  fromKey: string | undefined,
  toKey: string | undefined,
  properties: Record<string, unknown> = {},
): EdgeRow {
  return { type, fromLabel, toLabel, fromKey, toKey, properties };
}

describe("planDelta — scope delete", () => {
  test("emits a scope delete first when delta.file is set, never DETACH DELETE", () => {
    const delta: GraphDelta = { file: "src/a.ts", nodes: [], edges: [] };
    const ops = planDelta(delta);
    expect(ops[0]).toEqual({
      kind: "scope-delete",
      group: "scope-delete",
      cypher: "MATCH (n:CPG {file: $file}) DELETE n",
      params: { file: "src/a.ts" },
    });
    expect(ops.some((op) => op.cypher.includes("DETACH"))).toBe(false);
  });

  test("emits no scope delete when delta.file is undefined", () => {
    const delta: GraphDelta = { nodes: [], edges: [] };
    const ops = planDelta(delta);
    expect(ops.some((op) => op.kind === "scope-delete")).toBe(false);
  });
});

describe("planDelta — nodes", () => {
  test("delete-create: groups by kind, CREATE with the :CPG co-label, rows are bare properties", () => {
    const rows = [
      node(["CPG", "METHOD"], { id: "m1", name: "foo" }),
      node(["CPG", "METHOD"], { id: "m2", name: "bar" }),
    ];
    const delta: GraphDelta = { nodes: rows, edges: [] };
    const ops = planDelta(delta).filter((op) => op.kind === "node-create");
    expect(ops).toHaveLength(1);
    expect(ops[0]!.group).toBe("METHOD");
    expect(ops[0]!.cypher).toBe("UNWIND $rows AS row CREATE (n:CPG:METHOD) SET n = row");
    expect(ops[0]!.params).toEqual({ rows: [rows[0]!.properties, rows[1]!.properties] });
  });

  test("merge-on-key: MERGEs on the label's own key, prunes null/undefined and the key itself from the SET map", () => {
    const rows = [
      node(["SYMBOL"], {
        fqn: "src/a.ts#alpha",
        kind: "function",
        scheme: null,
        manager: undefined,
      }),
    ];
    const delta: GraphDelta = { nodes: rows, edges: [] };
    const ops = planDelta(delta).filter((op) => op.kind === "node-merge");
    expect(ops).toHaveLength(1);
    expect(ops[0]!.cypher).toBe(
      "UNWIND $rows AS row MERGE (n:SYMBOL {fqn: row.key}) SET n += row.props",
    );
    expect(ops[0]!.params).toEqual({
      rows: [{ key: "src/a.ts#alpha", props: { kind: "function" } }],
    });
  });

  test("caps at <= 14 groups regardless of row count — every writable label represented", () => {
    // Every label this writer can legally handle (delete-create or
    // merge-on-key with a real key) — excludes COMMUNITY (overlay-job) and
    // META_DATA (no key property), both out of this writer's scope.
    const writable = NODE_LABELS.filter((s) => s.write !== "overlay-job" && s.key.length > 0).map(
      (s) => s.label,
    );
    expect(writable.length).toBeLessThanOrEqual(14);

    const rows: NodeRow[] = writable.map((label) => {
      const spec = NODE_LABELS.find((s) => s.label === label)!;
      const labels = spec.cpgCoLabel ? ["CPG", label] : [label];
      const key = spec.key[0];
      const properties: Record<string, unknown> = key ? { [key]: `${label}-key` } : {};
      if (spec.cpgCoLabel) {
        properties.id = `${label}-key`;
      }
      return node(labels, properties);
    });
    const ops = planDelta({ nodes: rows, edges: [] });
    const groups = new Set(ops.map((op) => op.group));
    expect(groups.size).toBeLessThanOrEqual(14);
    expect(groups.size).toBe(writable.length);
  });

  test("throws for an out-of-scope write mechanism (COMMUNITY, overlay-job)", () => {
    const delta: GraphDelta = { nodes: [node(["COMMUNITY"], { id: "c1" })], edges: [] };
    expect(() => planDelta(delta)).toThrow(/overlay-job/);
  });

  test("throws for an undeclared node label", () => {
    const delta: GraphDelta = { nodes: [node(["BOGUS"], {})], edges: [] };
    expect(() => planDelta(delta)).toThrow(/not a declared v1 schema node label/);
  });

  test("throws for a node row with no non-CPG label", () => {
    const delta: GraphDelta = { nodes: [node(["CPG"], { id: "x" })], edges: [] };
    expect(() => planDelta(delta)).toThrow(/carries no non-CPG label/);
  });

  test("chunks at the configured batch size, not the op list", () => {
    const rows = Array.from({ length: 5 }, (_, i) => node(["CPG", "METHOD"], { id: `m${i}` }));
    const ops = planDelta({ nodes: rows, edges: [] }, { batchSize: 2 });
    expect(ops).toHaveLength(3);
    expect((ops[0]!.params.rows as unknown[]).length).toBe(2);
    expect((ops[1]!.params.rows as unknown[]).length).toBe(2);
    expect((ops[2]!.params.rows as unknown[]).length).toBe(1);
    const allRows = ops.flatMap((op) => op.params.rows as { id: string }[]);
    const expectedIds = rows.map((r) => r.properties.id as string);
    expect(allRows.map((r) => r.id).toSorted()).toEqual(expectedIds.toSorted());
  });
});

describe("planDelta — edges", () => {
  test("collapses a multi-source-label edge type into one group when all sources are :CPG", () => {
    // DEFINES: from = MODULE|TYPE_DECL|METHOD|MEMBER|PARAM, all :CPG-co-labelled.
    const rows = [
      edge("DEFINES", "MODULE", "SYMBOL", "module:a", "a#x"),
      edge("DEFINES", "METHOD", "SYMBOL", "method:a.f", "a#f"),
      edge("DEFINES", "PARAM", "SYMBOL", "param:a.f.p", "a#f.p"),
    ];
    const ops = planDelta({ nodes: [], edges: rows }).filter((op) => op.kind === "edge");
    expect(ops).toHaveLength(1);
    expect(ops[0]!.group).toBe("DEFINES: CPG.id -> SYMBOL.fqn");
    expect((ops[0]!.params.rows as unknown[]).length).toBe(3);
  });

  test("matches endpoints on the indexed key, never a bare kind label", () => {
    const rows = [edge("DEFINES", "METHOD", "SYMBOL", "method:a.f", "a#f")];
    const ops = planDelta({ nodes: [], edges: rows });
    const cypher = ops[0]!.cypher;
    expect(cypher).toContain("MATCH (s:CPG {id: row.from})");
    expect(cypher).toContain("MATCH (t:SYMBOL {fqn: row.to})");
    expect(cypher).not.toContain(":METHOD {");
  });

  test("includes the WITH barrier between the two endpoint MATCHes", () => {
    const rows = [edge("DEFINES", "METHOD", "SYMBOL", "method:a.f", "a#f")];
    const ops = planDelta({ nodes: [], edges: rows });
    expect(ops[0]!.cypher).toContain("WITH s, row");
  });

  test("splits an edge type whose rows resolve to different endpoint shapes (TAGGED_BY)", () => {
    // TAGGED_BY: from = SYMBOL (not :CPG) | MEMBER | CALL (both :CPG).
    const rows = [
      edge("TAGGED_BY", "SYMBOL", "TAG", "a#alpha", "needs_triage"),
      edge("TAGGED_BY", "MEMBER", "TAG", "member:a.x", "needs_triage"),
    ];
    const ops = planDelta({ nodes: [], edges: rows }).filter((op) => op.kind === "edge");
    expect(ops).toHaveLength(2);
    expect(ops.map((op) => op.group).toSorted()).toEqual(
      ["TAGGED_BY: CPG.id -> TAG.name", "TAGGED_BY: SYMBOL.fqn -> TAG.name"].toSorted(),
    );
  });

  test("delete-create edges CREATE and overwrite properties; merge-on-key edges MERGE and preserve them", () => {
    const createRows = [edge("DEFINES", "METHOD", "SYMBOL", "method:a.f", "a#f")];
    const createOp = planDelta({ nodes: [], edges: createRows })[0]!;
    expect(createOp.cypher).toContain("CREATE (s)-[r:DEFINES]->(t)");
    expect(createOp.cypher).toContain("SET r = row.props");

    const mergeRows = [edge("ALIAS_OF", "SYMBOL", "SYMBOL", "a#alpha", "a#canonical")];
    const mergeOp = planDelta({ nodes: [], edges: mergeRows })[0]!;
    expect(mergeOp.cypher).toContain("MERGE (s)-[r:ALIAS_OF]->(t)");
    expect(mergeOp.cypher).toContain("SET r += row.props");
  });

  test("throws for an out-of-scope edge write mechanism (HAS_ENTRY, move-rename-only)", () => {
    const rows = [edge("HAS_ENTRY", "DIRECTORY", "FILE", "dir:src", "src/a.ts")];
    expect(() => planDelta({ nodes: [], edges: rows })).toThrow(/move-rename-only/);
  });

  test("throws for an undeclared edge type", () => {
    const rows = [edge("BOGUS_EDGE", "METHOD", "SYMBOL", "m1", "s1")];
    expect(() => planDelta({ nodes: [], edges: rows })).toThrow(
      /not a declared v1 schema edge type/,
    );
  });

  test("throws when an edge row is missing its endpoint key", () => {
    const rows = [edge("DEFINES", "METHOD", "SYMBOL", undefined, "a#f")];
    expect(() => planDelta({ nodes: [], edges: rows })).toThrow(/no fromKey/);
  });
});

function fsDir(path: string, parent: string | undefined): FsDirectoryRow {
  return { path, name: path === "." ? "." : path.split("/").pop()!, parent };
}

function fsFile(path: string, parent: string, language = "typescript"): FsFileRow {
  return {
    path,
    name: path.split("/").pop()!,
    parent,
    language,
    content_hash: "abc123",
    status: "ready",
    version: 1,
    indexed_at: "2026-01-01T00:00:00.000Z",
    loc: 1,
  };
}

describe("planFilesystem — directories and files", () => {
  test("MERGEs directories and files on path — never CREATE", () => {
    const ops = planFilesystem({
      directories: [fsDir(".", undefined), fsDir("src", ".")],
      files: [fsFile("src/a.ts", "src")],
    });
    const dirOp = ops.find((op) => op.kind === "fs-node-merge" && op.group === "DIRECTORY")!;
    expect(dirOp.cypher).toBe(
      "UNWIND $rows AS row MERGE (d:DIRECTORY {path: row.key}) SET d += row.props",
    );
    const fileOp = ops.find((op) => op.kind === "fs-node-merge" && op.group === "FILE")!;
    expect(fileOp.cypher).toBe(
      "UNWIND $rows AS row MERGE (f:FILE {path: row.key}) SET f += row.props",
    );
    expect(ops.some((op) => op.cypher.includes("CREATE"))).toBe(false);
  });

  test("HAS_ENTRY links carry the WITH barrier and MERGE, never CREATE", () => {
    const ops = planFilesystem({
      directories: [fsDir(".", undefined), fsDir("src", ".")],
      files: [fsFile("src/a.ts", "src")],
    });
    const dirLink = ops.find((op) => op.group === "HAS_ENTRY: DIRECTORY -> DIRECTORY")!;
    expect(dirLink.cypher).toContain("WITH p, row");
    expect(dirLink.cypher).toContain("MERGE (p)-[:HAS_ENTRY]->(c)");
    const fileLink = ops.find((op) => op.group === "HAS_ENTRY: DIRECTORY -> FILE")!;
    expect(fileLink.cypher).toContain("WITH p, row");
    expect(fileLink.cypher).toContain("MERGE (p)-[:HAS_ENTRY]->(c)");
  });

  test("the workspace root (parent undefined) is merged but never linked", () => {
    const ops = planFilesystem({ directories: [fsDir(".", undefined)] });
    expect(ops.some((op) => op.group.startsWith("HAS_ENTRY"))).toBe(false);
    expect(ops.some((op) => op.kind === "fs-node-merge")).toBe(true);
  });

  test("op order: directory merge, file merge, then their links", () => {
    const ops = planFilesystem({
      directories: [fsDir(".", undefined), fsDir("src", ".")],
      files: [fsFile("src/a.ts", "src")],
    });
    const kinds = ops.map((op) => `${op.kind}:${op.group}`);
    expect(kinds).toEqual([
      "fs-node-merge:DIRECTORY",
      "fs-node-merge:FILE",
      "fs-link:HAS_ENTRY: DIRECTORY -> DIRECTORY",
      "fs-link:HAS_ENTRY: DIRECTORY -> FILE",
    ]);
  });

  test("still batches at the given batchSize", () => {
    const files = Array.from({ length: 5 }, (_, i) => fsFile(`f${i}.ts`, "."));
    const ops = planFilesystem({ files }, { batchSize: 2 });
    const merges = ops.filter((op) => op.kind === "fs-node-merge" && op.group === "FILE");
    expect(merges).toHaveLength(3);
  });
});

describe("planFilesystem — removals", () => {
  test("a file removal clears its :CPG subgraph (plain DELETE) then DETACH DELETEs the FILE node", () => {
    const removal: FsRemoval = { path: "src/a.ts", kind: "file" };
    const ops = planFilesystem({ removals: [removal] });
    expect(ops[0]!.cypher).toBe("MATCH (n:CPG {file: $path}) DELETE n");
    expect(ops[0]!.params).toEqual({ path: "src/a.ts" });
    expect(ops[1]!.cypher).toBe("MATCH (f:FILE {path: $path}) DETACH DELETE f");
  });

  test("a directory removal deletes the whole :CPG/FILE/DIRECTORY subtree by path prefix", () => {
    const removal: FsRemoval = { path: "src", kind: "directory" };
    const ops = planFilesystem({ removals: [removal] });
    expect(ops[0]!.cypher).toBe("MATCH (n:CPG) WHERE n.file STARTS WITH $prefix DELETE n");
    expect(ops[0]!.params).toEqual({ prefix: "src/" });
    const dirOp = ops.find((op) => op.cypher.includes("DIRECTORY"))!;
    expect(dirOp.cypher).toContain("d.path = $path OR d.path STARTS WITH $prefix");
    expect(dirOp.cypher).toContain("DETACH DELETE d");
  });
});

describe("planFilesystem — moves", () => {
  test("a file move rewrites path/name in place — no CREATE, no DETACH DELETE of the FILE itself", () => {
    const move: FsMove = {
      fromPath: "src/a.ts",
      toPath: "lib/a.ts",
      toName: "a.ts",
      toParent: "lib",
      kind: "file",
    };
    const ops = planFilesystem({ moves: [move] });
    expect(ops[0]!.cypher).toBe("MATCH (n:CPG {file: $from}) DELETE n");
    const rename = ops.find((op) => op.cypher.includes("SET f.path"))!;
    expect(rename.cypher).toBe("MATCH (f:FILE {path: $from}) SET f.path = $to, f.name = $toName");
    expect(rename.params).toEqual({ from: "src/a.ts", to: "lib/a.ts", toName: "a.ts" });
    expect(ops.some((op) => op.cypher.includes("CREATE"))).toBe(false);
    expect(ops.some((op) => op.cypher.includes("FILE) DETACH DELETE"))).toBe(false);
    const relink = ops.find((op) => op.kind === "fs-link")!;
    expect(relink.cypher).toContain("MERGE (p)-[:HAS_ENTRY]->(c)");
  });

  test("a move's relink runs AFTER directory merges — moving into a brand-new directory still links", () => {
    // Regression: a move to a directory created in the very same batch (e.g.
    // `mkdir lib && mv a.ts lib/a.ts` in one debounced watch batch) must not
    // relink before that directory's own MERGE creates it.
    const move: FsMove = {
      fromPath: "a.ts",
      toPath: "lib/a.ts",
      toName: "a.ts",
      toParent: "lib",
      kind: "file",
    };
    const ops = planFilesystem({
      directories: [fsDir("lib", ".")],
      moves: [move],
    });
    const dirMergeIndex = ops.findIndex(
      (op) => op.kind === "fs-node-merge" && op.group === "DIRECTORY",
    );
    const relinkIndex = ops.findIndex((op) => op.kind === "fs-link");
    expect(dirMergeIndex).toBeGreaterThanOrEqual(0);
    expect(relinkIndex).toBeGreaterThan(dirMergeIndex);
  });

  test("a directory move rewrites every descendant's path prefix, keeps their own names", () => {
    const move: FsMove = {
      fromPath: "src",
      toPath: "lib",
      toName: "lib",
      toParent: ".",
      kind: "directory",
    };
    const ops = planFilesystem({ moves: [move] });
    const fileRewrite = ops.find((op) => op.cypher.includes("MATCH (f:FILE) WHERE"))!;
    expect(fileRewrite.cypher).toBe(
      "MATCH (f:FILE) WHERE f.path STARTS WITH $fromPrefix " +
        "SET f.path = $to + substring(f.path, size($from))",
    );
    expect(fileRewrite.params).toEqual({ fromPrefix: "src/", from: "src", to: "lib" });
    const dirRewrite = ops.find(
      (op) => op.cypher.includes("MATCH (d:DIRECTORY) WHERE") && op.cypher.includes("SET d.path"),
    )!;
    expect(dirRewrite.cypher).toContain("SET d.path = $to + substring(d.path, size($from))");
    const nameOp = ops.find(
      (op) => op.cypher === "MATCH (d:DIRECTORY {path: $to}) SET d.name = $toName",
    )!;
    expect(nameOp.params).toEqual({ to: "lib", toName: "lib" });
  });

  test("planDelta still throws on a HAS_ENTRY row — planFilesystem does not weaken that guard", () => {
    const rows = [edge("HAS_ENTRY", "DIRECTORY", "FILE", "dir:src", "src/a.ts")];
    expect(() => planDelta({ nodes: [], edges: rows })).toThrow(/move-rename-only/);
  });
});
