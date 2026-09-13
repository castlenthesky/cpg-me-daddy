/**
 * The workspace walker (M0.2): enumerates every non-ignored file and
 * directory, honouring includes/excludes and pruning excluded directories
 * before descending into them — the whole reason this doesn't use a "filter a
 * full listing" glob library (see `./glob.ts`'s module doc).
 *
 * Every non-ignored file is emitted, not just parseable source — the
 * filesystem tier (DIRECTORY/FILE/HAS_ENTRY) covers the whole workspace tree.
 * `FileEntry.language` is `null` for a file with no registered grammar.
 */
import { readdir, stat } from "node:fs/promises";
import { join, sep } from "node:path";

import { type GrammarId, grammarForPath } from "../parser/grammars";
import { DEFAULT_EXCLUDES, DEFAULT_INCLUDES, DEFAULT_MAX_FILE_SIZE_BYTES } from "./defaults";
import { compileMatcher } from "./glob";

export interface WalkOptions {
  /** Absolute filesystem path to the workspace root. */
  readonly root: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  /** Files larger than this are skipped. Default `DEFAULT_MAX_FILE_SIZE_BYTES`. */
  readonly maxFileSizeBytes?: number;
  /** Default `false` — cycles and dependency symlink farms aren't worth the inode bookkeeping yet. */
  readonly followSymlinks?: boolean;
}

export interface FileEntry {
  /** Workspace-relative, POSIX separators, no leading slash. Both the id
   *  prefix and the `file` property every extracted node carries — a native-
   *  separator path here would silently corrupt every downstream id. */
  readonly path: string;
  readonly absolutePath: string;
  /** The containing `DirEntry.path` — `"."` for a file at the workspace root. */
  readonly parent: string;
  /**
   * `null` when no grammar is registered for this extension (e.g. `README.md`,
   * `package.json`). Every non-ignored file still gets an entry — the
   * filesystem tier (DIRECTORY/FILE/HAS_ENTRY) covers the whole tree, not
   * just parseable source (see the filesystem-tier plan, indexer/index-workspace.ts).
   */
  readonly language: GrammarId | null;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

/**
 * One workspace directory the walk visited (including the root, at `path:
 * "."`). Emitted alongside `FileEntry` so a caller can build the
 * DIRECTORY/HAS_ENTRY filesystem tier without re-walking.
 */
export interface DirEntry {
  /** Workspace-relative, POSIX separators. `"."` for the workspace root. */
  readonly path: string;
  readonly absolutePath: string;
  /** `undefined` only for the root — nothing points a HAS_ENTRY edge at it. */
  readonly parent: string | undefined;
}

export interface WalkStats {
  readonly directoriesVisited: number;
  readonly directoriesSkipped: number;
  readonly filesSeen: number;
  readonly filesExcluded: number;
  /** No grammar registered for this extension (e.g. `README.md`). Still walked and counted — not excluded. */
  readonly filesUnsupported: number;
  readonly filesTooLarge: number;
  readonly symlinksSkipped: number;
}

export interface WalkResult {
  readonly files: readonly FileEntry[];
  /** Every visited directory, including the root. Sorted the same way `files` is: by descent order. */
  readonly directories: readonly DirEntry[];
  readonly stats: WalkStats;
}

function toPosix(relPath: string): string {
  return sep === "/" ? relPath : relPath.split(sep).join("/");
}

/** `""` (the internal root sentinel `visitDir` uses) maps to the DIRECTORY convention `"."`. */
function dirPath(relDir: string): string {
  return relDir === "" ? "." : relDir;
}

/**
 * Walks `options.root`, returning the sorted set of files and directories
 * that pass the include/exclude patterns.
 *
 * Directory entries are sorted by name before descending — filesystem order
 * is not stable across platforms, and the M0.2 gate demands an
 * exactly-asserted file list.
 */
export async function walkWorkspace(options: WalkOptions): Promise<WalkResult> {
  const include = compileMatcher(options.include ?? DEFAULT_INCLUDES);
  const exclude = compileMatcher(options.exclude ?? DEFAULT_EXCLUDES);
  const maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const followSymlinks = options.followSymlinks ?? false;

  const files: FileEntry[] = [];
  const directories: DirEntry[] = [];
  const stats = {
    directoriesVisited: 0,
    directoriesSkipped: 0,
    filesSeen: 0,
    filesExcluded: 0,
    filesUnsupported: 0,
    filesTooLarge: 0,
    symlinksSkipped: 0,
  };

  async function visitDir(
    absDir: string,
    relDir: string,
    parent: string | undefined,
  ): Promise<void> {
    stats.directoriesVisited++;
    directories.push({ path: dirPath(relDir), absolutePath: absDir, parent });
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      // Unreadable directory (permissions, race with a concurrent delete):
      // skip it silently rather than fail the whole walk over one entry.
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    // Sequential by design: the M0.2 gate demands an exactly-asserted,
    // deterministically-ordered file list. Parallelizing the descent would
    // mean buffering every subtree's results and reassembling sorted order
    // afterward, for a directory walk that isn't the pipeline's bottleneck
    // (parsing is) — not worth the complexity on a correctness-critical path.
    /* eslint-disable no-await-in-loop */
    for (const entry of entries) {
      const relPath = toPosix(relDir === "" ? entry.name : `${relDir}/${entry.name}`);
      const absPath = join(absDir, entry.name);

      if (entry.isSymbolicLink()) {
        if (!followSymlinks) {
          stats.symlinksSkipped++;
          continue;
        }
      }

      if (entry.isDirectory()) {
        if (exclude.test(relPath, true)) {
          stats.directoriesSkipped++;
          continue;
        }
        await visitDir(absPath, relPath, dirPath(relDir));
        continue;
      }

      if (!entry.isFile()) {
        // Sockets, FIFOs, devices: never source, never worth counting.
        continue;
      }

      stats.filesSeen++;

      if (exclude.test(relPath, false) || !include.test(relPath, false)) {
        stats.filesExcluded++;
        continue;
      }

      // Every non-ignored file gets an entry, parseable or not — the
      // filesystem tier (DIRECTORY/FILE/HAS_ENTRY) covers the whole tree.
      // `filesUnsupported` stays purely informational (a report count), no
      // longer a reason to exclude.
      const language = grammarForPath(relPath) ?? null;
      if (language === null) {
        stats.filesUnsupported++;
      }

      let fileStat;
      try {
        fileStat = await stat(absPath);
      } catch {
        continue;
      }
      if (fileStat.size > maxFileSizeBytes) {
        stats.filesTooLarge++;
        continue;
      }

      files.push({
        path: relPath,
        absolutePath: absPath,
        parent: dirPath(relDir),
        language,
        sizeBytes: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
      });
    }
    /* eslint-enable no-await-in-loop */
  }

  await visitDir(options.root, "", undefined);

  return { files, directories, stats: { ...stats } };
}
