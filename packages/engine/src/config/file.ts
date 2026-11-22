// cpg.config.yaml (03-architecture §9): the file's own shape, its parser and writer, and the file
// layer it contributes to resolveConfig. Pure: the front door finds and reads the file (U2c.1).

import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import type { ConfigLayerInput } from '../port';
import {
  CONSUMER_STORE,
  ConfigError,
  GLOB_LIST,
  NON_EMPTY_STRING,
  PORT_SCHEMA,
  POSITIVE_INT,
  STORE_MODE,
} from './resolve';

export const CONFIG_FILE_NAME = 'cpg.config.yaml';

// The file as written: the sketch's snake_case keys and nesting, every object strict. `languages` is
// validated but not applied (ResolvedConfig has no languages key); the file can never set root.
const CONFIG_FILE_SCHEMA = z.strictObject({
  version: z.literal(1),
  include: GLOB_LIST.exactOptional(),
  exclude: GLOB_LIST.exactOptional(),
  max_file_size_bytes: POSITIVE_INT.exactOptional(),
  languages: z.record(z.string(), z.boolean()).exactOptional(),
  watch: z
    .strictObject({
      debounce_ms: POSITIVE_INT.exactOptional(),
      ceiling_ms: POSITIVE_INT.exactOptional(),
      bulk_threshold_files: POSITIVE_INT.exactOptional(),
    })
    .exactOptional(),
  consumers: z
    .strictObject({
      inspect: z.boolean(),
      store: CONSUMER_STORE,
      vscode: z.union([z.boolean(), z.literal('auto')]),
    })
    .exactOptional(),
  store: z
    .strictObject({
      falkor: z
        .strictObject({
          mode: STORE_MODE.exactOptional(),
          host: NON_EMPTY_STRING.exactOptional(),
          port: PORT_SCHEMA.exactOptional(),
          graph: NON_EMPTY_STRING.exactOptional(),
        })
        .exactOptional(),
    })
    .exactOptional(),
  resolve: z
    .strictObject({
      per_file_ms: POSITIVE_INT.exactOptional(),
      per_site_ms: POSITIVE_INT.exactOptional(),
    })
    .exactOptional(),
});

/** The file as written (snake_case, the sketch's nesting). */
export type CpgConfigFile = z.output<typeof CONFIG_FILE_SCHEMA>;

function keyOf(issue: z.core.$ZodIssue): string {
  const parts = issue.path.map(String);
  if (issue.code === 'unrecognized_keys' && issue.keys[0] !== undefined) {
    parts.push(issue.keys[0]);
  }
  return parts.join('.');
}

/** Parses and validates the file's text. Throws ConfigError (layer 'file', source `source`). */
export function parseConfigFile(text: string, source: string): CpgConfigFile {
  // REAL
  let raw: unknown;
  try {
    const doc = parseDocument(text, { logLevel: 'silent' });
    const problem = doc.errors[0] ?? doc.warnings[0];
    if (problem !== undefined) {
      throw problem;
    }
    raw = doc.toJS();
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new ConfigError('', 'file', source, `${source}: ${detail}`);
  }

  const parsed = CONFIG_FILE_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const firstKey = first !== undefined ? keyOf(first) : '';
    const detail = parsed.error.issues
      .map((issue) => `${keyOf(issue)}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(firstKey, 'file', source, `${source}: ${detail}`);
  }

  return parsed.data;
}

export function stringifyConfigFile(doc: CpgConfigFile): string {
  // REAL
  return stringify(doc);
}

/**
 * The file layer: the file's keys mapped to ResolvedConfig paths. `vscodeHost` says whether the
 * front door is the VS Code host, which is what `consumers.vscode: auto` resolves against.
 */
export function configFileLayer(
  doc: CpgConfigFile,
  source: string,
  opts: { readonly vscodeHost: boolean },
): { readonly layer: ConfigLayerInput; readonly warnings: readonly string[] } {
  // REAL
  const { consumers, watch, resolve } = doc;
  const falkor = doc.store?.falkor;
  const values = {
    include: doc.include,
    exclude: doc.exclude,
    maxFileSizeBytes: doc.max_file_size_bytes,
    consumers: consumers && {
      ...consumers,
      vscode: consumers.vscode === 'auto' ? opts.vscodeHost : consumers.vscode,
    },
    'store.host': falkor?.host,
    'store.port': falkor?.port,
    'store.graph': falkor?.graph,
    'store.mode': falkor?.mode,
    'resolve.perFileMs': resolve?.per_file_ms,
    'resolve.perSiteMs': resolve?.per_site_ms,
    'watch.trailingMs': watch?.debounce_ms,
    'watch.ceilingMs': watch?.ceiling_ms,
    'watch.bulkThresholdFiles': watch?.bulk_threshold_files,
  };

  const warnings: string[] =
    doc.languages !== undefined
      ? [`${source}: 'languages' is parsed but not applied (ResolvedConfig has no languages key)`]
      : [];

  return {
    layer: { layer: 'file', source, values },
    warnings,
  };
}
