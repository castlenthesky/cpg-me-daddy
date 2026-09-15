/**
 * `watchWorkspace` end to end against a real tmp workspace, with a fake
 * `WatchBackend` this test drives directly (so no real `@parcel/watcher`
 * subscription, no OS-level file-event timing) and a fake `WatchSink`
 * recording every delivered `ChangeBatch`. No `IGraphStore` anywhere in this
 * file — that is the whole point of the watcher/store split this test
 * exercises; `indexer/filesystem-projector.test.ts` covers the store half.
 * The debounce window itself is real (default 100ms/500ms) — these tests
 * await the batch instead of faking the clock, which `debounce.test.ts`
 * already covers in isolation.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { defineCpgConfig } from "../../../src/config/workspace-config.ts";
import type { RawEvent, WatchBackend } from "../../../src/watch/backend.ts";
import type { ChangeBatch, WatchSink } from "../../../src/watch/sink.ts";
import { watchWorkspace } from "../../../src/watch/watch-workspace.ts";
import { makeTmpWorkspace, type TmpWorkspace } from "../../support/tmp-workspace.ts";

/** A `WatchSink` recording every delivered batch, with a resolvable rejection queue for retry tests. */
function makeRecordingSink(): {
  readonly sink: WatchSink;
  readonly batches: ChangeBatch[];
  /** Makes the NEXT `onBatch` call reject with `error`, once. */
  failNext(error: unknown): void;
} {
  const batches: ChangeBatch[] = [];
  let pendingFailure: unknown;
  return {
    sink: {
      async onBatch(batch: ChangeBatch): Promise<void> {
        if (pendingFailure !== undefined) {
          const error = pendingFailure;
          pendingFailure = undefined;
          throw error;
        }
        batches.push(batch);
      },
    },
    batches,
    failNext(error: unknown): void {
      pendingFailure = error;
    },
  };
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
  readonly promise: Promise<ChangeBatch>;
  readonly hook: (batch: ChangeBatch) => void;
} {
  let resolve!: (value: ChangeBatch) => void;
  const promise = new Promise<ChangeBatch>((r) => {
    resolve = r;
  });
  return { promise, hook: (batch) => resolve(batch) };
}

/** A `WatchSink` that forwards only "live" batches to `hook` — every test
 *  using this also receives the "initial" cold-start batch first, which
 *  these single-change assertions don't care about. */
function sinkCallingHookOnLive(hook: (batch: ChangeBatch) => void): WatchSink {
  return {
    async onBatch(batch: ChangeBatch): Promise<void> {
      if (batch.cause === "live") {
        hook(batch);
      }
    },
  };
}

let workspace: TmpWorkspace | undefined;
afterEach(async () => {
  await workspace?.dispose();
  workspace = undefined;
});

