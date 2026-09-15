/**
 * The watcher's own orchestrator: an initial full filesystem-tier walk, then
 * a live `WatchBackend` subscription whose settled batches become
 * `NormalizedChange`s delivered to a `WatchSink` (`./sink.ts`) — never a
 * graph store directly. That inversion is this file's whole point: before
 * it, `watchWorkspace` took an `IGraphStore` in its own deps and called
 * `writeFilesystem` on it directly, which meant the watcher could not be
 * built, tested, or reasoned about without a graph store in the picture.
 * Now it can't — this file imports nothing from `../store` or `../schema`.
 * `indexer/filesystem-projector.ts` is the sink that restores today's
 * `cpg watch` behaviour end to end: `watcher -> projector -> store`.
 *
 * Filesystem-tier only, deliberately: unlike `indexer/index-workspace.ts`
 * (which restores AST/CPG extraction alongside its filesystem phase), this
 * orchestrator carries no parser dependency at all — nothing here parses. A
 * `NormalizedChange` never carries file bytes, `loc`, or a resolved
 * `language`; a consumer that needs those re-reads the file itself. That is
 * a deliberate, documented cost (one extra read per changed file, usually
 * served from page cache) for keeping this file ignorant of what anything
 * downstream does with a change — see `docs/architecture/service-boundaries.md`.
 *
 * Delivery is at-least-once and serialized: `SerialQueue` (`./queue.ts`)
 * guarantees at most one settled batch is being processed at a time — the
 * pre-existing race, where a slow store write left a window for a second,
 * overlapping `processBatch` call to mutate the same in-memory state, is
 * closed. A `WatchSink.onBatch` rejection is retried with bounded backoff
 * (`withRetry`) before the batch's paths are reported via `onDegraded` —
 * never silently dropped with only a log line.
 *
 * What ships now (see `40-research.yaml` `adopted_defaults.watcher`): the
 * `@parcel/watcher` backend, 100ms trailing / 500ms ceiling debounce,
 * delete→create coalescing into a move (content-hash paired, files only), a
 * no-op hash filter, directory support, and one shared admission predicate
 * (`workspace/admit.ts`) with the walker, so excludes, the size limit, and
 * the symlink policy can never silently diverge between an initial
 * `cpg index` and a live `cpg watch`. Deferred to later hardening work:
 * ino+dev rename pairing, crash-resume via `@parcel/watcher`'s own snapshot
 * API, reconciliation walks, bulk-mode thresholds and `.git/index.lock`
 * bracketing, Linux `max_user_watches` handling, and the
 * `@parcel/watcher-wasm` → chokidar fallback chain.
 */
import { lstat, readFile } from "node:fs/promises";
import { relative, sep } from "node:path";

import type { CpgConfig } from "../config/workspace-config";
import { admitEntry, type AdmitLimits, type AdmitMatchers } from "../workspace/admit";
import {
  DEFAULT_EXCLUDES,
  DEFAULT_INCLUDES,
  DEFAULT_MAX_FILE_SIZE_BYTES,
} from "../workspace/defaults";
import { compileMatcher } from "../workspace/glob";
import { hashBytes } from "../workspace/hash";
import { walkWorkspace } from "../workspace/walker";
import type { RawEvent, WatchBackend } from "./backend";
import { ChangeBatcher } from "./debounce";
import type { NormalizedChange } from "./events";
import { isExcludedPath, type KnownFile, pairFileRenames } from "./normalize";
import { parcelWatchBackend } from "./parcel-backend";
import { SerialQueue, withRetry } from "./queue";
import type { BatchCause, ChangeBatch, WatchSink } from "./sink";

export interface WatchWorkspaceDeps {
  readonly sink: WatchSink;
  /** Default: the `@parcel/watcher` backend. Injected in tests. */
  readonly watcher?: WatchBackend;
}

export interface WatchHooks {
  /** Fires once, after the initial full filesystem-tier index is delivered to the sink. */
  readonly onReady?: (report: { filesIndexed: number; directoriesWritten: number }) => void;
  /** Fires after every settled, non-empty batch is successfully delivered. */
  readonly onBatch?: (batch: ChangeBatch) => void;
  readonly onWarning?: (message: string) => void;
  /**
   * Fires once a batch's delivery exhausts its retries. The affected paths
   * are NOT reflected wherever the sink writes and will not be retried
   * automatically until a future filesystem event touches them again —
   * proactive reconciliation is a separate, not-yet-built pass (this file's
   * module doc).
   */
  readonly onDegraded?: (paths: readonly string[], error: unknown) => void;
  readonly signal?: AbortSignal;
  /** Skip the initial full index — assumes the sink's state is already current. Default `false`. */
  readonly skipInitialIndex?: boolean;
}

