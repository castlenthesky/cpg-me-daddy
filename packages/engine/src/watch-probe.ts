// The engine's node:fs WatchProbe (U4.2.1, controller decision 61): the one window @cpg/watch's
// session has onto the disk (C-WATCH INV-3 keeps node:fs out of packages/watch).

import type { WorkspacePath } from '@cpg/model';
import type { WatchProbe } from '@cpg/watch';

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
export function createWatchProbe(_root: string, _options: WatchProbeOptions = {}): NodeWatchProbe {
  // SEAT: U4.2.1 part a
  throw new Error('SEAT: createWatchProbe lands with U4.2.1 part a');
}
