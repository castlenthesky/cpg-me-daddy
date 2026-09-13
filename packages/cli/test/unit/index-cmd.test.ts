import { afterEach, describe, expect, test } from "bun:test";
/** `cpg index --dry-run` is the whole point: assertable without a database. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureIo } from "../../src/io.ts";
import { run } from "../../src/run.ts";

let workspace: string | undefined;
afterEach(async () => {
  if (workspace !== undefined) {
    await rm(workspace, { recursive: true, force: true });
    workspace = undefined;
  }
});

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cpg-cli-index-test-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "a.ts"), "export function greet(): string {\n  return 'hi';\n}\n");
  await writeFile(join(root, "b.py"), "def greet():\n    return 'hi'\n");
  return root;
}

describe("cpg index --dry-run", () => {
  test("indexes without touching a database and reports file counts", async () => {
    workspace = await makeWorkspace();
    const io = captureIo();

    const code = await run(["index", "--workspace", workspace, "--dry-run"], io);

    expect(code).toBe(0);
    const output = io.stdout.join("\n");
    expect(output).toContain("indexed 2 file(s)");
    expect(output).toContain("--dry-run: nothing was written");
    expect(io.stderr).toEqual([]);
  });

  test("--json prints a parseable report with no database connection attempted", async () => {
    workspace = await makeWorkspace();
    const io = captureIo();

    const code = await run(["index", "--workspace", workspace, "--dry-run", "--json"], io);

    expect(code).toBe(0);
    const report = JSON.parse(io.stdout.join("\n"));
    expect(report.filesIndexed).toBe(2);
    expect(report.cancelled).toBe(false);
  });

  test("a malformed --port is a usage error, not a crash", async () => {
    workspace = await makeWorkspace();
    const io = captureIo();

    const code = await run(["index", "--workspace", workspace, "--port", "nope"], io);

    expect(code).toBe(2);
    expect(io.stderr.join("\n")).toContain("--port must be an integer");
  });
});
