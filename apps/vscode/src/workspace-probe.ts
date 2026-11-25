// SEAT (U3.1.1 part 4, BMO-52): C-EXT's FilesystemProbe as the walker admits files (controller decision
// 29; 08-verification §3.1). Plain node: the adapter gives it VS Code's file system.

import type { CpgConfigInput } from '@cpg/engine';
import type { WorkspacePath } from '@cpg/model';
import type { FilesystemProbe } from './contract';

/** What the probe reads, on one workspace. Every call rejects when it cannot answer. */
export interface WorkspaceFileSystem {
  /**
   * The names in a directory, with vscode.FileType's numbers: 1 file, 2 directory, 0 anything else, and
   * 64 added for a symbolic link. `'.'` is the root.
   */
  readDirectory(path: WorkspacePath): Promise<readonly (readonly [name: string, type: number])[]>;
  /** A file's size in bytes. */
  size(path: WorkspacePath): Promise<number>;
  readFile(path: WorkspacePath): Promise<Uint8Array>;
}

/** The walk scope the graph was indexed with. */
export type AdmissionScope = Pick<CpgConfigInput, 'include' | 'exclude' | 'maxFileSizeBytes'>;

/**
 * The files walkWorkspace admits under `scope`, read through `fs`.
 *
 * `listFiles`: walkWorkspace's rules and order (depth-first, names in UTF-16 code-unit order).
 * - An excluded directory is never read. `exclude` and `include` are compileMatcher's.
 * - Only type 1 is a file and only type 2 a directory, so symbolic links are skipped.
 * - A name that makes no WorkspacePath, a file over `maxFileSizeBytes`, a file whose size can't be
 *   read and a directory below the root that can't be read are skipped.
 * - A root that can't be read rejects: nothing was listed, so nothing may pass (decision 29).
 *
 * The walker also skips a file it can't read. listFiles reads no contents, so it lists that file, and
 * `digest` answers undefined for it (verifyPayload admits a file only when it has a digest).
 *
 * `digest`: lowercase hex sha256 of the bytes, the walker's revision_id. undefined, and never a
 * rejection, for a file that is gone or can't be read.
 */
export function workspaceProbe(_fs: WorkspaceFileSystem, _scope: AdmissionScope): FilesystemProbe {
  throw new Error('SEAT: workspaceProbe (U3.1.1 part 4)');
}
