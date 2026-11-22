// cpg.config.yaml (03-architecture §9): the file's own shape, its parser and writer, and the file
// layer it contributes to resolveConfig. Pure: the front door finds and reads the file (U2c.1).

import type { ConfigLayerInput } from '../port';

export const CONFIG_FILE_NAME = 'cpg.config.yaml';

/** The file as written (snake_case, the sketch's nesting). */
export interface CpgConfigFile {
  readonly version: 1;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly max_file_size_bytes?: number;
  /** Parsed and validated, not applied: ResolvedConfig has no languages key. */
  readonly languages?: Readonly<Record<string, boolean>>;
  readonly watch?: {
    readonly debounce_ms?: number;
    readonly ceiling_ms?: number;
    readonly bulk_threshold_files?: number;
  };
  readonly consumers?: {
    readonly inspect: boolean;
    readonly store: 'memory' | 'falkor';
    readonly vscode: boolean | 'auto';
  };
  readonly store?: {
    readonly falkor?: {
      readonly mode?: 'remote' | 'docker';
      readonly host?: string;
      readonly port?: number;
      readonly graph?: string;
    };
  };
  readonly resolve?: { readonly per_file_ms?: number; readonly per_site_ms?: number };
}

/** Parses and validates the file's text. Throws ConfigError (layer 'file', source `source`). */
export function parseConfigFile(_text: string, _source: string): CpgConfigFile {
  // SEAT: U2c.1 red
  throw new Error('SEAT: parseConfigFile lands in U2c.1');
}

export function stringifyConfigFile(_doc: CpgConfigFile): string {
  // SEAT: U2c.1 red
  throw new Error('SEAT: stringifyConfigFile lands in U2c.1');
}

/**
 * The file layer: the file's keys mapped to ResolvedConfig paths. `vscodeHost` says whether the
 * front door is the VS Code host, which is what `consumers.vscode: auto` resolves against.
 */
export function configFileLayer(
  _doc: CpgConfigFile,
  _source: string,
  _opts: { readonly vscodeHost: boolean },
): { readonly layer: ConfigLayerInput; readonly warnings: readonly string[] } {
  // SEAT: U2c.1 red
  throw new Error('SEAT: configFileLayer lands in U2c.1');
}
