// REAL (U3.1.1 part 4, BMO-52): C-EXT's FilesystemProbe as the walker admits files (controller decision
// 29; 08-verification §3.1). Plain node: the adapter gives it VS Code's file system.

import { createHash } from 'node:crypto';
import { compileMatcher, type CpgConfigInput } from '@cpg/engine';
import { isWorkspacePath, WORKSPACE_ROOT, type WorkspacePath } from '@cpg/model';
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

const FILE_TYPE = 1;
const DIRECTORY_TYPE = 2;

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
export function workspaceProbe(fs: WorkspaceFileSystem, scope: AdmissionScope): FilesystemProbe {
  const include = compileMatcher(scope.include);
  const exclude = compileMatcher(scope.exclude);

  async function visit(relDir: WorkspacePath): Promise<WorkspacePath[]> {
    let entries: readonly (readonly [string, number])[];
    try {
      entries = await fs.readDirectory(relDir);
    } catch (thrown) {
      if (relDir === WORKSPACE_ROOT) throw thrown;
      return [];
    }

    const sorted = entries.toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const nested = await Promise.all(
      sorted.map(async ([name, type]): Promise<WorkspacePath[]> => {
        const relPath = relDir === WORKSPACE_ROOT ? name : `${relDir}/${name}`;
        if (!isWorkspacePath(relPath)) return [];
        if (type === DIRECTORY_TYPE) {
          if (exclude.test(relPath, true)) return [];
          return visit(relPath);
        }
        if (type !== FILE_TYPE) return [];
        if (exclude.test(relPath, false) || !include.test(relPath, false)) return [];
        try {
          return (await fs.size(relPath)) > scope.maxFileSizeBytes ? [] : [relPath];
        } catch {
          return [];
        }
      }),
    );
    return nested.flat();
  }

  return {
    listFiles: () => visit(WORKSPACE_ROOT),
    async digest(filePath) {
      try {
        const bytes = await fs.readFile(filePath);
        return createHash('sha256').update(bytes).digest('hex');
      } catch {
        return undefined;
      }
    },
  };
}
