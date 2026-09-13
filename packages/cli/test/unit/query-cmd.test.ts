/** The table formatter as a pure function — no database needed. */
import { describe, expect, test } from "bun:test";

import { formatCell, formatTable } from "../../src/commands/query-cmd.ts";
import { captureIo } from "../../src/io.ts";
import { run } from "../../src/run.ts";

describe("formatCell", () => {
  test("renders null and undefined as an empty string", () => {
    expect(formatCell(null)).toBe("");
    expect(formatCell(undefined)).toBe("");
  });

  test("renders an object cell as JSON", () => {
    expect(formatCell({ a: 1 })).toBe('{"a":1}');
  });

  test("renders scalars via String()", () => {
    expect(formatCell(42)).toBe("42");
    expect(formatCell("x")).toBe("x");
  });
});

describe("formatTable", () => {
  test("renders (0 rows) for an empty result", () => {
    expect(formatTable([])).toBe("(0 rows)");
  });

  test("column-aligns a fixed row set, including a null and an object cell", () => {
    const table = formatTable([
      { label: "METHOD", count: 12, meta: null },
      { label: "MODULE", count: 3, meta: { extra: true } },
    ]);
    const lines = table.split("\n").map((l) => l.trimEnd());
    expect(lines[0]).toBe("label   count  meta");
    expect(lines[1]).toBe("METHOD  12");
    expect(lines[2]).toBe('MODULE  3      {"extra":true}');
    // Every line lines up on the same column start — the whole point of a table.
    expect(lines[1]!.indexOf("12")).toBe(lines[2]!.indexOf("3"));
  });
});

describe("cpg query — usage errors", () => {
  test("a malformed --port is a usage error, not a crash", async () => {
    const io = captureIo();
    const code = await run(["query", "MATCH (n) RETURN n", "--port", "nope"], io);
    expect(code).toBe(2);
    expect(io.stderr.join("\n")).toContain("--port must be an integer");
  });

  test("more than one positional argument is a usage error", async () => {
    const io = captureIo();
    const code = await run(["query", "MATCH (n) RETURN n", "extra"], io);
    expect(code).toBe(2);
  });
});
