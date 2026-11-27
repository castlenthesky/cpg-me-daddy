// The engine's node:fs WatchProbe (U4.2.1, controller decision 61): the one window @cpg/watch's
// session has onto the disk (C-WATCH INV-3 keeps node:fs out of packages/watch).

import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isWorkspacePath, WORKSPACE_ROOT, type WorkspacePath } from '@cpg/model';
import type { ListedEntry, WatchProbe } from '@cpg/watch';

export interface WatchProbeOptions {
  /**
   * Whether `list` descends into a directory it found. A directory refused here is still listed,
   * but nothing under it is: the session refuses an excluded directory's descendants anyway, and
   * the walker never enters one. Default: every directory is entered.
   */
  readonly enters?: (dir: WorkspacePath) => boolean;
}

export interface NodeWatchProbe extends WatchProbe {
  /**
   * True when the last `stat` or `list` that reached `path` found a symlink; false for a path never
   * seen or last seen as something else. The probe reports a symlink as a `'file'` (decision 47),
   * so the engine's `admit` asks this to apply the walker's symlink policy.
   */
  isSymlink(path: WorkspacePath): boolean;
  /**
   * The file's bytes, `readFile(join(root, path))`: the engine's one read of a live change for the
   * code tier (controller decision 102; 03-architecture §4). Rejects, with the read's error, when the
   * file cannot be read (gone, a directory, no permission). Never hashes (C-WATCH INV-26).
   */
  read(path: WorkspacePath): Promise<Uint8Array>;
}

/**
 * A WatchProbe over the directory `root` (absolute). Every path in and out is a WorkspacePath under
 * it; `'.'` is the root itself.
 * - `stat(path)`: lstat semantics. A directory is `'directory'`, a regular file or a symlink (never
 *   followed) is `'file'`, both with lstat's size. Anything else (a FIFO, a socket, a device), and any
 *   failure, is `undefined`: gone, or nothing the walker would emit.
 * - `list(dir)`: every entry strictly under `dir`, recursively, with the same lstat rules, in any
 *   order. Paths carry no `./` prefix (`list('.')` yields `a.ts`, not `./a.ts`). No symlink is
 *   followed; a directory `enters` refuses is listed but not entered. A directory that cannot be read
 *   contributes nothing under it, and `dir` gone (or not a directory) yields `[]`.
 * - `digest(path)`: the lowercase hex sha256 of the file's bytes (INV-26); `undefined` when it cannot
 *   be read (gone, a directory, no permission), as the walker drops an unreadable file.
 */
export function createWatchProbe(root: string, options: WatchProbeOptions = {}): NodeWatchProbe {
  // REAL
  const symlinks = new Set<WorkspacePath>();
  const { enters } = options;

  async function stat(
    path: WorkspacePath,
  ): Promise<{ readonly entry: 'file' | 'directory'; readonly sizeBytes: number } | undefined> {
    let st;
    try {
      st = await lstat(join(root, path));
    } catch {
      symlinks.delete(path);
      return undefined;
    }
    if (st.isSymbolicLink()) {
      symlinks.add(path);
      return { entry: 'file', sizeBytes: st.size };
    }
    symlinks.delete(path);
    if (st.isDirectory()) return { entry: 'directory', sizeBytes: st.size };
    if (st.isFile()) return { entry: 'file', sizeBytes: st.size };
    return undefined;
  }

  async function list(dir: WorkspacePath): Promise<readonly ListedEntry[]> {
    const dirStat = await stat(dir);
    if (dirStat?.entry !== 'directory') return [];
    const out: ListedEntry[] = [];

    async function walk(current: WorkspacePath): Promise<void> {
      let names: string[];
      try {
        names = await readdir(join(root, current));
      } catch {
        return;
      }
      /* oxlint-disable no-await-in-loop */
      for (const name of names) {
        const child = current === WORKSPACE_ROOT ? name : `${current}/${name}`;
        if (!isWorkspacePath(child)) continue;
        const info = await stat(child);
        if (info === undefined) continue;
        out.push({ path: child, entry: info.entry, sizeBytes: info.sizeBytes });
        if (info.entry === 'directory' && (enters === undefined || enters(child))) {
          await walk(child);
        }
      }
      /* oxlint-enable no-await-in-loop */
    }

    await walk(dir);
    return out;
  }

  async function digest(path: WorkspacePath): Promise<string | undefined> {
    try {
      const bytes = await readFile(join(root, path));
      return createHash('sha256').update(bytes).digest('hex');
    } catch {
      return undefined;
    }
  }

  return {
    stat,
    list,
    digest,
    isSymlink(path: WorkspacePath): boolean {
      return symlinks.has(path);
    },
    async read(path: WorkspacePath): Promise<Uint8Array> {
      // SEAT (U6a.3-3)
      void path;
      throw new Error('SEAT: NodeWatchProbe.read (U6a.3-3)');
    },
  };
}
