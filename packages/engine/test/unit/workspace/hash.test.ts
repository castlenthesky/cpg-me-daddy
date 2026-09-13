import { afterEach, describe, expect, test } from "bun:test";
/** SHA-256 content hashing (M0.2): known vectors, stability, and byte- vs text-sensitivity. */
import { createHash } from "node:crypto";

import { collectFileRecords, hashBytes, loadFile } from "../../../src/workspace/hash.ts";
import { walkWorkspace } from "../../../src/workspace/walker.ts";
import { makeTmpWorkspace, type TmpWorkspace } from "../../support/tmp-workspace.ts";

let workspace: TmpWorkspace | undefined;

afterEach(async () => {
  await workspace?.dispose();
  workspace = undefined;
});

describe("hashBytes", () => {
  test("matches node:crypto's own SHA-256 for known inputs", () => {
    expect(hashBytes(new TextEncoder().encode(""))).toBe(
      createHash("sha256").update("").digest("hex"),
    );
    expect(hashBytes(new TextEncoder().encode("hello"))).toBe(
      createHash("sha256").update("hello").digest("hex"),
    );
    // The well-known vector for the empty string, so a future refactor that
    // breaks the node:crypto comparison too still has a fixed point to check.
    expect(hashBytes(new TextEncoder().encode(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("is 64 lowercase hex characters", () => {
    const digest = hashBytes(new TextEncoder().encode("anything"));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("loadFile", () => {
  test("hashes the raw bytes, so CRLF and LF differ even though the decoded text differs by one character class", async () => {
    workspace = await makeTmpWorkspace({
      "lf.py": "x = 1\ny = 2\n",
      "crlf.py": "x = 1\r\ny = 2\r\n",
    });
    const { files } = await walkWorkspace({ root: workspace.root });
    const lf = await loadFile(files.find((f) => f.path === "lf.py")!);
    const crlf = await loadFile(files.find((f) => f.path === "crlf.py")!);

    expect(lf.record.contentHash).not.toBe(crlf.record.contentHash);
  });

  test("is stable across two reads of the same unchanged file", async () => {
    workspace = await makeTmpWorkspace({ "a.ts": "export const a = 1;\n" });
    const { files } = await walkWorkspace({ root: workspace.root });
    const entry = files[0]!;

    const first = await loadFile(entry);
    const second = await loadFile(entry);

    expect(first.record.contentHash).toBe(second.record.contentHash);
  });

  test("a one-byte change flips the hash", async () => {
    workspace = await makeTmpWorkspace({ "a.ts": "export const a = 1;\n" });
    const { files } = await walkWorkspace({ root: workspace.root });
    const before = await loadFile(files[0]!);

    const { writeFile } = await import("node:fs/promises");
    await writeFile(files[0]!.absolutePath, "export const a = 2;\n");
    const after = await loadFile(files[0]!);

    expect(after.record.contentHash).not.toBe(before.record.contentHash);
  });

  test("counts lines, and text is the decoded UTF-8 source", async () => {
    workspace = await makeTmpWorkspace({ "a.ts": "one\ntwo\nthree" });
    const { files } = await walkWorkspace({ root: workspace.root });
    const loaded = await loadFile(files[0]!);

    expect(loaded.record.loc).toBe(3);
    expect(loaded.text).toBe("one\ntwo\nthree");
  });
});

describe("collectFileRecords", () => {
  test("walks and hashes in one call, honouring the same excludes as walkWorkspace", async () => {
    workspace = await makeTmpWorkspace({
      "a.ts": "export const a = 1;\n",
      "node_modules/pkg/index.ts": "SHOULD_NEVER_APPEAR",
    });

    const records = await collectFileRecords({ root: workspace.root });

    expect(records.map((r) => r.path)).toEqual(["a.ts"]);
    expect(records[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
