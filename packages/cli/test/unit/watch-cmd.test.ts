/**
 * `cpg watch` argument parsing and usage/exit codes — DB-free by design
 * (`test:unit` never connects). Anything that needs a real store connection
 * is `packages/engine/test/integration`'s job, not this file's.
 */
import { describe, expect, test } from "bun:test";

import { runWatch } from "../../src/commands/watch-cmd.ts";
import { captureIo } from "../../src/io.ts";

describe("cpg watch — usage errors (no DB connection attempted)", () => {
  test("an unknown flag exits 2", async () => {
    const io = captureIo();
    const code = await runWatch(["--nope"], io);
    expect(code).toBe(2);
    expect(io.stderr.length).toBeGreaterThan(0);
  });

  test("a malformed --port exits 2", async () => {
    const io = captureIo();
    const code = await runWatch(["--port", "nope"], io);
    expect(code).toBe(2);
    expect(io.stderr.join("\n")).toContain("--port must be an integer");
  });

  test("--skip-initial-index and --json parse without a usage error", async () => {
    // Parsing succeeds; runWatch then tries to open a store and fails fast
    // (no DB running for this unit test) — exit 1, not 2, is the point here.
    const io = captureIo();
    const code = await runWatch(
      ["--workspace", "/nonexistent", "--skip-initial-index", "--json", "--port", "1"],
      io,
    );
    expect(code).toBe(1);
  });
});
