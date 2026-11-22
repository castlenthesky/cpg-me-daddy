// Config loader for the CLI front door (U2c.1, BMO-38): discovers/reads cpg.config.yaml, assembles
// flag, env, file and reserved manifest layers, and resolves them through @cpg/engine's pure resolver.
// Never reads ambient process.env, process.argv or process.cwd (C-CLI I-30).

import { lstat, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  CONFIG_FILE_NAME,
  ConfigError,
  configFileLayer,
  parseConfigFile,
  resolveConfig,
  type ConfigLayerInput,
  type ResolvedConfig,
} from '@cpg/engine';

interface LoadConfigRequest {
  readonly rootLayers: readonly ConfigLayerInput[];
  readonly values: Readonly<Record<string, string | boolean | undefined>>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string | undefined;
}

interface LoadedConfig {
  readonly resolved: ResolvedConfig;
  readonly file: string | null;
  readonly warnings: readonly string[];
}

// The store keys a flag or an env var sets: [flag, env var, key]. CPG_HOST/PORT/GRAPH are the
// archive's falkordb.config.ts names; only these (and CPG_WORKSPACE, in run.ts) are read.
const STORE_SOURCES = [
  ['host', 'CPG_HOST', 'store.host'],
  ['port', 'CPG_PORT', 'store.port'],
  ['graph', 'CPG_GRAPH', 'store.graph'],
] as const;

// A port arrives as text: digits become a number, anything else stays a string so that
// resolveConfig rejects it, naming its layer and source.
function layerOf(
  layer: 'flag' | 'env',
  source: string,
  key: string,
  raw: string,
): ConfigLayerInput {
  const value = key === 'store.port' && /^\d+$/.test(raw) ? Number(raw) : raw;
  return { layer, source, values: { [key]: value } };
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

export async function loadConfig(req: LoadConfigRequest): Promise<LoadedConfig> {
  // REAL
  const root = resolveConfig(req.rootLayers).root.value;

  const flagLayers = STORE_SOURCES.flatMap(([flag, , key]) => {
    const raw = req.values[flag];
    return typeof raw === 'string' ? [layerOf('flag', `--${flag}`, key, raw)] : [];
  });
  const envLayers = STORE_SOURCES.flatMap(([, name, key]) => {
    const raw = req.env[name];
    return raw === undefined ? [] : [layerOf('env', name, key, raw)];
  });

  const configFlag = typeof req.values['config'] === 'string' ? req.values['config'] : undefined;
  const file =
    configFlag !== undefined
      ? req.cwd !== undefined
        ? resolve(req.cwd, configFlag)
        : configFlag
      : await discoverConfigFile(root);

  let fileLayer: ConfigLayerInput | null = null;
  let warnings: readonly string[] = [];
  if (file !== null) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (e: unknown) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new ConfigError('', 'file', file, `${file}: cannot read config file: ${detail}`);
    }
    const doc = parseConfigFile(text, file);
    const built = configFileLayer(doc, file, { vscodeHost: false });
    fileLayer = built.layer;
    warnings = built.warnings;
  }

  // SEAT: manifest discovery is reserved (an empty layer until manifest discovery lands).
  const manifestLayer: ConfigLayerInput = {
    layer: 'manifest',
    source: 'manifests (reserved: no discovery yet)',
    values: {},
  };

  const resolved = resolveConfig([
    ...req.rootLayers,
    ...flagLayers,
    ...envLayers,
    ...(fileLayer !== null ? [fileLayer] : []),
    manifestLayer,
  ]);

  return { resolved, file, warnings };
}
