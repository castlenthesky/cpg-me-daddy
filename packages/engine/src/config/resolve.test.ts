// resolveConfig, from BMO-38 ("pure; layers flag > env (CPG_*) > file > manifest (slot reserved,
// empty) > default; every key carries {value, layer, source}") and C-CLI (Provenanced, ResolvedConfig,
// I-25). Expected defaults come from the sources, never from the code:
//   - 03-architecture §9 sketch: watch 100/500/50, store.falkor 127.0.0.1:6382 graph cpg,
//     resolve 500/250, consumers.inspect false; C-WATCH trailingMs 100 / ceilingMs 500;
//     C-RESOLVE ResolveBudget perSiteMs 250 / perFileMs 500; C-CLI DEFAULT_STORE_PORT 6382 (I-16).
//   - include: the sketch's "." (the whole root), spelled `**/*` in the walker's glob dialect;
//     exclude and the 2 MiB size cap are the walker's defaults (U2a.2a).
//   - consumers.store memory (falkor is U5), vscode false (the CLI is headless), store mode remote
//     (the sketch's first alternative; the archive's defineCpgDevFalkorConfig).
//   - queryTimeoutMs 30000: FalkorDB's default query timeout (03-architecture §11, M-FALKOR-timeout).

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigLayer, ConfigLayerInput } from '../port';
import { DEFAULT_EXCLUDES } from '../walker/defaults';
import { ConfigError, resolveConfig, toCpgConfigInput } from './resolve';

const at = (
  layer: ConfigLayer,
  source: string,
  values: Record<string, unknown>,
): ConfigLayerInput => ({ layer, source, values });
const CWD = at('default', 'cwd', { root: '/w' });
const builtIn = <T>(value: T) => ({ value, layer: 'default', source: 'built-in' });
const f = <T>(value: T) => ({ value, layer: 'file', source: 'F' });

/** The layers in contract order, written out (not imported from the code under test). */
const ORDER: readonly ConfigLayer[] = ['flag', 'env', 'file', 'manifest', 'default'];
const PAIRS = ORDER.flatMap((hi, i) => ORDER.slice(i + 1).map((lo) => [hi, lo] as const));

function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  throw new Error('expected a ConfigError, nothing was thrown');
}

/** The value at a dotted ResolvedConfig path. */
function leaf(r: unknown, key: string): unknown {
  let v: unknown = r;
  for (const k of key.split('.')) {
    v = typeof v === 'object' && v !== null ? Reflect.get(v, k) : undefined;
  }
  return v;
}

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null) {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveConfig: built-in defaults', () => {
  it('every key but root comes from the built-in default layer, with the spec values', () => {
    expect(resolveConfig([CWD])).toEqual({
      root: { value: '/w', layer: 'default', source: 'cwd' },
      include: builtIn(['**/*']),
      exclude: builtIn([...DEFAULT_EXCLUDES]),
      maxFileSizeBytes: builtIn(2 * 1024 * 1024),
      consumers: builtIn({ inspect: false, store: 'memory', vscode: false }),
      store: {
        host: builtIn('127.0.0.1'),
        port: builtIn(6382),
        graph: builtIn('cpg'),
        mode: builtIn('remote'),
      },
      queryTimeoutMs: builtIn(30000),
      resolve: { perFileMs: builtIn(500), perSiteMs: builtIn(250) },
      watch: { trailingMs: builtIn(100), ceilingMs: builtIn(500), bulkThresholdFiles: builtIn(50) },
    });
  });

  it('root has no built-in default: no layer setting it is a ConfigError on root', () => {
    const e = configError(() => resolveConfig([at('env', 'CPG_HOST', { 'store.host': 'h' })]));
    expect(e.key).toBe('root');
  });

  it('a manifest layer with no values (the reserved slot) changes nothing', () => {
    expect(resolveConfig([CWD, at('manifest', 'manifests', {})])).toEqual(resolveConfig([CWD]));
  });
});

