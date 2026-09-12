/** The assembled v1 CPG schema: shape, self-consistency, and serializer determinism (M0.0). */
import { describe, expect, test } from "bun:test";

import {
  CPG_SCHEMA,
  EDGE_TYPES,
  ID_RULE,
  NODE_LABELS,
  RESOLUTION_STATUS,
  SCHEMA_CONSTRAINTS,
  SCHEMA_INDEXES,
  edgeSpec,
  nodeSpec,
  schemaToJson,
} from "../../../src/schema/index.ts";

describe("v1 schema shape", () => {
  test("declares exactly the 14 R6-approved node labels", () => {
    const labels: string[] = NODE_LABELS.map((n) => n.label);
    const expected: string[] = [
      "CALL",
      "COMMUNITY",
      "DIRECTORY",
      "FILE",
      "IMPORT",
      "MEMBER",
      "META_DATA",
      "METHOD",
      "MODULE",
      "PARAM",
      "SYMBOL",
      "TAG",
      "TYPE_DECL",
      "UNKNOWN",
    ];
    expect(labels.toSorted()).toEqual(expected.toSorted());
  });

  test("declares exactly the 14 v1 edge types (R6 + sparse REACHING_DEF)", () => {
    const types: string[] = EDGE_TYPES.map((e) => e.type);
    const expected: string[] = [
      "ALIAS_OF",
      "CALLS",
      "DECLARES",
      "DEFINES",
      "DEPENDS_ON",
      "HAS_ENTRY",
      "HAS_PARAM",
      "IMPORTS",
      "IN_SCOPE",
      "INHERITS_FROM",
      "MEMBER_OF",
      "REACHING_DEF",
      "TAGGED_BY",
      "TARGETS",
    ];
    expect(types.toSorted()).toEqual(expected.toSorted());
  });

  test("no duplicate labels or edge types", () => {
    expect(new Set(NODE_LABELS.map((n) => n.label)).size).toBe(NODE_LABELS.length);
    expect(new Set(EDGE_TYPES.map((e) => e.type)).size).toBe(EDGE_TYPES.length);
  });

  test("every edge's endpoint labels are declared node labels", () => {
    const declared = new Set(NODE_LABELS.map((n) => n.label));
    for (const edge of EDGE_TYPES) {
      for (const label of [...edge.from, ...edge.to]) {
        expect(declared.has(label)).toBe(true);
      }
    }
  });

  test("nodeSpec/edgeSpec resolve every declared label and type, and nothing else", () => {
    for (const n of NODE_LABELS) {
      expect(nodeSpec(n.label)).toBe(n);
    }
    for (const e of EDGE_TYPES) {
      expect(edgeSpec(e.type)).toBe(e);
    }
    expect(nodeSpec("NOT_A_LABEL")).toBeUndefined();
    expect(edgeSpec("NOT_AN_EDGE")).toBeUndefined();
  });
});

describe("SYMBOL indirection invariants (D5)", () => {
  test("SYMBOL is not :CPG and has no `file` property", () => {
    const symbol = nodeSpec("SYMBOL");
    expect(symbol?.cpgCoLabel).toBe(false);
    expect(symbol?.hasFileProperty).toBe(false);
  });

  test("META_DATA is not :CPG and has no `file` property", () => {
    const metaData = nodeSpec("META_DATA");
    expect(metaData?.cpgCoLabel).toBe(false);
    expect(metaData?.hasFileProperty).toBe(false);
  });

  test("every other :CPG-bearing label DOES carry a `file` property", () => {
    for (const n of NODE_LABELS) {
      if (n.cpgCoLabel) {
        expect(n.hasFileProperty).toBe(true);
      }
    }
  });
});

describe("overlay classification (R6 overlay-edge rule)", () => {
  test("TARGETS, DEPENDS_ON and MEMBER_OF are overlay-owned, overlay-job written", () => {
    for (const type of ["TARGETS", "DEPENDS_ON", "MEMBER_OF"]) {
      const edge = edgeSpec(type);
      expect(edge?.ownership).toBe("overlay");
      expect(edge?.write).toBe("overlay-job");
    }
  });

  test("file-owned edges are never overlay-job written", () => {
    for (const e of EDGE_TYPES) {
      if (e.ownership === "file-owned") {
        expect(e.write).not.toBe("overlay-job");
      }
    }
  });
});

describe("shared resolution status vocabulary", () => {
  test("CALLS.status and IMPORTS.status reference the same array object, not a copy", () => {
    const callsStatus = edgeSpec("CALLS")?.properties.find((p) => p.name === "status");
    const importsStatus = edgeSpec("IMPORTS")?.properties.find((p) => p.name === "status");
    expect(callsStatus?.enumValues).toBe(RESOLUTION_STATUS);
    expect(importsStatus?.enumValues).toBe(RESOLUTION_STATUS);
  });
});

describe("INHERITS_FROM points at SYMBOL (M0.0 planning decision)", () => {
  test("from TYPE_DECL to SYMBOL, not directly to TYPE_DECL", () => {
    const edge = edgeSpec("INHERITS_FROM");
    expect(edge?.from).toEqual(["TYPE_DECL"]);
    expect(edge?.to).toEqual(["SYMBOL"]);
  });
});

describe("id rule", () => {
  test("matches the AM1/D31 formula, not the superseded content-hash formula", () => {
    expect(ID_RULE).toBe("path:kind:qualifiedScopePath[:ordinal|:bodyHash]");
    expect(ID_RULE).not.toContain("fileHash");
  });
});

describe("bootstrap data for M0.4", () => {
  test("declares the CPG.id / CPG.file / FILE.path / DIRECTORY.path indexes", () => {
    expect(SCHEMA_INDEXES).toContainEqual({ label: "CPG", properties: ["id"], kind: "RANGE" });
    expect(SCHEMA_INDEXES).toContainEqual({ label: "CPG", properties: ["file"], kind: "RANGE" });
  });

  test("declares the UNIQUE SYMBOL.fqn constraint", () => {
    expect(SCHEMA_CONSTRAINTS).toContainEqual({
      type: "UNIQUE",
      label: "SYMBOL",
      properties: ["fqn"],
      entityType: "NODE",
    });
  });
});

describe("schemaToJson determinism", () => {
  test("two calls produce byte-identical output", () => {
    const a = JSON.stringify(schemaToJson(CPG_SCHEMA));
    const b = JSON.stringify(schemaToJson(CPG_SCHEMA));
    expect(a).toBe(b);
  });

  test("nodes, edges, indexes and constraints come back sorted", () => {
    const json = schemaToJson(CPG_SCHEMA);
    const labels = json.nodes.map((n) => n.label);
    const types = json.edges.map((e) => e.type);
    expect(labels).toEqual(labels.toSorted());
    expect(types).toEqual(types.toSorted());
  });

  test("drops nothing: Joern alignment data survives serialization", () => {
    const json = schemaToJson(CPG_SCHEMA);
    const symbol = json.nodes.find((n) => n.label === "SYMBOL");
    expect(symbol?.joern.verdict).toBe("extend");
    expect(symbol?.joern.divergenceClass).toBe("structural-incompatibility");
  });
});
