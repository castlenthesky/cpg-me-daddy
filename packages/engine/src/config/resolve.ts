// resolveConfig (C-CLI): the pure merge of the config layers into one ResolvedConfig, every key with
// its layer and source. Front-door agnostic: it reads no env, argv, cwd or file (U2c.1).

import type { ConfigLayer, ConfigLayerInput, CpgConfigInput, ResolvedConfig } from '../port';

/** C-CLI: rank 0 wins. */
export const CONFIG_PRECEDENCE: readonly ConfigLayer[] = [
  'flag',
  'env',
  'file',
  'manifest',
  'default',
];

/** A value a layer supplied that is not a valid config value, or a key no layer may set. */
export class ConfigError extends Error {
  constructor(
    /** The key as written in its layer: a ResolvedConfig path, or the file's own key path. */
    readonly key: string,
    readonly layer: ConfigLayer,
    readonly source: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function resolveConfig(_layers: readonly ConfigLayerInput[]): ResolvedConfig {
  // SEAT: U2c.1 red
  throw new Error('SEAT: resolveConfig lands in U2c.1');
}

export function toCpgConfigInput(_resolved: ResolvedConfig): CpgConfigInput {
  // SEAT: U2c.1 red
  throw new Error('SEAT: toCpgConfigInput lands in U2c.1');
}
