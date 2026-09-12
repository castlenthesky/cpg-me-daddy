import { describe, expect, test } from "bun:test";
/**
 * Freshness gate for `50-schema.md`'s generated region (M0.0). If someone
 * hand-edits the divergence/rejection tables, or the schema module changes
 * without regenerating them, this fails `test:schema` — "generated from the
 * schema, not maintained twice" becomes an enforced property, not an
 * intention.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SPEC_PATH, withGeneratedSection } from "../../../../../tools/schema-doc.ts";

function repoRoot(): string {
  // packages/engine/test/unit/schema -> repo root is five levels up.
  return join(__dirname, "../../../../..");
}

describe("50-schema.md's generated region", () => {
  test("is exactly what tools/schema-doc.ts would (re)generate", () => {
    const path = join(repoRoot(), SPEC_PATH);
    const existing = readFileSync(path, "utf8");
    const expected = withGeneratedSection(existing);
    expect(existing).toBe(expected);
  });
});
