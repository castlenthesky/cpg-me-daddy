/** Command dispatch and the usage-error exit code contract. */
import { describe, expect, test } from "bun:test";

import { captureIo } from "../../src/io.ts";
import { run } from "../../src/run.ts";

describe("run", () => {
  test("--help / no command prints usage and exits 0", async () => {
    const io = captureIo();
    expect(await run([], io)).toBe(0);
    expect(io.stdout.join("\n")).toContain("cpg — Code Property Graph CLI");

    const io2 = captureIo();
    expect(await run(["--help"], io2)).toBe(0);
    expect(io2.stdout.join("\n")).toContain("Usage:");
  });

  test("--version prints the banner and exits 0", async () => {
    const io = captureIo();
    expect(await run(["--version"], io)).toBe(0);
    expect(io.stdout.join("\n")).toContain("@cpg/cli@");
  });

  test("an unknown command exits 2 with usage on stderr", async () => {
    const io = captureIo();
    expect(await run(["frobnicate"], io)).toBe(2);
    expect(io.stderr.join("\n")).toContain('unknown command "frobnicate"');
  });

  test("an unknown flag to a known command exits 2, not a thrown error", async () => {
    const io = captureIo();
    expect(await run(["index", "--nope"], io)).toBe(2);
    expect(io.stderr.length).toBeGreaterThan(0);
  });

  test("query with no cypher argument exits 2", async () => {
    const io = captureIo();
    expect(await run(["query"], io)).toBe(2);
    expect(io.stderr.join("\n")).toContain("exactly one <cypher>");
  });

  test("watch dispatches — a malformed --port is a usage error, not a DB connection attempt", async () => {
    const io = captureIo();
    expect(await run(["watch", "--port", "nope"], io)).toBe(2);
    expect(io.stderr.join("\n")).toContain("--port must be an integer");
  });
});