describe("watchWorkspace", () => {
  test("the initial pass delivers the full filesystem tree once, as one batch", async () => {
    workspace = await makeTmpWorkspace({ "a.ts": "export const a = 1;\n" });
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const { sink, batches } = makeRecordingSink();
    const { backend } = makeFakeWatchBackend();

    const session = await watchWorkspace(config, { sink, watcher: backend });
    try {
      expect(batches.length).toBe(1);
      expect(batches[0]!.cause).toBe("initial");
      expect(batches[0]!.changes.some((c) => c.entry === "file" && c.path === "a.ts")).toBe(true);
      expect(batches[0]!.changes.some((c) => c.entry === "directory" && c.path === ".")).toBe(true);
    } finally {
      await session.close();
    }
  });

  test("skipInitialIndex still seeds known state, without delivering a batch", async () => {
    workspace = await makeTmpWorkspace({ "a.ts": "export const a = 1;\n" });
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const { sink, batches } = makeRecordingSink();
    const { backend } = makeFakeWatchBackend();

    const session = await watchWorkspace(
      config,
      { sink, watcher: backend },
      { skipInitialIndex: true },
    );
    try {
      expect(batches.length).toBe(0);
    } finally {
      await session.close();
    }
  });

  test("a created file surfaces as one 'created' change with a content hash", async () => {
    workspace = await makeTmpWorkspace({});
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const { backend, emit } = makeFakeWatchBackend();
    const { promise, hook } = waitForBatch();

    const session = await watchWorkspace(config, {
      sink: sinkCallingHookOnLive(hook),
      watcher: backend,
    });
    try {
      const absPath = join(workspace.root, "new.ts");
      await writeFile(absPath, "export const x = 1;\n");
      emit([{ type: "create", path: absPath }]);

      const batch = await promise;
      expect(batch.cause).toBe("live");
      expect(batch.changes).toEqual([
        {
          kind: "created",
          entry: "file",
          path: "new.ts",
          contentHash: expect.any(String),
          sizeBytes: 20,
        },
      ]);
    } finally {
      await session.close();
    }
  });

  test("a deleted file surfaces as one 'deleted' change", async () => {
    workspace = await makeTmpWorkspace({ "a.ts": "export const a = 1;\n" });
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const { backend, emit } = makeFakeWatchBackend();
    const { promise, hook } = waitForBatch();

    const session = await watchWorkspace(config, {
      sink: sinkCallingHookOnLive(hook),
      watcher: backend,
    });
    try {
      const absPath = join(workspace.root, "a.ts");
      await rm(absPath);
      emit([{ type: "delete", path: absPath }]);

      const batch = await promise;
      expect(batch.changes).toEqual([{ kind: "deleted", entry: "file", path: "a.ts" }]);
    } finally {
      await session.close();
    }
  });

  test("a rename (paired delete+create, same content) becomes one 'moved' change, not delete+create", async () => {
    workspace = await makeTmpWorkspace({ "old.ts": "export const x = 1;\n" });
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const { backend, emit } = makeFakeWatchBackend();
    const { promise, hook } = waitForBatch();

    const session = await watchWorkspace(config, {
      sink: sinkCallingHookOnLive(hook),
      watcher: backend,
    });
    try {
      const fromAbs = join(workspace.root, "old.ts");
      const toAbs = join(workspace.root, "new.ts");
      await rename(fromAbs, toAbs);
      // A real watcher reports a rename as a paired delete+create in one batch.
      emit([
        { type: "delete", path: fromAbs },
        { type: "create", path: toAbs },
      ]);

      const batch = await promise;
      expect(batch.changes).toEqual([
        {
          kind: "moved",
          entry: "file",
          path: "new.ts",
          fromPath: "old.ts",
        },
      ]);
    } finally {
      await session.close();
    }
  });

  test("moving a file into a brand-new directory in the same batch still links it (regression)", async () => {
    workspace = await makeTmpWorkspace({ "src/a.ts": "export const a = 1;\n" });
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const { backend, emit } = makeFakeWatchBackend();
    const { promise, hook } = waitForBatch();

    const session = await watchWorkspace(config, {
      sink: sinkCallingHookOnLive(hook),
      watcher: backend,
    });
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

      const batch = await promise;
      expect(batch.changes).toEqual(
        expect.arrayContaining([
          { kind: "created", entry: "directory", path: "lib" },
          { kind: "moved", entry: "file", path: "lib/a.ts", fromPath: "src/a.ts" },
        ]),
      );
    } finally {
      await session.close();
    }
  });

  test("a new directory with a file creates both, and both surface as 'created'", async () => {
    workspace = await makeTmpWorkspace({});
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const { backend, emit } = makeFakeWatchBackend();
    const { promise, hook } = waitForBatch();

    const session = await watchWorkspace(config, {
      sink: sinkCallingHookOnLive(hook),
      watcher: backend,
    });
    try {
      const dirAbs = join(workspace.root, "lib");
      const fileAbs = join(dirAbs, "x.ts");
      await mkdir(dirAbs);
      await writeFile(fileAbs, "export const x = 1;\n");
      emit([
        { type: "create", path: dirAbs },
        { type: "create", path: fileAbs },
      ]);

      const batch = await promise;
      const paths = batch.changes.map((c) => c.path).toSorted();
      expect(paths).toEqual(["lib", "lib/x.ts"]);
      expect(batch.changes.every((c) => c.kind === "created")).toBe(true);
    } finally {
      await session.close();
    }
  });

  test("a deleted (known) directory becomes a subtree removal", async () => {
    workspace = await makeTmpWorkspace({ "lib/x.ts": "export const x = 1;\n" });
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const { backend, emit } = makeFakeWatchBackend();
    const { promise, hook } = waitForBatch();

    const session = await watchWorkspace(config, {
      sink: sinkCallingHookOnLive(hook),
      watcher: backend,
    });
    try {
      const dirAbs = join(workspace.root, "lib");
      await rm(dirAbs, { recursive: true });
      emit([{ type: "delete", path: dirAbs }]);

      const batch = await promise;
      expect(batch.changes).toEqual([{ kind: "deleted", entry: "directory", path: "lib" }]);
    } finally {
      await session.close();
    }
  });

  test("a no-op rewrite (byte-identical content) delivers no batch at all", async () => {
    workspace = await makeTmpWorkspace({ "a.ts": "export const a = 1;\n" });
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const { sink, batches } = makeRecordingSink();
    const { backend, emit } = makeFakeWatchBackend();

    const session = await watchWorkspace(config, { sink, watcher: backend });
    try {
      const absPath = join(workspace.root, "a.ts");
      await writeFile(absPath, "export const a = 1;\n"); // identical bytes
      emit([{ type: "update", path: absPath }]);

      // The debounce window is 100ms; give it time to settle with no flush.
      await new Promise((r) => setTimeout(r, 150));
      expect(batches.length).toBe(1); // only the initial batch
    } finally {
      await session.close();
    }
  });

  test("excluded paths (node_modules) never reach the sink", async () => {
    workspace = await makeTmpWorkspace({});
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const { sink, batches } = makeRecordingSink();
    const { backend, emit } = makeFakeWatchBackend();

    const session = await watchWorkspace(config, { sink, watcher: backend });
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
      expect(batches.length).toBe(1); // only the initial batch
    } finally {
      await session.close();
    }
  });

  test("a file larger than the size limit is never admitted, matching the walker", async () => {
    workspace = await makeTmpWorkspace({});
    const config = defineCpgConfig({ root: workspace.root, env: {}, maxFileSizeBytes: 10 });
    const { sink, batches } = makeRecordingSink();
    const { backend, emit } = makeFakeWatchBackend();

    const session = await watchWorkspace(config, { sink, watcher: backend });
    try {
      const absPath = join(workspace.root, "big.ts");
      await writeFile(absPath, "x".repeat(50));
      emit([{ type: "create", path: absPath }]);

      await new Promise((r) => setTimeout(r, 150));
      expect(batches.length).toBe(1); // only the initial batch — the big file never admitted
    } finally {
      await session.close();
    }
  });

  test("a batch that fails delivery is retried and does not advance known state", async () => {
    workspace = await makeTmpWorkspace({});
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const { sink, batches, failNext } = makeRecordingSink();
    const { backend, emit } = makeFakeWatchBackend();

    const session = await watchWorkspace(config, { sink, watcher: backend });
    try {
      expect(batches.length).toBe(1); // initial

      const absPath = join(workspace.root, "flaky.ts");
      await writeFile(absPath, "export const x = 1;\n");
      failNext(new Error("transient store error"));
      emit([{ type: "create", path: absPath }]);

      // withRetry succeeds on its second attempt (first rejects, second lands).
      await new Promise((r) => setTimeout(r, 400));
      expect(batches.length).toBe(2);
      expect(batches[1]!.changes).toEqual([
        {
          kind: "created",
          entry: "file",
          path: "flaky.ts",
          contentHash: expect.any(String),
          sizeBytes: expect.any(Number),
        },
      ]);
    } finally {
      await session.close();
    }
  });

  test("a batch that exhausts retries reports onDegraded and never delivers", async () => {
    workspace = await makeTmpWorkspace({});
    const config = defineCpgConfig({ root: workspace.root, env: {} });
    const sink: WatchSink = {
      async onBatch(): Promise<void> {
        throw new Error("permanent store failure");
      },
    };
    const { backend, emit } = makeFakeWatchBackend();
    let degraded: readonly string[] | undefined;

    const session = await watchWorkspace(
      config,
      { sink, watcher: backend },
      {
        skipInitialIndex: true,
        onDegraded: (paths) => {
          degraded = paths;
        },
      },
    );
    try {
      const absPath = join(workspace.root, "broken.ts");
      await writeFile(absPath, "export const x = 1;\n");
      emit([{ type: "create", path: absPath }]);

      // Default retry policy: 5 attempts, backoff 200/400/800/1600ms — worst
      // case ~3000ms before the final attempt throws and onDegraded fires.
      await new Promise((r) => setTimeout(r, 3600));
      expect(degraded).toEqual(["broken.ts"]);
    } finally {
      await session.close();
    }
  }, 7000);
});
