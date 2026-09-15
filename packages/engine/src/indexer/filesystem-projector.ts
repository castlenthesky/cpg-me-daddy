/**
 * The first, smallest `WatchSink` (`watch/sink.ts`): turns a `ChangeBatch` of
 * `NormalizedChange`s into the filesystem tier's own `FilesystemDelta`
 * (`store/cypher.ts`'s `planFilesystem`) and writes it via
 * `IGraphStore.writeFilesystem`. This is exactly the store-writing code that
 * used to live inside `watch/watch-workspace.ts`, moved out wholesale so the
 * watcher itself never imports a store type — see that file's own module
 * doc. `cpg watch` wires `watcher -> projector -> store`; behaviour is
 * unchanged from before this split, only ownership moved.
 *
 * A "created"/"changed" file change carries only a path, a content hash, and
 * a size (`NormalizedChange` is deliberately graph-ignorant — no `loc`, no
 * resolved `language`, no bytes). This projector re-reads the file once per
 * changed path to derive both; the extra read is the documented cost of
 * keeping the watcher itself store-ignorant (usually served from page
 * cache — this is not the pipeline's bottleneck).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { grammarForPath } from "../parser/grammars";
import type { FsDirectoryRow, FsFileRow, FsMove, FsRemoval } from "../store/cypher";
import type { IGraphStore, WriteReport } from "../store/store";
import type { ChangeBatch, WatchSink } from "../watch/sink";
import { hashBytes } from "../workspace/hash";
import { baseName, parentDirPath, ROOT_DIR_PATH } from "../workspace/paths";

export interface FilesystemProjectorDeps {
  readonly store: IGraphStore;
  /** Absolute workspace root — `NormalizedChange.path` is workspace-relative. */
  readonly root: string;
  /** Injected in tests for a deterministic `FILE.indexed_at`. */
  readonly now?: () => string;
}

export interface FilesystemProjectorHooks {
  /** Fires after every non-empty batch is written. */
  readonly onWrite?: (batch: ChangeBatch, write: WriteReport) => void;
}

function countLoc(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

/** A DIRECTORY's parent, per the filesystem tier's own `"."`-rooted
 *  convention — `undefined` only for the root itself. */
function dirParent(path: string): string | undefined {
  return path === ROOT_DIR_PATH ? undefined : parentDirPath(path);
}

function fsDirectoryRow(path: string): FsDirectoryRow {
  return {
    path,
    name: path === ROOT_DIR_PATH ? ROOT_DIR_PATH : baseName(path),
    parent: dirParent(path),
  };
}

/** Builds the `WatchSink` `cpg watch` (and any future watcher host) feeds into. */
export function filesystemProjector(
  deps: FilesystemProjectorDeps,
  hooks: FilesystemProjectorHooks = {},
): WatchSink {
  const now = deps.now ?? (() => new Date().toISOString());

  return {
    async onBatch(batch: ChangeBatch): Promise<void> {
      const directories: FsDirectoryRow[] = [];
      const files: FsFileRow[] = [];
      const removals: FsRemoval[] = [];
      const moves: FsMove[] = [];

      /* eslint-disable no-await-in-loop */
      for (const change of batch.changes) {
        if (change.kind === "deleted") {
          removals.push({ path: change.path, kind: change.entry });
          continue;
        }
        if (change.kind === "moved") {
          if (change.fromPath === undefined) {
            continue; // Structurally guaranteed by NormalizedChange; guarded for safety.
          }
          moves.push({
            fromPath: change.fromPath,
            toPath: change.path,
            toName: baseName(change.path),
            toParent: parentDirPath(change.path),
            kind: change.entry,
          });
          continue;
        }

        // created / changed
        if (change.entry === "directory") {
          directories.push(fsDirectoryRow(change.path));
          continue;
        }

        const bytes = await readFile(join(deps.root, change.path));
        files.push({
          path: change.path,
          name: baseName(change.path),
          parent: parentDirPath(change.path),
          // The "none" sentinel keeps FILE.language a required (cardinality
          // "one") property with no schema change — same convention as the
          // walker/indexer's own filesystem phase.
          language: grammarForPath(change.path) ?? "none",
          content_hash: change.contentHash ?? hashBytes(bytes),
          status: "ready",
          version: 1,
          indexed_at: now(),
          loc: countLoc(bytes.toString("utf8")),
        });
      }
      /* eslint-enable no-await-in-loop */

      if (
        directories.length === 0 &&
        files.length === 0 &&
        removals.length === 0 &&
        moves.length === 0
      ) {
        return;
      }

      const write = await deps.store.writeFilesystem({ directories, files, removals, moves });
      hooks.onWrite?.(batch, write);
    },
  };
}
