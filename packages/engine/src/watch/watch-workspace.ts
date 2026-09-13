/**
 * The watcher's own orchestrator: an initial full filesystem-tier walk and
 * write, then a live `WatchBackend` subscription whose settled batches
 * become `FilesystemDelta` writes — the same `IGraphStore.writeFilesystem`
 * seam `cpg index` uses for its own filesystem phase.
 *
 * Filesystem-tier only, deliberately: unlike `indexer/index-workspace.ts`
 * (which restores AST/CPG extraction alongside its filesystem phase), this
 * orchestrator carries no `backend`/adapter dependency at all — nothing
 * here parses. That means a workspace `cpg watch`ed from a cold start does
 * NOT get MODULE/METHOD/etc. nodes the way `cpg index` does; only the
 * DIRECTORY/FILE/HAS_ENTRY tree. Run `cpg index` first (or add a `backend`
 * here and thread AST extraction through `processBatch`, mirroring the
 * indexer) when live AST updates are needed too — a real scope increase,
 * not yet done.
 *
 * What ships now (see `40-research.yaml` `adopted_defaults.watcher`): the
 * `@parcel/watcher` backend, 100ms trailing / 500ms ceiling debounce,
 * delete→create coalescing into a move (content-hash paired, files only),
 * a no-op hash filter, and directory support. Deferred to the real M1.1
 * gate: ino+dev rename pairing, bulk-mode thresholds and `.git/index.lock`
 * bracketing, idle/error reconciliation, Linux `max_user_watches` handling,
 * and the `@parcel/watcher-wasm` → chokidar fallback chain.
 */
import { readFile, stat } from "node:fs/promises";
import { relative, sep } from "node:path";

import type { CpgConfig } from "../config/workspace-config";
import { grammarForPath } from "../parser/grammars";
import type { FsDirectoryRow, FsFileRow, FsRemoval } from "../store/cypher";
import type { IGraphStore, WriteReport } from "../store/store";
import { DEFAULT_EXCLUDES, DEFAULT_INCLUDES } from "../workspace/defaults";
import { compileMatcher } from "../workspace/glob";
import { hashBytes } from "../workspace/hash";
import { baseName, parentDirPath, ROOT_DIR_PATH } from "../workspace/paths";
import { walkWorkspace } from "../workspace/walker";
import type { RawEvent, WatchBackend, WatchSubscription } from "./backend";
import { ChangeBatcher } from "./debounce";
import type { NormalizedChange } from "./events";
import { type KnownFile, isExcludedPath, pairFileRenames } from "./normalize";
import { parcelWatchBackend } from "./parcel-backend";

export interface WatchWorkspaceDeps {
  readonly store: IGraphStore;
  /** Default: the `@parcel/watcher` backend. Injected in tests. */
  readonly watcher?: WatchBackend;
  /** Injected in tests for a deterministic `FILE.indexed_at`. */
  readonly now?: () => string;
}

export interface WatchHooks {
  /** Fires once, after the initial full filesystem-tier index completes. */
  readonly onReady?: (report: { filesIndexed: number; directoriesWritten: number }) => void;
  /** Fires after every settled, non-empty batch is written. */
  readonly onBatch?: (changes: readonly NormalizedChange[], write: WriteReport) => void;
  readonly onWarning?: (message: string) => void;
  readonly signal?: AbortSignal;
  /** Skip the initial full index — assumes the graph is already current. Default `false`. */
  readonly skipInitialIndex?: boolean;
}

export interface WatchSession {
  close(): Promise<void>;
}

