/**
 * `watchWorkspace` end to end against a real tmp workspace, with a fake
 * `WatchBackend` this test drives directly (so no real `@parcel/watcher`
 * subscription, no OS-level file-event timing) and a fake `IGraphStore`
 * recording every `FilesystemDelta`. The debounce window itself is real
 * (default 100ms/500ms) — these tests await the batch instead of faking
 * the clock, which `debounce.test.ts` already covers in isolation.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { defineCpgConfig } from "../../../src/config/workspace-config.ts";
import type { GraphDelta } from "../../../src/schema/validate.ts";
import type { BootstrapReport } from "../../../src/store/bootstrap.ts";
import type { FilesystemDelta } from "../../../src/store/cypher.ts";
import type { GraphMetadata, IGraphStore, WriteReport } from "../../../src/store/store.ts";
import type { RawEvent, WatchBackend } from "../../../src/watch/backend.ts";
import type { NormalizedChange } from "../../../src/watch/events.ts";
import { watchWorkspace } from "../../../src/watch/watch-workspace.ts";
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

/** A `WatchBackend` the test drives directly via `.emit(events)` — no real filesystem watching. */
function makeFakeWatchBackend(): {
  readonly backend: WatchBackend;
  emit(events: readonly RawEvent[]): void;
} {
  let handler: ((events: readonly RawEvent[]) => void) | undefined;
  return {
    backend: {
      async subscribe(_root, onEvents) {
        handler = onEvents;
        return {
          async unsubscribe() {
            handler = undefined;
          },
        };
      },
    },
    emit(events: readonly RawEvent[]): void {
      handler?.(events);
    },
  };
}

function waitForBatch(): {
  readonly promise: Promise<[readonly NormalizedChange[], WriteReport]>;
  readonly hook: (changes: readonly NormalizedChange[], write: WriteReport) => void;
} {
  let resolve!: (value: [readonly NormalizedChange[], WriteReport]) => void;
  const promise = new Promise<[readonly NormalizedChange[], WriteReport]>((r) => {
    resolve = r;
  });
  return { promise, hook: (changes, write) => resolve([changes, write]) };
}

let workspace: TmpWorkspace | undefined;
afterEach(async () => {
  await workspace?.dispose();
  workspace = undefined;
});

