/** The M0.2 walker: pruning, ordering, symlinks, and cross-run stability. */
import { afterEach, describe, expect, test } from "bun:test";

import { walkWorkspace } from "../../../src/workspace/walker.ts";
import { addSymlink, makeTmpWorkspace, type TmpWorkspace } from "../../support/tmp-workspace.ts";

let workspace: TmpWorkspace | undefined;

afterEach(async () => {
  await workspace?.dispose();
  workspace = undefined;
});

describe("walkWorkspace", () => {
  test("returns an exact, sorted file list, including files with no registered grammar", async () => {
    workspace = await makeTmpWorkspace({
      "b.ts": "export const b = 1;\n",
      "a.ts": "export const a = 1;\n",
      "nested/c.ts": "export const c = 1;\n",
      "README.md": "# not a source file\n",
    });

    const { files } = await walkWorkspace({ root: workspace.root });

    expect(files.map((f) => f.path)).toEqual(["README.md", "a.ts", "b.ts", "nested/c.ts"]);
  });

  test("excludes node_modules, .venv and __pycache__ without descending into them", async () => {
    workspace = await makeTmpWorkspace({
      "lib/index.ts": "export const x = 1;\n",
      "node_modules/pkg/deep/sentinel.ts": "SHOULD_NEVER_APPEAR",
      ".venv/lib/deep/sentinel.py": "SHOULD_NEVER_APPEAR",
      "__pycache__/deep/sentinel.py": "SHOULD_NEVER_APPEAR",
    });

    const { files, stats } = await walkWorkspace({ root: workspace.root });

    expect(files.map((f) => f.path)).toEqual(["lib/index.ts"]);
    expect(stats.directoriesSkipped).toBeGreaterThanOrEqual(3);
    // The "deep/sentinel" file lives 2 levels inside each excluded directory;
    // if pruning happened by filtering a full listing instead of skipping
    // the descent, it would still show up as `filesSeen`.
    expect(stats.filesSeen).toBe(1);
  });

  test("by default, a root-level src/ is indexed like any other directory", async () => {
    // No anchored `/src/**` in DEFAULT_EXCLUDES: it would silently break
    // indexing for the large fraction of real codebases that keep their
    // source directly under a top-level src/ — this fixture included.
    workspace = await makeTmpWorkspace({
      "src/legacy.ts": "export const x = 1;\n",
    });

    const { files } = await walkWorkspace({ root: workspace.root });

    expect(files.map((f) => f.path)).toEqual(["src/legacy.ts"]);
  });

  test("an explicit anchored exclude (e.g. this repo's own legacy tree) still prunes only the root copy", async () => {
    workspace = await makeTmpWorkspace({
      "src/legacy.ts": "SHOULD_BE_EXCLUDED",
      "packages/engine/src/index.ts": "export const x = 1;\n",
    });

    const { files } = await walkWorkspace({ root: workspace.root, exclude: ["/src/**"] });

    expect(files.map((f) => f.path)).toEqual(["packages/engine/src/index.ts"]);
  });

  test("files with no registered grammar are still emitted, with a null language, and counted", async () => {
    workspace = await makeTmpWorkspace({
      "a.ts": "export const a = 1;\n",
      "notes.md": "# not source\n",
      "data.json": "{}",
    });

    const { files, stats } = await walkWorkspace({ root: workspace.root });

    expect(files.map((f) => f.path)).toEqual(["a.ts", "data.json", "notes.md"]);
    expect(files.find((f) => f.path === "a.ts")?.language).toBe("typescript");
    expect(files.find((f) => f.path === "notes.md")?.language).toBeNull();
    expect(files.find((f) => f.path === "data.json")?.language).toBeNull();
    expect(stats.filesUnsupported).toBe(2);
  });

  test("symlinks are skipped by default", async () => {
    workspace = await makeTmpWorkspace({
      "real/target.ts": "export const x = 1;\n",
    });
    await addSymlink(workspace.root, "link.ts", "real/target.ts");

    const { files, stats } = await walkWorkspace({ root: workspace.root });

    expect(files.map((f) => f.path)).toEqual(["real/target.ts"]);
    expect(stats.symlinksSkipped).toBe(1);
  });

  test("files larger than maxFileSizeBytes are skipped", async () => {
    workspace = await makeTmpWorkspace({
      "small.ts": "x",
      "big.ts": "x".repeat(100),
    });

    const { files, stats } = await walkWorkspace({
      root: workspace.root,
      maxFileSizeBytes: 10,
    });

    expect(files.map((f) => f.path)).toEqual(["small.ts"]);
    expect(stats.filesTooLarge).toBe(1);
  });

  test("is stable across two runs", async () => {
    workspace = await makeTmpWorkspace({
      "a.ts": "export const a = 1;\n",
      "b/c.py": "x = 1\n",
    });

    const first = await walkWorkspace({ root: workspace.root });
    const second = await walkWorkspace({ root: workspace.root });

    expect(second.files.map((f) => f.path)).toEqual(first.files.map((f) => f.path));
  });

  test("paths are POSIX-separated and workspace-relative", async () => {
    workspace = await makeTmpWorkspace({
      "a/b/c.ts": "export const x = 1;\n",
    });

    const { files } = await walkWorkspace({ root: workspace.root });

    expect(files[0]?.path).toBe("a/b/c.ts");
    expect(files[0]?.path).not.toContain("\\");
  });

  test("emits a DirEntry per directory, root included, in pre-order with correct parents", async () => {
    workspace = await makeTmpWorkspace({
      "a/b/c.ts": "export const x = 1;\n",
      "d.ts": "export const y = 1;\n",
    });

    const { directories, files } = await walkWorkspace({ root: workspace.root });

    expect(directories.map((d) => d.path)).toEqual([".", "a", "a/b"]);
    expect(directories.find((d) => d.path === ".")?.parent).toBeUndefined();
    expect(directories.find((d) => d.path === "a")?.parent).toBe(".");
    expect(directories.find((d) => d.path === "a/b")?.parent).toBe("a");

    expect(files.find((f) => f.path === "a/b/c.ts")?.parent).toBe("a/b");
    expect(files.find((f) => f.path === "d.ts")?.parent).toBe(".");
  });

  test("an excluded directory yields no DirEntry", async () => {
    workspace = await makeTmpWorkspace({
      "lib/index.ts": "export const x = 1;\n",
      "node_modules/pkg/index.ts": "SHOULD_NEVER_APPEAR",
    });

    const { directories } = await walkWorkspace({ root: workspace.root });

    expect(directories.some((d) => d.path.includes("node_modules"))).toBe(false);
  });
});
