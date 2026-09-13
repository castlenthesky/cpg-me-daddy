/**
 * The workspace walker (M0.2): enumerates the source files `cpg index` should
 * parse, honouring includes/excludes and pruning excluded directories before
 * descending into them — the whole reason this doesn't use a "filter a full
 * listing" glob library (see `./glob.ts`'s module doc).
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
  readonly language: GrammarId;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

export interface WalkStats {
  readonly directoriesVisited: number;
  readonly directoriesSkipped: number;
  readonly filesSeen: number;
  readonly filesExcluded: number;
  /** No grammar registered for this extension (e.g. `.js` today — M0.7). */
  readonly filesUnsupported: number;
  readonly filesTooLarge: number;
  readonly symlinksSkipped: number;
}

export interface WalkResult {
  readonly files: readonly FileEntry[];
  readonly stats: WalkStats;
}

function toPosix(relPath: string): string {
  return sep === "/" ? relPath : relPath.split(sep).join("/");
}

/**
 * Walks `options.root`, returning the sorted set of files that pass the
 * include/exclude patterns and have a registered grammar.
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
  const stats = {
    directoriesVisited: 0,
    directoriesSkipped: 0,
    filesSeen: 0,
    filesExcluded: 0,
    filesUnsupported: 0,
    filesTooLarge: 0,
    symlinksSkipped: 0,
  };

  async function visitDir(absDir: string, relDir: string): Promise<void> {
    stats.directoriesVisited++;
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
        await visitDir(absPath, relPath);
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

      const language = grammarForPath(relPath);
      if (language === undefined) {
        stats.filesUnsupported++;
        continue;
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
        language,
        sizeBytes: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
      });
    }
    /* eslint-enable no-await-in-loop */
  }

  await visitDir(options.root, "");

  return { files, stats: { ...stats } };
}