describe("watchWorkspace", () => {
  test("the initial pass writes the full filesystem tree once", async () => {
    workspace = await makeTmpWorkspace({ "a.ts": "export const a = 1;\n" });
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const store = new FakeGraphStore();
    const { backend } = makeFakeWatchBackend();

    const session = await watchWorkspace(config, { store, watcher: backend });
    try {
      expect(store.fsDeltas.length).toBe(1);
      expect(store.fsDeltas[0]!.files?.map((f) => f.path)).toEqual(["a.ts"]);
      expect(store.fsDeltas[0]!.directories?.some((d) => d.path === ".")).toBe(true);
    } finally {
      await session.close();
    }
  });

  test("skipInitialIndex still seeds known state, without writing", async () => {
    workspace = await makeTmpWorkspace({ "a.ts": "export const a = 1;\n" });
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const store = new FakeGraphStore();
    const { backend } = makeFakeWatchBackend();

    const session = await watchWorkspace(
      config,
      { store, watcher: backend },
      {
        skipInitialIndex: true,
      },
    );
    try {
      expect(store.fsDeltas.length).toBe(0);
    } finally {
      await session.close();
    }
  });

  test("a created file surfaces as one 'created' change and a FILE row", async () => {
    workspace = await makeTmpWorkspace({});
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const store = new FakeGraphStore();
    const { backend, emit } = makeFakeWatchBackend();
    const { promise, hook } = waitForBatch();

    const session = await watchWorkspace(config, { store, watcher: backend }, { onBatch: hook });
    try {
      const absPath = join(workspace.root, "new.ts");
      await writeFile(absPath, "export const x = 1;\n");
      emit([{ type: "create", path: absPath }]);

      const [changes] = await promise;
      expect(changes).toEqual([{ kind: "created", entry: "file", path: "new.ts" }]);
      const fsDelta = store.fsDeltas.at(-1)!;
      expect(fsDelta.files?.map((f) => f.path)).toEqual(["new.ts"]);
      expect(fsDelta.files?.[0]?.language).toBe("typescript");
    } finally {
      await session.close();
    }
  });

  test("a created non-code file gets the 'none' language sentinel, same as the initial walk", async () => {
    workspace = await makeTmpWorkspace({});
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const store = new FakeGraphStore();
    const { backend, emit } = makeFakeWatchBackend();
    const { promise, hook } = waitForBatch();

    const session = await watchWorkspace(config, { store, watcher: backend }, { onBatch: hook });
    try {
      const absPath = join(workspace.root, "README.md");
      await writeFile(absPath, "# hello\n");
      emit([{ type: "create", path: absPath }]);

      await promise;
      const fsDelta = store.fsDeltas.at(-1)!;
      expect(fsDelta.files?.[0]?.language).toBe("none");
    } finally {
      await session.close();
    }
  });

  test("a deleted file surfaces as one 'deleted' change and a FILE removal", async () => {
    workspace = await makeTmpWorkspace({ "a.ts": "export const a = 1;\n" });
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const store = new FakeGraphStore();
    const { backend, emit } = makeFakeWatchBackend();
    const { promise, hook } = waitForBatch();

    const session = await watchWorkspace(config, { store, watcher: backend }, { onBatch: hook });
    try {
      const absPath = join(workspace.root, "a.ts");
      await rm(absPath);
      emit([{ type: "delete", path: absPath }]);

      const [changes] = await promise;
      expect(changes).toEqual([{ kind: "deleted", entry: "file", path: "a.ts" }]);
      const fsDelta = store.fsDeltas.at(-1)!;
      expect(fsDelta.removals).toEqual([{ path: "a.ts", kind: "file" }]);
    } finally {
      await session.close();
    }
  });

  test("a rename (paired delete+create, same content) becomes one 'moved' change, not delete+create", async () => {
    workspace = await makeTmpWorkspace({ "old.ts": "export const x = 1;\n" });
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const store = new FakeGraphStore();
    const { backend, emit } = makeFakeWatchBackend();
    const { promise, hook } = waitForBatch();

    const session = await watchWorkspace(config, { store, watcher: backend }, { onBatch: hook });
    try {
      const fromAbs = join(workspace.root, "old.ts");
      const toAbs = join(workspace.root, "new.ts");
      await rename(fromAbs, toAbs);
      // A real watcher reports a rename as a paired delete+create in one batch.
      emit([
        { type: "delete", path: fromAbs },
        { type: "create", path: toAbs },
      ]);

      const [changes] = await promise;
      expect(changes).toEqual([
        { kind: "moved", entry: "file", path: "new.ts", fromPath: "old.ts" },
      ]);
      const fsDelta = store.fsDeltas.at(-1)!;
      expect(fsDelta.moves).toEqual([
        { fromPath: "old.ts", toPath: "new.ts", toName: "new.ts", toParent: ".", kind: "file" },
      ]);
      expect(fsDelta.removals ?? []).toEqual([]);
    } finally {
      await session.close();
    }
  });

  test("moving a file into a brand-new directory in the same batch still links it (regression)", async () => {
    workspace = await makeTmpWorkspace({ "src/a.ts": "export const a = 1;\n" });
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const store = new FakeGraphStore();
    const { backend, emit } = makeFakeWatchBackend();
    const { promise, hook } = waitForBatch();

    const session = await watchWorkspace(config, { store, watcher: backend }, { onBatch: hook });
    try {
      const dirAbs = join(workspace.root, "lib");
      const fromAbs = join(workspace.root, "src", "a.ts");
      const toAbs = join(dirAbs, "a.ts");
      await mkdir(dirAbs);
      await rename(fromAbs, toAbs);
      // mkdir + mv landing in ONE debounced batch — the destination
      // directory does not exist yet when the move is queued.
      emit([
        { type: "create", path: dirAbs },
        { type: "delete", path: fromAbs },
        { type: "create", path: toAbs },
      ]);

      const [changes] = await promise;
      expect(changes).toEqual(
        expect.arrayContaining([
          { kind: "created", entry: "directory", path: "lib" },
          { kind: "moved", entry: "file", path: "lib/a.ts", fromPath: "src/a.ts" },
        ]),
      );
      const fsDelta = store.fsDeltas.at(-1)!;
      expect(fsDelta.moves).toEqual([
        { fromPath: "src/a.ts", toPath: "lib/a.ts", toName: "a.ts", toParent: "lib", kind: "file" },
      ]);
      expect(fsDelta.directories?.map((d) => d.path)).toEqual(["lib"]);
    } finally {
      await session.close();
    }
  });

  test("a new directory with a file creates DIRECTORY+FILE rows and both surface as 'created'", async () => {
    workspace = await makeTmpWorkspace({});
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const store = new FakeGraphStore();
    const { backend, emit } = makeFakeWatchBackend();
    const { promise, hook } = waitForBatch();

    const session = await watchWorkspace(config, { store, watcher: backend }, { onBatch: hook });
    try {
      const dirAbs = join(workspace.root, "lib");
      const fileAbs = join(dirAbs, "x.ts");
      await mkdir(dirAbs);
      await writeFile(fileAbs, "export const x = 1;\n");
      emit([
        { type: "create", path: dirAbs },
        { type: "create", path: fileAbs },
      ]);

      const [changes] = await promise;
      expect(changes.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
        { kind: "created", entry: "directory", path: "lib" },
        { kind: "created", entry: "file", path: "lib/x.ts" },
      ]);
      const fsDelta = store.fsDeltas.at(-1)!;
      expect(fsDelta.directories?.map((d) => d.path)).toEqual(["lib"]);
      expect(fsDelta.files?.map((f) => f.path)).toEqual(["lib/x.ts"]);
    } finally {
      await session.close();
    }
  });

  test("a deleted (known) directory becomes a subtree removal", async () => {
    workspace = await makeTmpWorkspace({ "lib/x.ts": "export const x = 1;\n" });
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const store = new FakeGraphStore();
    const { backend, emit } = makeFakeWatchBackend();
    const { promise, hook } = waitForBatch();

    const session = await watchWorkspace(config, { store, watcher: backend }, { onBatch: hook });
    try {
      const dirAbs = join(workspace.root, "lib");
      await rm(dirAbs, { recursive: true });
      emit([{ type: "delete", path: dirAbs }]);

      const [changes] = await promise;
      expect(changes).toEqual([{ kind: "deleted", entry: "directory", path: "lib" }]);
      const fsDelta = store.fsDeltas.at(-1)!;
      expect(fsDelta.removals).toEqual([{ path: "lib", kind: "directory" }]);
    } finally {
      await session.close();
    }
  });

  test("a no-op rewrite (byte-identical content) produces no batch at all", async () => {
    workspace = await makeTmpWorkspace({ "a.ts": "export const a = 1;\n" });
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const store = new FakeGraphStore();
    const { backend, emit } = makeFakeWatchBackend();
    let batches = 0;

    const session = await watchWorkspace(
      config,
      { store, watcher: backend },
      {
        onBatch: () => {
          batches++;
        },
      },
    );
    try {
      const absPath = join(workspace.root, "a.ts");
      await writeFile(absPath, "export const a = 1;\n"); // identical bytes
      emit([{ type: "update", path: absPath }]);

      // The debounce window is 100ms; give it time to settle with no flush.
      await new Promise((r) => setTimeout(r, 150));
      expect(batches).toBe(0);
    } finally {
      await session.close();
    }
  });

  test("excluded paths (node_modules) never reach the store", async () => {
    workspace = await makeTmpWorkspace({});
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const store = new FakeGraphStore();
    const { backend, emit } = makeFakeWatchBackend();
    let batches = 0;

    const session = await watchWorkspace(
      config,
      { store, watcher: backend },
      {
        onBatch: () => {
          batches++;
        },
      },
    );
    try {
      const dirAbs = join(workspace.root, "node_modules", "pkg");
      const fileAbs = join(dirAbs, "index.ts");
      await mkdir(dirAbs, { recursive: true });
      await writeFile(fileAbs, "SHOULD_NEVER_APPEAR");
      emit([
        { type: "create", path: join(workspace.root, "node_modules") },
        { type: "create", path: dirAbs },
        { type: "create", path: fileAbs },
      ]);

      await new Promise((r) => setTimeout(r, 150));
      expect(batches).toBe(0);
    } finally {
      await session.close();
    }
  });
});
