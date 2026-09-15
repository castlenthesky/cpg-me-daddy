/**
 * `filesystemProjector` — the `WatchSink` that turns a `ChangeBatch` into a
 * `FilesystemDelta` and writes it. This is the store half of what
 * `watch-workspace.test.ts` used to assert directly before the watcher/store
 * split; that file now only asserts `NormalizedChange`s, never a store call.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";

import { filesystemProjector } from "../../../src/indexer/filesystem-projector.ts";
import type { GraphDelta } from "../../../src/schema/validate.ts";
import type { BootstrapReport } from "../../../src/store/bootstrap.ts";
import type { FilesystemDelta } from "../../../src/store/cypher.ts";
import type { GraphMetadata, IGraphStore, WriteReport } from "../../../src/store/store.ts";
import type { ChangeBatch } from "../../../src/watch/sink.ts";
import { makeTmpWorkspace, type TmpWorkspace } from "../../support/tmp-workspace.ts";

class FakeGraphStore implements IGraphStore {
  readonly fsDeltas: FilesystemDelta[] = [];

  async bootstrap(): Promise<BootstrapReport> {
    return {
      indexesCreated: [],
      indexesExisting: [],
      constraintsCreated: [],
      constraintsExisting: [],
      schemaVersion: { expected: 1, found: 1, action: "matched" },
    };
  }

  async writeDelta(delta: GraphDelta): Promise<WriteReport> {
    return { nodesWritten: delta.nodes.length, edgesWritten: delta.edges.length, opsExecuted: 1 };
  }

  async writeFilesystem(delta: FilesystemDelta): Promise<WriteReport> {
    this.fsDeltas.push(delta);
    const nodesWritten = (delta.directories?.length ?? 0) + (delta.files?.length ?? 0);
    const edgesWritten =
      (delta.directories?.filter((d) => d.parent !== undefined).length ?? 0) +
      (delta.files?.length ?? 0);
    return { nodesWritten, edgesWritten, opsExecuted: 1 };
  }

  async deleteFile(): Promise<void> {}

  async readMetadata(): Promise<GraphMetadata | undefined> {
    return undefined;
  }

  async close(): Promise<void> {}
}

let workspace: TmpWorkspace | undefined;

async function disposeWorkspace(): Promise<void> {
  await workspace?.dispose();
  workspace = undefined;
}

describe("filesystemProjector", () => {
  test("a 'created' file change becomes a FILE row with language, hash, and loc", async () => {
    workspace = await makeTmpWorkspace({});
    try {
      await writeFile(`${workspace.root}/new.ts`, "export const x = 1;\nexport const y = 2;\n");
      const store = new FakeGraphStore();
      const sink = filesystemProjector({ store, root: workspace.root });

      const batch: ChangeBatch = {
        seq: 0,
        cause: "live",
        changes: [
          {
            kind: "created",
            entry: "file",
            path: "new.ts",
            contentHash: "irrelevant",
            sizeBytes: 42,
          },
        ],
      };
      await sink.onBatch(batch);

      expect(store.fsDeltas.length).toBe(1);
      const file = store.fsDeltas[0]!.files?.[0];
      expect(file?.path).toBe("new.ts");
      expect(file?.language).toBe("typescript");
      // `text.split("\n")` on a trailing-newline file yields a trailing ""
      // entry — same convention as `index-workspace.ts`'s own `countLoc`.
      expect(file?.loc).toBe(3);
    } finally {
      await disposeWorkspace();
    }
  });

  test("a non-code 'created' file gets the 'none' language sentinel", async () => {
    workspace = await makeTmpWorkspace({});
    try {
      await writeFile(`${workspace.root}/README.md`, "# hello\n");
      const store = new FakeGraphStore();
      const sink = filesystemProjector({ store, root: workspace.root });

      await sink.onBatch({
        seq: 0,
        cause: "live",
        changes: [
          { kind: "created", entry: "file", path: "README.md", contentHash: "h", sizeBytes: 8 },
        ],
      });

      expect(store.fsDeltas[0]!.files?.[0]?.language).toBe("none");
    } finally {
      await disposeWorkspace();
    }
  });

  test("a 'created' directory becomes a DIRECTORY row, root parent is undefined", async () => {
    workspace = await makeTmpWorkspace({});
    try {
      const store = new FakeGraphStore();
      const sink = filesystemProjector({ store, root: workspace.root });

      await sink.onBatch({
        seq: 0,
        cause: "initial",
        changes: [
          { kind: "created", entry: "directory", path: "." },
          { kind: "created", entry: "directory", path: "lib" },
        ],
      });

      expect(store.fsDeltas[0]!.directories).toEqual([
        { path: ".", name: ".", parent: undefined },
        { path: "lib", name: "lib", parent: "." },
      ]);
    } finally {
      await disposeWorkspace();
    }
  });

  test("a 'deleted' change becomes an FsRemoval, no file read", async () => {
    const store = new FakeGraphStore();
    const sink = filesystemProjector({ store, root: "/nonexistent" });

    await sink.onBatch({
      seq: 0,
      cause: "live",
      changes: [{ kind: "deleted", entry: "file", path: "gone.ts" }],
    });

    expect(store.fsDeltas[0]!.removals).toEqual([{ path: "gone.ts", kind: "file" }]);
  });

  test("a 'moved' change becomes an FsMove with derived name/parent, no file read", async () => {
    const store = new FakeGraphStore();
    const sink = filesystemProjector({ store, root: "/nonexistent" });

    await sink.onBatch({
      seq: 0,
      cause: "live",
      changes: [{ kind: "moved", entry: "file", path: "lib/a.ts", fromPath: "src/a.ts" }],
    });

    expect(store.fsDeltas[0]!.moves).toEqual([
      { fromPath: "src/a.ts", toPath: "lib/a.ts", toName: "a.ts", toParent: "lib", kind: "file" },
    ]);
  });

  test("an empty batch never calls the store", async () => {
    const store = new FakeGraphStore();
    const sink = filesystemProjector({ store, root: "/nonexistent" });

    await sink.onBatch({ seq: 0, cause: "live", changes: [] });

    expect(store.fsDeltas.length).toBe(0);
  });

  test("a directory-with-file batch groups both into one FilesystemDelta", async () => {
    workspace = await makeTmpWorkspace({});
    try {
      await mkdir(`${workspace.root}/lib`);
      await writeFile(`${workspace.root}/lib/x.ts`, "export const x = 1;\n");
      const store = new FakeGraphStore();
      const sink = filesystemProjector({ store, root: workspace.root });

      await sink.onBatch({
        seq: 0,
        cause: "live",
        changes: [
          { kind: "created", entry: "directory", path: "lib" },
          { kind: "created", entry: "file", path: "lib/x.ts", contentHash: "h", sizeBytes: 21 },
        ],
      });

      expect(store.fsDeltas.length).toBe(1);
      expect(store.fsDeltas[0]!.directories?.map((d) => d.path)).toEqual(["lib"]);
      expect(store.fsDeltas[0]!.files?.map((f) => f.path)).toEqual(["lib/x.ts"]);
    } finally {
      await disposeWorkspace();
    }
  });
});
