import { describe, expect, test } from "bun:test";

import { formatRange } from "../../../src/extract/range.ts";

describe("formatRange", () => {
  test("lines are 1-based, columns are 0-based, matching tree-sitter's own Point convention", () => {
    // A single-line declaration starting at row 0 (tree-sitter convention).
    expect(formatRange({ row: 0, column: 0 }, { row: 0, column: 12 })).toBe("1:0-1:12");
  });

  test("multi-line range", () => {
    expect(formatRange({ row: 4, column: 0 }, { row: 6, column: 1 })).toBe("5:0-7:1");
  });
});