function countLoc(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

function toRelPath(root: string, absPath: string): string | undefined {
  const rel = relative(root, absPath);
  if (rel === "" || rel.startsWith("..")) {
    return undefined;
  }
  return sep === "/" ? rel : rel.split(sep).join("/");
}

function fsDirectoryRow(path: string, parent: string | undefined): FsDirectoryRow {
  return { path, name: path === ROOT_DIR_PATH ? ROOT_DIR_PATH : baseName(path), parent };
}

export async function watchWorkspace(
  config: CpgConfig,
  deps: WatchWorkspaceDeps,
  hooks: WatchHooks = {},
): Promise<WatchSession> {
  const now = deps.now ?? (() => new Date().toISOString());
  const watcher = deps.watcher ?? parcelWatchBackend;
  const include = compileMatcher(config.walk.include ?? DEFAULT_INCLUDES);
  const exclude = compileMatcher(config.walk.exclude ?? DEFAULT_EXCLUDES);

  const knownFiles = new Map<string, KnownFile>();
  const knownDirs = new Set<string>();

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

  // ── Initial pass: seed known state, and (unless skipped) write the tree. ──
  const { files: initialFiles, directories: initialDirs } = await walkWorkspace(config.walk);
  for (const d of initialDirs) {
    knownDirs.add(d.path);
  }
  const initialFsFiles: FsFileRow[] = [];
  /* eslint-disable no-await-in-loop */
  for (const entry of initialFiles) {
    const bytes = await readFile(entry.absolutePath);
    const contentHash = hashBytes(bytes);
    knownFiles.set(entry.path, { contentHash, parent: entry.parent });
    initialFsFiles.push({
      path: entry.path,
      name: baseName(entry.path),
      parent: entry.parent,
      language: entry.language ?? "none",
      content_hash: contentHash,
      status: "ready",
      version: 1,
      indexed_at: now(),
      loc: countLoc(bytes.toString("utf8")),
    });
  }
  /* eslint-enable no-await-in-loop */

  if (!hooks.skipInitialIndex) {
    await deps.store.writeFilesystem({
      directories: initialDirs.map((d) => fsDirectoryRow(d.path, d.parent)),
      files: initialFsFiles,
    });
  }
  hooks.onReady?.({ filesIndexed: initialFiles.length, directoriesWritten: initialDirs.length });

  // ── Live subscription. ──────────────────────────────────────────────────
  let closed = false;

  async function processBatch(events: readonly RawEvent[]): Promise<void> {
    const fileDeletes: string[] = [];
    const dirRemovals: FsRemoval[] = [];
    const hashedCreates = new Map<string, { contentHash: string; loc: number }>();
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
          dirRemovals.push({ path: relPath, kind: "directory" });
        } else {
          // Unknown paths default to "file" — the safe case: a best-effort
          // DETACH DELETE on a path that never had a FILE node is a no-op.
          fileDeletes.push(relPath);
        }
        continue;
      }

      // create/update: stat to find out if it is a file or a directory —
      // it may have vanished again (raced) between the batch settling and
      // now, in which case there is nothing to create.
      let isDirectory: boolean;
      try {
        const st = await stat(event.path); // eslint-disable-line no-await-in-loop
        isDirectory = st.isDirectory();
      } catch {
        continue;
      }
      if (isExcludedPath(relPath, isDirectory, include, exclude)) {
        continue;
      }
      if (isDirectory) {
        dirCreates.push(relPath);
        continue;
      }
      try {
        const bytes = await readFile(event.path); // eslint-disable-line no-await-in-loop
        hashedCreates.set(relPath, {
          contentHash: hashBytes(bytes),
          loc: countLoc(bytes.toString("utf8")),
        });
      } catch {
        // Raced again — dropped, same as above.
      }
    }

    const {
      moves,
      removals: pairedFileRemovals,
      survivingCreates,
    } = pairFileRenames(fileDeletes, hashedCreates, knownFiles);

    const files: FsFileRow[] = [];
    const created: string[] = [];
    const changed: string[] = [];
    for (const [path, hashed] of survivingCreates) {
      const prior = knownFiles.get(path);
      if (prior !== undefined && prior.contentHash === hashed.contentHash) {
        continue; // no-op filter: content is unchanged
      }
      const parent = parentDirPath(path);
      files.push({
        path,
        name: baseName(path),
        parent,
        // Same "none" sentinel the initial walk uses for a path with no
        // registered grammar — see `indexer/index-workspace.ts`.
        language: grammarForPath(path) ?? "none",
        content_hash: hashed.contentHash,
        status: "ready",
        version: 1,
        indexed_at: now(),
        loc: hashed.loc,
      });
      (prior === undefined ? created : changed).push(path);
    }

    const newDirs = dirCreates.filter((p) => !knownDirs.has(p));
    const directories: FsDirectoryRow[] = newDirs.map((p) => fsDirectoryRow(p, parentDirPath(p)));

    const removals: FsRemoval[] = [
      ...pairedFileRemovals.map((p): FsRemoval => ({ path: p, kind: "file" })),
      ...dirRemovals,
    ];

    if (
      directories.length === 0 &&
      files.length === 0 &&
      removals.length === 0 &&
      moves.length === 0
    ) {
      return;
    }

    let write: WriteReport;
    try {
      write = await deps.store.writeFilesystem({ directories, files, removals, moves });
    } catch (error) {
      hooks.onWarning?.(error instanceof Error ? error.message : String(error));
      return;
    }

    // Reconcile in-memory state to match what was just written.
    for (const d of directories) {
      knownDirs.add(d.path);
    }
    for (const f of files) {
      knownFiles.set(f.path, { contentHash: f.content_hash, parent: f.parent });
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
        knownFiles.set(m.toPath, { contentHash: known.contentHash, parent: m.toParent });
      }
    }

    const changes: NormalizedChange[] = [
      ...created.map((p): NormalizedChange => ({ kind: "created", entry: "file", path: p })),
      ...changed.map((p): NormalizedChange => ({ kind: "changed", entry: "file", path: p })),
      ...newDirs.map((p): NormalizedChange => ({ kind: "created", entry: "directory", path: p })),
      ...removals.map((r): NormalizedChange => ({ kind: "deleted", entry: r.kind, path: r.path })),
      ...moves.map((m): NormalizedChange => ({
        kind: "moved",
        entry: m.kind,
        path: m.toPath,
        fromPath: m.fromPath,
      })),
    ];
    hooks.onBatch?.(changes, write);
  }

  const batcher = new ChangeBatcher<RawEvent>((items) => {
    processBatch(items).catch((error) => {
      hooks.onWarning?.(error instanceof Error ? error.message : String(error));
    });
  });

  const subscription: WatchSubscription = await watcher.subscribe(
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
    await subscription.unsubscribe();
  }

  hooks.signal?.addEventListener("abort", () => {
    void close();
  });

  return { close };
}
