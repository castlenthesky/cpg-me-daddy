// cpg.config.yaml, from BMO-38 ("the sketch in 03-architecture §9 parses and round-trips"; Linear
// carries the sketch in full, copied verbatim below) and 03-architecture §9 (the file never sets the
// root: C-CLI workspace_root). The reading of "parses and round-trips" (an ambiguity, reported):
//   - the sketch writes alternatives inline (`store: memory | falkor`, `mode: remote | docker`);
//     as YAML those are the literal strings "memory | falkor" and "remote | docker";
//   - so the literal text is valid YAML that round-trips as YAML, but is NOT a valid config: the
//     loader fails loudly, naming the key;
//   - the sketch is a template: each instantiation of its alternatives (2 x 2) parses, validates,
//     and round-trips through stringifyConfigFile, and maps onto ResolvedConfig's keys.
// Owner decision 1A (U2c.2): each consumer switch maps to its own key, so the file may set any of
// them alone, and each carries the file's provenance.

import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ConfigError, resolveConfig } from './resolve';
import { configFileLayer, parseConfigFile, stringifyConfigFile } from './file';

const SKETCH = `version: 1
include: [apps/*, packages/*, services/*]        # default: discovered from manifests, else "."
exclude: ["**/node_modules", "**/dist", "**/__pycache__", "**/.venv"]   # merged with .gitignore
languages: { python: true, typescript: true }
watch: { debounce_ms: 100, ceiling_ms: 500, bulk_threshold_files: 50 }
consumers: { inspect: false, store: memory | falkor, vscode: auto }
store: { falkor: { mode: remote | docker, host: 127.0.0.1, port: 6382, graph: cpg } }
resolve: { per_file_ms: 500, per_site_ms: 250 }
`;
const SRC = '/r/cpg.config.yaml';
const STORES = ['memory', 'falkor'] as const;
const MODES = ['remote', 'docker'] as const;
const INSTANCES = STORES.flatMap((store) => MODES.map((mode) => [store, mode] as const));
const instantiate = (store: string, mode: string): string =>
  SKETCH.replace('memory | falkor', store).replace('remote | docker', mode);

function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  throw new Error('expected a ConfigError, nothing was thrown');
}

describe('the 03-architecture §9 sketch', () => {
  it('is valid YAML whose inline alternatives are literal strings, and round-trips as YAML', () => {
    const value: unknown = parse(SKETCH);
    expect(value).toMatchObject({
      consumers: { store: 'memory | falkor' },
      store: { falkor: { mode: 'remote | docker', host: '127.0.0.1', port: 6382 } },
    });
    expect(parse(stringify(value))).toEqual(value);
  });

  it('as written is not a valid config: the loader names consumers.store, then the mode', () => {
    const e = configError(() => parseConfigFile(SKETCH, SRC));
    expect([e.key, e.layer, e.source]).toEqual(['consumers.store', 'file', SRC]);
    expect(e.message).toContain('store.falkor.mode');
    expect(e.message).toContain(SRC);
  });

  it.each(INSTANCES)('store %s, mode %s: parses to the sketch and round-trips', (store, mode) => {
    const doc = parseConfigFile(instantiate(store, mode), SRC);
    expect(doc).toEqual({
      version: 1,
      include: ['apps/*', 'packages/*', 'services/*'],
      exclude: ['**/node_modules', '**/dist', '**/__pycache__', '**/.venv'],
      languages: { python: true, typescript: true },
      watch: { debounce_ms: 100, ceiling_ms: 500, bulk_threshold_files: 50 },
      consumers: { inspect: false, store, vscode: 'auto' },
      store: { falkor: { mode, host: '127.0.0.1', port: 6382, graph: 'cpg' } },
      resolve: { per_file_ms: 500, per_site_ms: 250 },
    });
    const text = stringifyConfigFile(doc);
    expect(parseConfigFile(text, SRC)).toEqual(doc);
    expect(parse(text)).toEqual(doc);
  });

  it.each(INSTANCES)('store %s, mode %s: maps onto ResolvedConfig keys', (store, mode) => {
    const { layer, warnings } = configFileLayer(
      parseConfigFile(instantiate(store, mode), SRC),
      SRC,
      { vscodeHost: false },
    );
    expect(layer).toEqual({
      layer: 'file',
      source: SRC,
      values: {
        include: ['apps/*', 'packages/*', 'services/*'],
        exclude: ['**/node_modules', '**/dist', '**/__pycache__', '**/.venv'],
        'consumers.inspect': false,
        'consumers.store': store,
        'consumers.vscode': false,
        'store.host': '127.0.0.1',
        'store.port': 6382,
        'store.graph': 'cpg',
        'store.mode': mode,
        'resolve.perFileMs': 500,
        'resolve.perSiteMs': 250,
        'watch.trailingMs': 100,
        'watch.ceilingMs': 500,
        'watch.bulkThresholdFiles': 50,
      },
    });
    // languages has no ResolvedConfig key: accepted, not applied, and said so.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/languages/);

    const r = resolveConfig([{ layer: 'default', source: 'cwd', values: { root: '/w' } }, layer]);
    const file = { layer: 'file', source: SRC };
    expect(r.watch.trailingMs).toEqual({ value: 100, ...file });
    expect(r.store.mode).toEqual({ value: mode, ...file });
    expect(r.consumers).toEqual({
      inspect: { value: false, ...file },
      store: { value: store, ...file },
      vscode: { value: false, ...file },
    });
    expect(r.root).toEqual({ value: '/w', layer: 'default', source: 'cwd' });
  });
});

