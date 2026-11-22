// resolveConfig (C-CLI): the pure merge of the config layers into one ResolvedConfig, every key with
// its layer and source. Front-door agnostic: it reads no env, argv, cwd or file (U2c.1).

import { z } from 'zod';
import type {
  ConfigLayer,
  ConfigLayerInput,
  CpgConfigInput,
  Provenanced,
  ResolvedConfig,
} from '../port';
import {
  DEFAULT_EXCLUDES,
  DEFAULT_INCLUDES,
  DEFAULT_MAX_FILE_SIZE_BYTES,
} from '../walker/defaults';

/** C-CLI: rank 0 wins. */
export const CONFIG_PRECEDENCE: readonly ConfigLayer[] = [
  'flag',
  'env',
  'file',
  'manifest',
  'default',
];

/** Built-in defaults for every ResolvedConfig key except root (which has no built-in default). */
export const CONFIG_DEFAULTS = {
  include: DEFAULT_INCLUDES,
  exclude: DEFAULT_EXCLUDES,
  maxFileSizeBytes: DEFAULT_MAX_FILE_SIZE_BYTES,
  consumers: { inspect: false, store: 'memory', vscode: false },
  'store.host': '127.0.0.1',
  'store.port': 6382,
  'store.graph': 'cpg',
  'store.mode': 'remote',
  queryTimeoutMs: 30000,
  'resolve.perFileMs': 500,
  'resolve.perSiteMs': 250,
  'watch.trailingMs': 100,
  'watch.ceilingMs': 500,
  'watch.bulkThresholdFiles': 50,
} as const;

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

export const NON_EMPTY_STRING = z.string().min(1);
export const POSITIVE_INT = z.number().int().min(1);
export const PORT_SCHEMA = z.number().int().min(1).max(65535);
export const GLOB_LIST = z.array(NON_EMPTY_STRING);
export const STORE_MODE = z.enum(['remote', 'docker']);
export const CONSUMER_STORE = z.enum(['memory', 'falkor']);

const KEY_SCHEMAS = {
  root: NON_EMPTY_STRING,
  include: GLOB_LIST,
  exclude: GLOB_LIST,
  maxFileSizeBytes: POSITIVE_INT,
  consumers: z.strictObject({
    inspect: z.boolean(),
    store: CONSUMER_STORE,
    vscode: z.boolean(),
  }),
  'store.host': NON_EMPTY_STRING,
  'store.port': PORT_SCHEMA,
  'store.graph': NON_EMPTY_STRING,
  'store.mode': STORE_MODE,
  queryTimeoutMs: POSITIVE_INT,
  'resolve.perFileMs': POSITIVE_INT,
  'resolve.perSiteMs': POSITIVE_INT,
  'watch.trailingMs': POSITIVE_INT,
  'watch.ceilingMs': POSITIVE_INT,
  'watch.bulkThresholdFiles': POSITIVE_INT,
} as const;

type ConfigKey = keyof typeof KEY_SCHEMAS;
type KeyValue<K extends ConfigKey> = z.output<(typeof KEY_SCHEMAS)[K]>;

function isConfigKey(key: string): key is ConfigKey {
  return Object.hasOwn(KEY_SCHEMAS, key);
}

const rankOf = (layer: ConfigLayer): number => CONFIG_PRECEDENCE.indexOf(layer);

export function resolveConfig(layers: readonly ConfigLayerInput[]): ResolvedConfig {
  // REAL
  const allLayers: readonly ConfigLayerInput[] = [
    ...layers,
    { layer: 'default', source: 'built-in', values: CONFIG_DEFAULTS },
  ];
  const sorted = allLayers.toSorted((a, b) => rankOf(a.layer) - rankOf(b.layer));

  const winners = new Map<ConfigKey, Provenanced<unknown>>();

  for (const entry of sorted) {
    for (const [key, raw] of Object.entries(entry.values)) {
      if (raw === undefined) continue;
      if (!isConfigKey(key)) {
        throw new ConfigError(
          key,
          entry.layer,
          entry.source,
          `${entry.source}: unknown config key '${key}'`,
        );
      }
      const parsed = KEY_SCHEMAS[key].safeParse(raw);
      if (!parsed.success) {
        const detail = parsed.error.issues.map((i) => i.message).join('; ');
        throw new ConfigError(
          key,
          entry.layer,
          entry.source,
          `${entry.source}: invalid ${key}: ${detail}`,
        );
      }
      if (!winners.has(key)) {
        winners.set(key, {
          value: parsed.data,
          layer: entry.layer,
          source: entry.source,
        });
      }
    }
  }

  function pick<K extends ConfigKey>(
    key: K,
    schema: z.ZodType<KeyValue<K>>,
  ): Provenanced<KeyValue<K>> {
    const hit = winners.get(key);
    if (hit === undefined) {
      throw new ConfigError(
        key,
        'default',
        'built-in',
        `built-in: missing required config key '${key}'`,
      );
    }
    return { value: schema.parse(hit.value), layer: hit.layer, source: hit.source };
  }

  return {
    root: pick('root', KEY_SCHEMAS.root),
    include: pick('include', KEY_SCHEMAS.include),
    exclude: pick('exclude', KEY_SCHEMAS.exclude),
    maxFileSizeBytes: pick('maxFileSizeBytes', KEY_SCHEMAS.maxFileSizeBytes),
    consumers: pick('consumers', KEY_SCHEMAS.consumers),
    store: {
      host: pick('store.host', KEY_SCHEMAS['store.host']),
      port: pick('store.port', KEY_SCHEMAS['store.port']),
      graph: pick('store.graph', KEY_SCHEMAS['store.graph']),
      mode: pick('store.mode', KEY_SCHEMAS['store.mode']),
    },
    queryTimeoutMs: pick('queryTimeoutMs', KEY_SCHEMAS.queryTimeoutMs),
    resolve: {
      perFileMs: pick('resolve.perFileMs', KEY_SCHEMAS['resolve.perFileMs']),
      perSiteMs: pick('resolve.perSiteMs', KEY_SCHEMAS['resolve.perSiteMs']),
    },
    watch: {
      trailingMs: pick('watch.trailingMs', KEY_SCHEMAS['watch.trailingMs']),
      ceilingMs: pick('watch.ceilingMs', KEY_SCHEMAS['watch.ceilingMs']),
      bulkThresholdFiles: pick('watch.bulkThresholdFiles', KEY_SCHEMAS['watch.bulkThresholdFiles']),
    },
  };
}

export function toCpgConfigInput(resolved: ResolvedConfig): CpgConfigInput {
  // REAL
  return {
    root: resolved.root.value,
    include: [...resolved.include.value],
    exclude: [...resolved.exclude.value],
    maxFileSizeBytes: resolved.maxFileSizeBytes.value,
    consumers: { ...resolved.consumers.value },
    store: {
      host: resolved.store.host.value,
      port: resolved.store.port.value,
      graph: resolved.store.graph.value,
      mode: resolved.store.mode.value,
    },
    queryTimeoutMs: resolved.queryTimeoutMs.value,
    resolve: {
      perFileMs: resolved.resolve.perFileMs.value,
      perSiteMs: resolved.resolve.perSiteMs.value,
    },
    watch: {
      trailingMs: resolved.watch.trailingMs.value,
      ceilingMs: resolved.watch.ceilingMs.value,
      bulkThresholdFiles: resolved.watch.bulkThresholdFiles.value,
    },
  };
}
