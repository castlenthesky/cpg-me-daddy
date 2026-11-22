// The workspace walker, ported from 27361a3:packages/engine/src/workspace/walker.ts (+ hash.ts).
// The cold walk is the WATCH stage's first batch, so it mints `revision_id` here: the sha256 of the
// raw bytes (a CRLF -> LF edit IS a change).

import type { WorkspacePath } from '@cpg/model';

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

export async function walkWorkspace(_options: WalkOptions): Promise<WalkResult> {
  // SEAT: U2a.2a
  throw new Error('SEAT: walkWorkspace is not built yet (U2a.2a)');
}
