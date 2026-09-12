import { describe, expect, test } from "bun:test";

import { ENGINE_VERSION, SCHEMA_VERSION, engineIdentity } from "../../src/index.ts";

describe("engineIdentity", () => {
  test("reports the package and schema version", () => {
    expect(engineIdentity()).toBe(`@cpg/engine@${ENGINE_VERSION} (schema v${SCHEMA_VERSION})`);
  });

  test("pins the schema version the goldens are generated against", () => {
    expect(SCHEMA_VERSION).toBe(0);
  });
});