describe('resolveConfig: precedence flag > env > file > manifest > default', () => {
  it.each(PAIRS)('%s beats %s, in either array order', (hi, lo) => {
    const high = at(hi, `src-${hi}`, { 'store.host': `host-${hi}` });
    const low = at(lo, `src-${lo}`, { 'store.host': `host-${lo}` });
    for (const layers of [
      [CWD, high, low],
      [low, high, CWD],
    ]) {
      expect(resolveConfig(layers).store.host).toEqual({
        value: `host-${hi}`,
        layer: hi,
        source: `src-${hi}`,
      });
    }
  });

  it('within one layer the earlier entry wins (--workspace before the positional)', () => {
    const r = resolveConfig([
      at('flag', '--workspace', { root: '/flag' }),
      at('flag', '<root>', { root: '/pos' }),
      at('env', 'CPG_WORKSPACE', { root: '/env' }),
      CWD,
    ]);
    expect(r.root).toEqual({ value: '/flag', layer: 'flag', source: '--workspace' });
  });

  it('a caller default-layer entry beats the built-in default', () => {
    const r = resolveConfig([CWD, at('default', 'host-default', { 'store.graph': 'g' })]);
    expect(r.store.graph).toEqual({ value: 'g', layer: 'default', source: 'host-default' });
  });

  it('keys resolve independently, each with its own provenance', () => {
    const r = resolveConfig([
      CWD,
      at('file', '/r/cpg.config.yaml', {
        'store.host': 'fh',
        'store.port': 7001,
        include: ['src'],
      }),
      at('flag', '--host', { 'store.host': 'flagged' }),
      at('env', 'CPG_PORT', { 'store.port': 7002 }),
    ]);
    expect(r.store.host).toEqual({ value: 'flagged', layer: 'flag', source: '--host' });
    expect(r.store.port).toEqual({ value: 7002, layer: 'env', source: 'CPG_PORT' });
    expect(r.store.graph).toEqual(builtIn('cpg'));
    expect(r.include).toEqual({ value: ['src'], layer: 'file', source: '/r/cpg.config.yaml' });
    expect(r.exclude).toEqual(builtIn([...DEFAULT_EXCLUDES]));
  });

  it('an undefined value is unset: the key falls through to the next layer', () => {
    const r = resolveConfig([
      CWD,
      at('flag', '--host', { 'store.host': undefined }),
      at('env', 'CPG_HOST', { 'store.host': 'e' }),
    ]);
    expect(r.store.host).toEqual({ value: 'e', layer: 'env', source: 'CPG_HOST' });
  });

  it('every ResolvedConfig key can be set from a layer', () => {
    const values = {
      root: '/r',
      include: ['a/**'],
      exclude: ['b/**'],
      maxFileSizeBytes: 10,
      consumers: { inspect: true, store: 'falkor', vscode: true },
      'store.host': 'h',
      'store.port': 1,
      'store.graph': 'g',
      'store.mode': 'docker',
      queryTimeoutMs: 11,
      'resolve.perFileMs': 12,
      'resolve.perSiteMs': 13,
      'watch.trailingMs': 14,
      'watch.ceilingMs': 15,
      'watch.bulkThresholdFiles': 16,
    };
    expect(resolveConfig([at('file', 'F', values)])).toEqual({
      root: f('/r'),
      include: f(['a/**']),
      exclude: f(['b/**']),
      maxFileSizeBytes: f(10),
      consumers: f({ inspect: true, store: 'falkor', vscode: true }),
      store: { host: f('h'), port: f(1), graph: f('g'), mode: f('docker') },
      queryTimeoutMs: f(11),
      resolve: { perFileMs: f(12), perSiteMs: f(13) },
      watch: { trailingMs: f(14), ceilingMs: f(15), bulkThresholdFiles: f(16) },
    });
  });
});