export interface WatchSession {
  close(): Promise<void>;
}

function toRelPath(root: string, absPath: string): string | undefined {
  const rel = relative(root, absPath);
  if (rel === "" || rel.startsWith("..")) {
    return undefined;
  }
  return sep === "/" ? rel : rel.split(sep).join("/");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function watchWorkspace(
  config: CpgConfig,
  deps: WatchWorkspaceDeps,
  hooks: WatchHooks = {},
): Promise<WatchSession> {
  const watcher = deps.watcher ?? parcelWatchBackend;
  const include = compileMatcher(config.walk.include ?? DEFAULT_INCLUDES);
  const exclude = compileMatcher(config.walk.exclude ?? DEFAULT_EXCLUDES);
  const matchers: AdmitMatchers = { include, exclude };
  const limits: AdmitLimits = {
    maxFileSizeBytes: config.walk.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES,
    followSymlinks: config.walk.followSymlinks ?? false,
  };

  const knownFiles = new Map<string, KnownFile>();
  const knownDirs = new Set<string>();
  let nextSeq = 0;

  function forgetSubtree(rootPath: string): void {
    const prefix = `${rootPath}/`;
    knownDirs.delete(rootPath);
    // Deleting the current/already-visited key mid-iteration is well-defined
    // for Map/Set iterators (and is exactly what's wanted here), so this
    // iterates the live collections directly rather than a snapshot copy.
    for (const p of knownDirs) {
      if (p.startsWith(prefix)) {
        knownDirs.delete(p);
      }
    }
    for (const p of knownFiles.keys()) {
      if (p === rootPath || p.startsWith(prefix)) {
        knownFiles.delete(p);
      }
    }
  }

  /** Delivers `changes` with bounded retry, reporting the outcome via hooks.
   *  Rethrows on final failure — the initial-index call site lets that
   *  reject `watchWorkspace()` itself (fail fast on a broken sink); the live
   *  call site (`processBatch`) catches it instead. */
  async function deliver(changes: readonly NormalizedChange[], cause: BatchCause): Promise<void> {
    const batch: ChangeBatch = { seq: nextSeq++, changes, cause };
    await withRetry(() => deps.sink.onBatch(batch), {
      onRetry: (attempt, error) =>
        hooks.onWarning?.(`delivery attempt ${attempt} failed, retrying: ${describeError(error)}`),
    });
    hooks.onBatch?.(batch);
  }

  // ── Initial pass: seed known state, and (unless skipped) deliver it. ──
  const { files: initialFiles, directories: initialDirs } = await walkWorkspace(config.walk);
  for (const d of initialDirs) {
    knownDirs.add(d.path);
  }
  const initialChanges: NormalizedChange[] = [];
  /* eslint-disable no-await-in-loop */
  for (const entry of initialFiles) {
    const bytes = await readFile(entry.absolutePath);
    const contentHash = hashBytes(bytes);
    knownFiles.set(entry.path, { contentHash });
    initialChanges.push({
      kind: "created",
      entry: "file",
      path: entry.path,
      contentHash,
      sizeBytes: bytes.length,
    });
  }
  /* eslint-enable no-await-in-loop */
  for (const d of initialDirs) {
    initialChanges.push({ kind: "created", entry: "directory", path: d.path });
  }

  if (!hooks.skipInitialIndex) {
    await deliver(initialChanges, "initial");
  }
  hooks.onReady?.({ filesIndexed: initialFiles.length, directoriesWritten: initialDirs.length });

  // ── Live subscription. ──────────────────────────────────────────────────
  let closed = false;

  async function processBatch(events: readonly RawEvent[]): Promise<void> {
    const fileDeletes: string[] = [];
    const dirRemovals: string[] = [];
    const hashedCreates = new Map<string, { contentHash: string; sizeBytes: number }>();
    const dirCreates: string[] = [];

    for (const event of events) {
      const relPath = toRelPath(config.root, event.path);
      if (relPath === undefined || relPath === "") {
        continue;
      }

      if (event.type === "delete") {
        const wasDir = knownDirs.has(relPath);
        if (isExcludedPath(relPath, wasDir, include, exclude)) {
          continue;
        }
        if (wasDir) {
          dirRemovals.push(relPath);
        } else {
          // Unknown paths default to "file" — the safe case: a best-effort
          // removal for a path that was never known is a no-op for any
          // sensible sink.
          fileDeletes.push(relPath);
        }
        continue;
      }

      // create/update: lstat to find out what it is now — it may have
      // vanished again (raced) between the batch settling and now, in which
      // case there is nothing to admit. `lstat`, never `stat`: a symlink
      // must be classified as itself (matching the walker's own `Dirent`
      // semantics), or `followSymlinks: false` would be enforced on the
      // initial walk and silently ignored here — exactly the divergence
      // `workspace/admit.ts` exists to rule out.
      let entryStat;
      try {
        entryStat = await lstat(event.path); // eslint-disable-line no-await-in-loop
      } catch {
        continue;
      }
      const verdict = admitEntry(
        relPath,
        {
          isSymbolicLink: entryStat.isSymbolicLink(),
          isDirectory: entryStat.isDirectory(),
          isRegularFile: entryStat.isFile(),
          sizeBytes: entryStat.size,
        },
        matchers,
        limits,
      );
      if (!verdict.admitted) {
        continue;
      }
      if (entryStat.isDirectory()) {
        dirCreates.push(relPath);
        continue;
      }
      try {
        const bytes = await readFile(event.path); // eslint-disable-line no-await-in-loop
        hashedCreates.set(relPath, { contentHash: hashBytes(bytes), sizeBytes: bytes.length });
      } catch {
        // Raced again — dropped, same as above.
      }
    }

    const {
      moves,
      removals: pairedFileRemovals,
      survivingCreates,
    } = pairFileRenames(fileDeletes, hashedCreates, knownFiles);

    const fileChanges: NormalizedChange[] = [];
    for (const [path, hashed] of survivingCreates) {
      const prior = knownFiles.get(path);
      if (prior !== undefined && prior.contentHash === hashed.contentHash) {
        continue; // no-op filter: content is unchanged
      }
      fileChanges.push({
        kind: prior === undefined ? "created" : "changed",
        entry: "file",
        path,
        contentHash: hashed.contentHash,
        sizeBytes: hashed.sizeBytes,
      });
    }

    const newDirs = dirCreates.filter((p) => !knownDirs.has(p));
    const removals: Array<{ path: string; kind: "file" | "directory" }> = [
      ...pairedFileRemovals.map((path) => ({ path, kind: "file" as const })),
      ...dirRemovals.map((path) => ({ path, kind: "directory" as const })),
    ];

    if (
      newDirs.length === 0 &&
      fileChanges.length === 0 &&
      removals.length === 0 &&
      moves.length === 0
    ) {
      return;
    }

    const changes: NormalizedChange[] = [
      ...fileChanges,
      ...newDirs.map((path): NormalizedChange => ({ kind: "created", entry: "directory", path })),
      ...removals.map((r): NormalizedChange => ({ kind: "deleted", entry: r.kind, path: r.path })),
      ...moves.map((m): NormalizedChange => ({
        kind: "moved",
        entry: m.kind,
        path: m.toPath,
        fromPath: m.fromPath,
      })),
    ];

    try {
      await deliver(changes, "live");
    } catch (error) {
      const affected = changes.map((c) => c.path);
      hooks.onWarning?.(
        `batch delivery failed after retries, ${affected.length} path(s) not reflected: ${describeError(error)}`,
      );
      hooks.onDegraded?.(affected, error);
      return;
    }

    // Reconcile in-memory state to match what was just delivered — only on
    // confirmed delivery, so a failed write never leaves this state ahead
    // of what the sink actually has.
    for (const path of newDirs) {
      knownDirs.add(path);
    }
    for (const [path, hashed] of survivingCreates) {
      knownFiles.set(path, { contentHash: hashed.contentHash });
    }
    for (const r of removals) {
      if (r.kind === "file") {
        knownFiles.delete(r.path);
      } else {
        forgetSubtree(r.path);
      }
    }
    for (const m of moves) {
      const known = knownFiles.get(m.fromPath);
      knownFiles.delete(m.fromPath);
      if (known !== undefined) {
        knownFiles.set(m.toPath, known);
      }
    }
  }

  const queue = new SerialQueue<readonly RawEvent[]>(processBatch, {
    onError: (error) => hooks.onWarning?.(describeError(error)),
  });

  const batcher = new ChangeBatcher<RawEvent>((items) => {
    queue.enqueue(items);
  });

  const subscription = await watcher.subscribe(
    config.root,
    (events) => {
      for (const event of events) {
        batcher.add(event.path, event);
      }
    },
    {
      // A coarse pre-filter only — see this file's module doc and
      // `normalize.ts`'s `isExcludedPath`, the authoritative boundary.
      ignore: config.walk.exclude ?? DEFAULT_EXCLUDES,
      onError: (error) => hooks.onWarning?.(error.message),
    },
  );

  async function close(): Promise<void> {
    if (closed) {
      return;
    }
    closed = true;
    batcher.dispose();
    queue.dispose();
    await subscription.unsubscribe();
  }

  hooks.signal?.addEventListener("abort", () => {
    void close();
  });

  return { close };
}
