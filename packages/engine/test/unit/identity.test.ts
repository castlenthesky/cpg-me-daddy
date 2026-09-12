import { describe, expect, test } from "bun:test";

import { CPG_SCHEMA, ENGINE_VERSION, SCHEMA_VERSION, engineIdentity } from "../../src/index.ts";

describe("engineIdentity", () => {
  test("reports the package and schema version", () => {
    expect(engineIdentity()).toBe(`@cpg/engine@${ENGINE_VERSION} (schema v${SCHEMA_VERSION})`);
  });

  // Bumped 0 -> 1 in M0.0: the v1 schema (research/R6-ontology-debate-synthesis.md,
  // visionary sign-off 2026-09-11) now exists. Bumped here, not in M0.4, so a
  // schema-version change never lands inside a store PR.
  test("pins the schema version the goldens are generated against", () => {
    expect(SCHEMA_VERSION).toBe(2);
  });

  test("is sourced from CPG_SCHEMA.version, not a second number", () => {
    expect(SCHEMA_VERSION).toBe(CPG_SCHEMA.version);
  });
});