describe('resolveConfig: validation (a failure is never swallowed)', () => {
  it('an unknown key is a ConfigError naming the key, layer and source', () => {
    const e = configError(() => resolveConfig([CWD, at('env', 'CPG_X', { 'store.hots': 'h' })]));
    expect([e.key, e.layer, e.source]).toEqual(['store.hots', 'env', 'CPG_X']);
  });

  it.each([
    ['root', ''],
    ['root', 7],
    ['include', 'src'],
    ['include', [1]],
    ['exclude', ['']],
    ['maxFileSizeBytes', 0],
    ['maxFileSizeBytes', 1.5],
    ['maxFileSizeBytes', '10'],
    ['consumers', { inspect: true, store: 'memory' }],
    ['consumers', { inspect: true, store: 'memory | falkor', vscode: false }],
    ['consumers', { inspect: 'yes', store: 'memory', vscode: false }],
    ['consumers', { inspect: true, store: 'memory', vscode: 'auto' }],
    ['consumers', { inspect: true, store: 'memory', vscode: false, extra: 1 }],
    ['store.host', ''],
    ['store.port', 0],
    ['store.port', 65536],
    ['store.port', '6382'],
    ['store.port', 1.5],
    ['store.graph', ''],
    ['store.mode', 'remote | docker'],
    ['queryTimeoutMs', -1],
    ['queryTimeoutMs', 0],
    ['resolve.perFileMs', 0],
    ['resolve.perSiteMs', 2.5],
    ['watch.trailingMs', 0],
    ['watch.ceilingMs', null],
    ['watch.bulkThresholdFiles', 0],
  ])('%s = %j is a ConfigError on that key', (key, bad) => {
    const e = configError(() => resolveConfig([CWD, at('env', 'SRC', { [key]: bad })]));
    expect([e.key, e.layer, e.source]).toEqual([key, 'env', 'SRC']);
    expect(e.message).toContain(key);
  });

  it.each([
    ['store.port', 1],
    ['store.port', 65535],
    ['include', []],
    ['maxFileSizeBytes', 1],
  ])('%s = %j is accepted (the boundary is inclusive)', (key, ok) => {
    const r = resolveConfig([CWD, at('env', 'SRC', { [key]: ok })]);
    expect(leaf(r, key)).toEqual({ value: ok, layer: 'env', source: 'SRC' });
  });

  it('a malformed value in a shadowed layer still fails: a flag never hides a bad env var', () => {
    const e = configError(() =>
      resolveConfig([
        CWD,
        at('flag', '--port', { 'store.port': 7000 }),
        at('env', 'CPG_PORT', { 'store.port': 'abc' }),
      ]),
    );
    expect([e.key, e.layer, e.source]).toEqual(['store.port', 'env', 'CPG_PORT']);
  });
});

describe('resolveConfig is pure', () => {
  it('reads no environment: CPG_* in process.env changes nothing', () => {
    const before = resolveConfig([CWD]);
    vi.stubEnv('CPG_HOST', 'from-env');
    vi.stubEnv('CPG_PORT', '7777');
    vi.stubEnv('CPG_WORKSPACE', '/elsewhere');
    expect(resolveConfig([CWD])).toEqual(before);
  });

  it('does not mutate its input and gives the same answer twice', () => {
    const layers = deepFreeze([
      CWD,
      at('file', 'F', {
        include: ['src'],
        consumers: { inspect: true, store: 'memory', vscode: false },
      }),
      at('flag', '--host', { 'store.host': 'h' }),
    ]);
    const snapshot = JSON.stringify(layers);
    const a = resolveConfig(layers);
    expect(resolveConfig(layers)).toEqual(a);
    expect(JSON.stringify(layers)).toBe(snapshot);
  });
});

describe('toCpgConfigInput', () => {
  it('drops provenance and keeps every value', () => {
    const r = resolveConfig([
      CWD,
      at('flag', '--port', { 'store.port': 7000 }),
      at('file', 'F', { include: ['src/**'], 'watch.trailingMs': 5 }),
    ]);
    expect(toCpgConfigInput(r)).toEqual({
      root: '/w',
      include: ['src/**'],
      exclude: [...DEFAULT_EXCLUDES],
      maxFileSizeBytes: 2 * 1024 * 1024,
      consumers: { inspect: false, store: 'memory', vscode: false },
      store: { host: '127.0.0.1', port: 7000, graph: 'cpg', mode: 'remote' },
      queryTimeoutMs: 30000,
      resolve: { perFileMs: 500, perSiteMs: 250 },
      watch: { trailingMs: 5, ceilingMs: 500, bulkThresholdFiles: 50 },
    });
  });
});