describe('parseConfigFile', () => {
  it('version alone is a valid file that sets nothing', () => {
    const doc = parseConfigFile('version: 1\n', SRC);
    expect(doc).toEqual({ version: 1 });
    const { layer, warnings } = configFileLayer(doc, SRC, { vscodeHost: false });
    expect(Object.values(layer.values).filter((v) => v !== undefined)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  // Sprint 25 (controller decision 78): the file key is watch.rescan_interval_ms; 0 turns it off.
  it.each([0, 60000])('watch.rescan_interval_ms %j maps to watch.rescanIntervalMs', (ms) => {
    const doc = parseConfigFile(`version: 1\nwatch: { rescan_interval_ms: ${String(ms)} }\n`, SRC);
    const { layer } = configFileLayer(doc, SRC, { vscodeHost: false });
    expect(layer.values['watch.rescanIntervalMs']).toBe(ms);
  });

  it('max_file_size_bytes maps to maxFileSizeBytes', () => {
    const doc = parseConfigFile('version: 1\nmax_file_size_bytes: 1024\n', SRC);
    const { layer } = configFileLayer(doc, SRC, { vscodeHost: false });
    expect(layer.values['maxFileSizeBytes']).toBe(1024);
  });

  it.each([
    ['auto', false, false],
    ['auto', true, true],
    ['true', false, true],
    ['false', true, false],
  ])('consumers.vscode %s with vscodeHost %s resolves to %s', (vscode, vscodeHost, expected) => {
    const doc = parseConfigFile(
      `version: 1\nconsumers: { inspect: true, store: memory, vscode: ${vscode} }\n`,
      SRC,
    );
    const { layer } = configFileLayer(doc, SRC, { vscodeHost });
    expect(layer.values['consumers.vscode']).toBe(expected);
    expect(layer.values['consumers.inspect']).toBe(true);
    expect(layer.values['consumers.store']).toBe('memory');
    expect(layer.values).not.toHaveProperty('consumers');
  });

  it.each([
    ['store', 'consumers: { store: falkor }', { store: 'falkor' }],
    ['inspect', 'consumers: { inspect: true }', { inspect: true }],
    ['vscode', 'consumers: { vscode: true }', { vscode: true }],
    ['none', 'consumers: {}', {}],
  ])('a file setting only %s sets that switch; the others fall through', (_name, line, set) => {
    const doc = parseConfigFile(`version: 1\n${line}\n`, SRC);
    const { layer } = configFileLayer(doc, SRC, { vscodeHost: false });
    const r = resolveConfig([{ layer: 'default', source: 'cwd', values: { root: '/w' } }, layer]);
    const defaults = { inspect: false, store: 'memory', vscode: false };
    for (const key of ['inspect', 'store', 'vscode'] as const) {
      const fromFile = Object.hasOwn(set, key);
      expect(r.consumers[key]).toEqual(
        fromFile
          ? { value: Reflect.get(set, key), layer: 'file', source: SRC }
          : { value: defaults[key], layer: 'default', source: 'built-in' },
      );
    }
  });

  it.each([
    ['no version', 'include: [src]\n', 'version'],
    ['version 2', 'version: 2\n', 'version'],
    ['the file cannot set the root', 'version: 1\nroot: /elsewhere\n', 'root'],
    ['a misspelt key', 'version: 1\nincludes: [src]\n', 'includes'],
    ['a misspelt nested key', 'version: 1\nwatch: { debounce: 5 }\n', 'watch.debounce'],
    [
      'a consumers.store not in the enum',
      'version: 1\nconsumers: { store: none }\n',
      'consumers.store',
    ],
    [
      'a consumers.inspect not a boolean',
      'version: 1\nconsumers: { inspect: auto }\n',
      'consumers.inspect',
    ],
    ['host lives under store.falkor', 'version: 1\nstore: { host: x }\n', 'store.host'],
    [
      'a quoted port is a string',
      'version: 1\nstore: { falkor: { port: "6382" } }\n',
      'store.falkor.port',
    ],
    ['a port above 65535', 'version: 1\nstore: { falkor: { port: 70000 } }\n', 'store.falkor.port'],
    ['a zero debounce', 'version: 1\nwatch: { debounce_ms: 0 }\n', 'watch.debounce_ms'],
    [
      'a negative rescan interval',
      'version: 1\nwatch: { rescan_interval_ms: -1 }\n',
      'watch.rescan_interval_ms',
    ],
    ['YAML 1.2: yes is a string', 'version: 1\nlanguages: { python: yes }\n', 'languages.python'],
    ['include not a list', 'version: 1\ninclude: src\n', 'include'],
    [
      'an extra consumers key',
      'version: 1\nconsumers: { inspect: true, store: memory, vscode: false, x: 1 }\n',
      'consumers.x',
    ],
    [
      'an extra store.falkor key',
      'version: 1\nstore: { falkor: { hots: h } }\n',
      'store.falkor.hots',
    ],
    ['an extra resolve key', 'version: 1\nresolve: { per_file: 5 }\n', 'resolve.per_file'],
    ['a zero per_file_ms', 'version: 1\nresolve: { per_file_ms: 0 }\n', 'resolve.per_file_ms'],
    [
      'a fractional per_site_ms',
      'version: 1\nresolve: { per_site_ms: 1.5 }\n',
      'resolve.per_site_ms',
    ],
    ['a zero max_file_size_bytes', 'version: 1\nmax_file_size_bytes: 0\n', 'max_file_size_bytes'],
    ['an empty host', 'version: 1\nstore: { falkor: { host: "" } }\n', 'store.falkor.host'],
  ])('%s is a ConfigError on its key', (_name, text, key) => {
    const e = configError(() => parseConfigFile(text, SRC));
    expect([e.key, e.layer, e.source]).toEqual([key, 'file', SRC]);
    expect(e.message).toContain(SRC);
  });

  it.each([
    ['an empty file', ''],
    ['a list, not a mapping', '- a\n- b\n'],
    ['a YAML syntax error', 'version: 1\ninclude: [src\n'],
    ['a duplicate key', 'version: 1\nversion: 1\n'],
    // Post-implementation (sabotage): yaml reports an unresolved tag as a warning, not an error.
    ['an unresolved tag (a YAML warning)', 'version: 1\ninclude: [!foo src]\n'],
  ])('%s is a ConfigError on the document', (_name, text) => {
    const e = configError(() => parseConfigFile(text, SRC));
    expect([e.key, e.layer, e.source]).toEqual(['', 'file', SRC]);
    expect(e.message).toContain(SRC);
  });
});
