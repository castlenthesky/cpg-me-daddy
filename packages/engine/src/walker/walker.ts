// The workspace walker, ported from 27361a3:packages/engine/src/workspace/walker.ts (+ hash.ts).
// The cold walk is the WATCH stage's first batch, so it mints `revision_id` here: the sha256 of the
// raw bytes (a CRLF -> LF edit IS a change).

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isWorkspacePath, WORKSPACE_ROOT, type WorkspacePath } from '@cpg/model';
import { createAdmission, type AdmissionEntry } from './admission';

export interface WalkOptions {
  /** Absolute path to the workspace root. */
  readonly root: string;
  /** The language id that claims a path, or undefined. The composition root passes the registry's. */
  readonly languageOf: (path: string) => string | undefined;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly maxFileSizeBytes?: number;
}

export interface WalkedFile {
  readonly path: WorkspacePath;
  readonly parent: WorkspacePath;
  /** null when no grammar claims the file; the file is still emitted. */
  readonly language: string | null;
  readonly sizeBytes: number;
  /** Lowercase hex sha256 of the raw bytes. */
  readonly revision_id: string;
}

export interface WalkedDirectory {
  /** `'.'` for the root. */
  readonly path: WorkspacePath;
  /** undefined only for the root. */
  readonly parent: WorkspacePath | undefined;
}

/** `filesSeen === files.length + filesExcluded + filesTooLarge + filesFailed`. */
export interface WalkStats {
  readonly directoriesVisited: number;
  readonly directoriesSkipped: number;
  readonly filesSeen: number;
  readonly filesExcluded: number;
  /** Emitted files with `language: null` (a subset of `files`, not a separate bucket). */
  readonly filesUnsupported: number;
  readonly filesTooLarge: number;
  /** Seen, admitted, but unreadable (a race with a delete, permissions). */
  readonly filesFailed: number;
  readonly symlinksSkipped: number;
}

export interface WalkResult {
  /** Depth-first, entries sorted by name (UTF-16 code units) within each directory. */
  readonly files: readonly WalkedFile[];
  /** Every visited directory including the root, in the same descent order. */
  readonly directories: readonly WalkedDirectory[];
  readonly stats: WalkStats;
}

export async function walkWorkspace(options: WalkOptions): Promise<WalkResult> {
  // REAL
  const admission = createAdmission(options);

  const files: WalkedFile[] = [];
  const directories: WalkedDirectory[] = [];
  const stats = {
    directoriesVisited: 0,
    directoriesSkipped: 0,
    filesSeen: 0,
    filesExcluded: 0,
    filesUnsupported: 0,
    filesTooLarge: 0,
    filesFailed: 0,
    symlinksSkipped: 0,
  };

  async function visitDir(
    absDir: string,
    relDir: WorkspacePath,
    parent: WorkspacePath | undefined,
  ): Promise<void> {
    stats.directoriesVisited++;
    directories.push({ path: relDir, parent });
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      // Unreadable directory (permissions, race with a concurrent delete):
      // skip it rather than fail the whole walk over one entry.
      return;
    }

    const sorted = entries.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    // Sequential by design: depth-first deterministic ordering across platforms.
    /* oxlint-disable no-await-in-loop */
    for (const entry of sorted) {
      const relPath = relDir === WORKSPACE_ROOT ? entry.name : `${relDir}/${entry.name}`;
      if (!isWorkspacePath(relPath)) {
        continue;
      }
      const absPath = join(absDir, entry.name);

      const kind: AdmissionEntry | undefined = entry.isSymbolicLink()
        ? 'symlink'
        : entry.isDirectory()
          ? 'directory'
          : entry.isFile()
            ? 'file'
            : undefined;
      if (kind === undefined) {
        // Sockets, FIFOs, devices: never source, never worth counting.
        continue;
      }

      const verdict = admission.check(relPath, kind);
      if (verdict === 'symlink') {
        stats.symlinksSkipped++;
        continue;
      }

      if (kind === 'directory') {
        if (verdict === 'excluded') {
          stats.directoriesSkipped++;
          continue;
        }
        await visitDir(absPath, relPath, relDir);
        continue;
      }

      stats.filesSeen++;

      if (verdict === 'excluded') {
        stats.filesExcluded++;
        continue;
      }

      let fileStat;
      try {
        fileStat = await stat(absPath);
      } catch {
        stats.filesFailed++;
        continue;
      }

      if (admission.check(relPath, 'file', fileStat.size) === 'too-large') {
        stats.filesTooLarge++;
        continue;
      }

      let bytes: Buffer;
      try {
        bytes = await readFile(absPath);
      } catch {
        stats.filesFailed++;
        continue;
      }

      const language = options.languageOf(relPath) ?? null;
      if (language === null) {
        stats.filesUnsupported++;
      }

      const revision_id = createHash('sha256').update(bytes).digest('hex');
      files.push({
        path: relPath,
        parent: relDir,
        language,
        sizeBytes: bytes.byteLength,
        revision_id,
      });
    }
    /* oxlint-enable no-await-in-loop */
  }

  await visitDir(options.root, WORKSPACE_ROOT, undefined);

  return { files, directories, stats: { ...stats } };
}
