// REAL (U3.1.1 part 4, BMO-52): cpg.config.yaml for the extension (controller decision 38), found and read
// as apps/cli/src/config.ts does it, through @cpg/engine's loader. Reads no environment variable.

import { lstat, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CONFIG_FILE_NAME,
  ConfigError,
  configFileLayer,
  parseConfigFile,
  resolveConfig,
  toCpgConfigInput,
  type ConfigLayerInput,
  type CpgConfigInput,
} from '@cpg/engine';

export interface WorkspaceConfig {
  readonly config: CpgConfigInput;
  /** The loader's own (configFileLayer), for the human. */
  readonly warnings: readonly string[];
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function discoverConfigFile(dir: string): Promise<string | null> {
  const candidate = join(dir, CONFIG_FILE_NAME);
  if (await isFile(candidate)) return candidate;
  if (await exists(join(dir, '.git'))) return null;
  const parent = dirname(dir);
  if (parent === dir) return null;
  return discoverConfigFile(parent);
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
export async function loadWorkspaceConfig(root: string): Promise<WorkspaceConfig> {
  const file = await discoverConfigFile(root);

  let fileLayer: ConfigLayerInput | null = null;
  let warnings: readonly string[] = [];
  if (file !== null) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (thrown: unknown) {
      const detail = thrown instanceof Error ? thrown.message : String(thrown);
      throw new ConfigError('', 'file', file, `${file}: cannot read config file: ${detail}`);
    }
    const built = configFileLayer(parseConfigFile(text, file), file, { vscodeHost: true });
    fileLayer = built.layer;
    warnings = built.warnings;
  }

  const resolved = resolveConfig([
    {
      layer: 'flag',
      source: 'the VS Code extension',
      values: { 'consumers.vscode': true, 'consumers.inspect': false },
    },
    ...(fileLayer !== null ? [fileLayer] : []),
    { layer: 'default', source: 'workspace folder', values: { root } },
  ]);

  return { config: toCpgConfigInput(resolved), warnings };
}
