// SEAT (U3.1.1 part 4, BMO-52): cpg.config.yaml for the extension (controller decision 38), found and read
// as apps/cli/src/config.ts does it, through @cpg/engine's loader. Reads no environment variable.

import type { CpgConfigInput } from '@cpg/engine';

export interface WorkspaceConfig {
  readonly config: CpgConfigInput;
  /** The loader's own (configFileLayer), for the human. */
  readonly warnings: readonly string[];
}

/**
 * The configuration of the workspace at `root` (an absolute path):
 * - the file is the nearest `cpg.config.yaml` (a regular file) from `root` upwards; the search ends
 *   after the first directory that holds `.git`, and at the file system's root;
 * - `consumers.vscode` is true and `consumers.inspect` false whatever the file says, because the
 *   extension is the producer launched with that consumer (decision 38, P-A);
 * - the root is `root`, and every other key is the file's, then the built-in default's.
 *
 * Rejects with ConfigError, naming the file, when it can't be read or isn't valid.
 */
export function loadWorkspaceConfig(_root: string): Promise<WorkspaceConfig> {
  throw new Error('SEAT: loadWorkspaceConfig (U3.1.1 part 4)');
}
