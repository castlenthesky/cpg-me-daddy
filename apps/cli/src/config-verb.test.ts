// `cpg config` and the config loader, from BMO-38:
//   - "every key carries {value, layer, source}; `cpg config --format=json` prints it" (C-CLI I-25,
//     Document<'cpg.config.resolved', ResolvedConfig>);
//   - "the file is found at --config, else the nearest ancestor of the root containing
//     cpg.config.yaml, stopping at .git; finding it never relocates the root" (C-CLI workspace_root);
//   - "the loader produces one CpgConfigInput handed to the engine".
// The env vars: CPG_WORKSPACE (C-CLI workspace_root) and CPG_HOST / CPG_PORT / CPG_GRAPH (the
// archive's falkordb.config.ts names, 11-salvage). Sources: a flag as typed, `<root>` for the
// positional, the env var name, the file's absolute path, `cwd`, `built-in`.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  CpgEngine,
  EngineConfig,
  EngineSession,
  IndexReport,
  IndexRequest,
  StoreTarget,
  VerifyConfig,
  VerifyReport,
} from '@cpg/engine';
import { DEFAULT_EXCLUDES } from '@cpg/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { captureIo } from './io';
import { EXIT, run } from './run';

const manifest = { bin: 'cpg', version: '9.8.7' };
const KEYS = [
  'root',
  'include',
  'exclude',
  'maxFileSizeBytes',
  'consumers.inspect',
  'consumers.store',
  'consumers.vscode',
  'store.host',
  'store.port',
  'store.graph',
  'store.mode',
  'queryTimeoutMs',
  'resolve.perFileMs',
  'resolve.perSiteMs',
  'watch.trailingMs',
  'watch.ceilingMs',
  'watch.bulkThresholdFiles',
];
const LAYERS = ['flag', 'env', 'file', 'manifest', 'default'];
const FILE = 'cpg.config.yaml';
const builtIn = (value: unknown) => ({ value, layer: 'default', source: 'built-in' });

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A temp tree: a key ending in `/` is a directory, anything else a file with that text. */
async function tree(entries: Record<string, string>): Promise<string> {
  const top = await mkdtemp(join(tmpdir(), 'cpg-cli-config-'));
  dirs.push(top);
  for (const [path, text] of Object.entries(entries)) {
    const full = join(top, path);
    if (path.endsWith('/')) {
      await mkdir(full, { recursive: true });
    } else {
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, text);
    }
  }
  return top;
}

async function cli(
  argv: string[],
  o: {
    env?: Record<string, string>;
    cwd?: string;
    engine?: CpgEngine;
    isTty?: boolean;
    configs?: EngineConfig[];
  } = {},
) {
  const io = captureIo({ isTty: o.isTty ?? false, ...(o.env && { env: o.env }) });
  const { engine } = o;
  const code = await run(argv, io, {
    manifest,
    ...(engine && {
      createEngine: (config: EngineConfig) => {
        o.configs?.push(config);
        return engine;
      },
    }),
    ...(o.cwd !== undefined && { cwd: o.cwd }),
  });
  return { code, stdout: io.stdout, stderr: io.stderr };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** The one document on stdout. */
function doc(stdout: readonly string[]): Record<string, unknown> {
  expect(stdout).toHaveLength(1);
  const d: unknown = JSON.parse(stdout[0] ?? '');
  if (!isRecord(d)) throw new Error(`not a document: ${stdout[0] ?? ''}`);
  return d;
}

/** The value at a dotted path of the resolved body. */
function leaf(body: unknown, key: string): unknown {
  let v: unknown = body;
  for (const k of key.split('.')) v = isRecord(v) ? v[k] : undefined;
  return v;
}

/** Every {value, layer, source} leaf of the body, by dotted path. */
function leaves(v: unknown, path = ''): string[] {
  if (!isRecord(v)) return [];
  if ('layer' in v) return [path];
  return Object.entries(v).flatMap(([k, x]) => leaves(x, path ? `${path}.${k}` : k));
}

async function configJson(
  argv: string[],
  o: { env?: Record<string, string>; cwd?: string } = {},
): Promise<Record<string, unknown>> {
  const r = await cli(['config', '--format=json', ...argv], o);
  expect(r.code).toBe(EXIT.OK);
  return doc(r.stdout);
}

/** The CpgConfigInput every value of which is built in, for a root. */
const plainDefaults = (root: string) => ({
  root,
  include: ['**/*'],
  exclude: [...DEFAULT_EXCLUDES],
  maxFileSizeBytes: 2 * 1024 * 1024,
  consumers: { inspect: false, store: 'memory', vscode: false },
  store: { host: '127.0.0.1', port: 6382, graph: 'cpg', mode: 'remote' },
  queryTimeoutMs: 30000,
  resolve: { perFileMs: 500, perSiteMs: 250 },
  watch: { trailingMs: 100, ceilingMs: 500, bulkThresholdFiles: 50 },
});

const REPORT: IndexReport = {
  root: '/w',
  walk: {
    filesSeen: 0,
    filesIndexed: 0,
    filesExcluded: 0,
    filesUnsupported: 0,
    filesTooLarge: 0,
    filesFailed: 0,
  },
  files: [],
  nodesWritten: 0,
  edgesWritten: 0,
  durationMs: 1,
  dryRun: true,
  interrupted: false,
  warnings: [],
  target: null,
  consumers: [],
};
const VERIFIED: VerifyReport = { state: 'pass', checks: [], consumers: [], durationMs: 1 };

function fakeEngine() {
  const requests: IndexRequest[] = [];
  const verifies: VerifyConfig[] = [];
  const connects: StoreTarget[] = [];
  const engine: CpgEngine = {
    identity: { name: 'fake', version: '0', languages: [] },
    connect: (target): Promise<EngineSession> => {
      connects.push(target);
      return Promise.resolve({ target, close: () => Promise.resolve() });
    },
    index: (req) => {
      requests.push(req);
      return Promise.resolve(REPORT);
    },
    verify: (_session, config) => {
      verifies.push(config);
      return Promise.resolve(VERIFIED);
    },
    inspect: () => Promise.reject(new Error('fakeEngine.inspect is not driven by these tests')),
    schema: () => {
      throw new Error('fakeEngine.schema is not driven by these tests');
    },
  };
  return { engine, requests, verifies, connects };
}

describe('cpg config --format=json (C-CLI I-25)', () => {
  it('prints one cpg.config.resolved document whose every key carries value, layer, source', async () => {
    const ws = await tree({ '.git/': '' });
    const d = await configJson([ws]);
    expect(d).toMatchObject({
      v: 1,
      kind: 'cpg.config.resolved',
      tool: 'cpg@9.8.7',
      producedAt: '1970-01-01T00:00:00.000Z',
    });
    const body = d['body'];
    expect(leaves(body).toSorted()).toEqual(KEYS.toSorted());
    for (const key of KEYS) {
      const p = leaf(body, key);
      expect(isRecord(p) && Object.keys(p).toSorted()).toEqual(['layer', 'source', 'value']);
      expect(LAYERS).toContain(isRecord(p) ? p['layer'] : undefined);
    }
    expect(leaf(body, 'root')).toEqual({ value: ws, layer: 'flag', source: '<root>' });
    expect(leaf(body, 'store.port')).toEqual(builtIn(6382));
    expect(leaf(body, 'include')).toEqual(builtIn(['**/*']));
  });

  it('needs no engine', async () => {
    const ws = await tree({ '.git/': '' });
    const r = await cli(['config', '--format=json', ws]);
    expect(r.code).toBe(EXIT.OK);
    // round two (review b3): given a constructor, cpg config still builds no engine
    const configs: EngineConfig[] = [];
    const f = fakeEngine();
    const withEngine = await cli(['config', '--format=json', '--store', 'falkor', ws], {
      engine: f.engine,
      configs,
    });
    expect(withEngine.code).toBe(EXIT.OK);
    expect(configs).toEqual([]);
  });

  it.each([
    [
      'flag beats env and file',
      true,
      true,
      true,
      { value: 'flag-host', layer: 'flag', source: '--host' },
    ],
    ['env beats file', false, true, true, { value: 'env-host', layer: 'env', source: 'CPG_HOST' }],
    [
      'file beats the default',
      false,
      false,
      true,
      { value: 'file-host', layer: 'file', source: FILE },
    ],
    ['the default is last', false, false, false, builtIn('127.0.0.1')],
  ])('store.host: %s', async (_name, flag, env, file, expected) => {
    const ws = await tree({
      '.git/': '',
      ...(file && { [FILE]: 'version: 1\nstore: { falkor: { host: file-host } }\n' }),
    });
    const d = await configJson([ws, ...(flag ? ['--host', 'flag-host'] : [])], {
      env: env ? { CPG_HOST: 'env-host' } : {},
    });
    const source = expected.source === FILE ? join(ws, FILE) : expected.source;
    expect(leaf(d['body'], 'store.host')).toEqual({ ...expected, source });
  });

  it('CPG_PORT and CPG_GRAPH are read as the store port (a number) and graph; --port beats CPG_PORT', async () => {
    const ws = await tree({ '.git/': '' });
    const env = { CPG_PORT: '7001', CPG_GRAPH: 'g' };
    const d = await configJson([ws], { env });
    expect(leaf(d['body'], 'store.port')).toEqual({
      value: 7001,
      layer: 'env',
      source: 'CPG_PORT',
    });
    expect(leaf(d['body'], 'store.graph')).toEqual({
      value: 'g',
      layer: 'env',
      source: 'CPG_GRAPH',
    });
    const flagged = await configJson([ws, '--port', '7002', '--graph', 'fg'], { env });
    expect(leaf(flagged['body'], 'store.port')).toEqual({
      value: 7002,
      layer: 'flag',
      source: '--port',
    });
    expect(leaf(flagged['body'], 'store.graph')).toEqual({
      value: 'fg',
      layer: 'flag',
      source: '--graph',
    });
  });

  it('only CPG_WORKSPACE, CPG_HOST, CPG_PORT and CPG_GRAPH are read', async () => {
    const ws = await tree({ '.git/': '' });
    const env = {
      CPG_MODE: 'docker',
      CPG_INCLUDE: 'x',
      CPG_GRAMMAR_DIR: '/g',
      CPG_STORE_HOST: 'h',
    };
    const d = await configJson([ws], { env });
    expect(JSON.stringify(d['body'])).not.toContain('"layer":"env"');
  });

  it.each([
    ['CPG_PORT', 'abc'],
    ['CPG_PORT', '0'],
    ['CPG_PORT', '63.5'],
    ['CPG_PORT', '7000abc'],
    ['CPG_PORT', '70000'],
    ['CPG_HOST', ''],
  ])('%s=%j is a config error: exit 2, named, nothing on stdout', async (name, value) => {
    const ws = await tree({ '.git/': '' });
    for (const flags of [[], ['--port', '7000', '--host', 'h']]) {
      const r = await cli(['config', '--format=json', ws, ...flags], { env: { [name]: value } });
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.stdout).toEqual([]);
      expect(r.stderr.join('\n')).toContain(name);
    }
  });

  it('a config error is not a usage error: one cpg: line, no usage hint', async () => {
    const ws = await tree({ '.git/': '' });
    const r = await cli(['config', '--format=json', ws], { env: { CPG_PORT: 'abc' } });
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stderr).toHaveLength(1);
    expect(r.stderr[0]).toMatch(/^cpg: .*CPG_PORT/);
    expect(r.stderr[0]).not.toMatch(/--help|usage/);
  });

  it.each([
    ['--workspace', ['--workspace', '/flag', '/pos'], { CPG_WORKSPACE: '/env' }, '/flag', 'flag'],
    ['<root>', ['/pos'], { CPG_WORKSPACE: '/env' }, '/pos', 'flag'],
    ['CPG_WORKSPACE', [], { CPG_WORKSPACE: '/env' }, '/env', 'env'],
    ['cwd', [], {}, '/cwd', 'default'],
  ])('root from %s', async (source, args, env, value, layer) => {
    const d = await configJson(args, { env, cwd: '/cwd' });
    expect(leaf(d['body'], 'root')).toEqual({ value, layer, source });
  });

  it('no root from any source is a usage error', async () => {
    const r = await cli(['config']);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stderr.join('\n')).toMatch(/no workspace root/);
  });
});

describe('cpg config: finding cpg.config.yaml', () => {
  it('in the root', async () => {
    const ws = await tree({ '.git/': '', [FILE]: 'version: 1\ninclude: [src/**]\n' });
    const d = await configJson([ws]);
    expect(leaf(d['body'], 'include')).toEqual({
      value: ['src/**'],
      layer: 'file',
      source: join(ws, FILE),
    });
  });

  it('in the nearest ancestor, without relocating the root', async () => {
    const top = await tree({ '.git/': '', [FILE]: 'version: 1\ninclude: [top]\n', 'a/b/': '' });
    const root = join(top, 'a', 'b');
    const d = await configJson([root]);
    expect(leaf(d['body'], 'root')).toEqual({ value: root, layer: 'flag', source: '<root>' });
    expect(leaf(d['body'], 'include')).toEqual({
      value: ['top'],
      layer: 'file',
      source: join(top, FILE),
    });
  });

  // Post-implementation (sabotage): a search starting at cwd passed every case above.
  it('the search starts at the root, not at cwd', async () => {
    const top = await tree({
      '.git/': '',
      [`cwdside/${FILE}`]: 'version: 1\ninclude: [cwd]\n',
      'rootside/.git/': '',
    });
    const d = await configJson([join(top, 'rootside')], { cwd: join(top, 'cwdside') });
    expect(leaf(d['body'], 'include')).toEqual(builtIn(['**/*']));
  });

  it('the nearest one wins', async () => {
    const top = await tree({
      '.git/': '',
      [FILE]: 'version: 1\ninclude: [outer]\n',
      [`a/${FILE}`]: 'version: 1\ninclude: [inner]\n',
      'a/b/': '',
    });
    const d = await configJson([join(top, 'a', 'b')]);
    expect(leaf(d['body'], 'include')).toEqual({
      value: ['inner'],
      layer: 'file',
      source: join(top, 'a', FILE),
    });
  });

  it.each([
    ['a .git directory', { 'repo/.git/': '' }],
    ['a .git file (a worktree)', { 'repo/.git': 'gitdir: /elsewhere\n' }],
  ])('the search stops at %s', async (_name, git) => {
    const top = await tree({ [FILE]: 'version: 1\ninclude: [above]\n', ...git, 'repo/sub/': '' });
    const d = await configJson([join(top, 'repo', 'sub')]);
    expect(leaf(d['body'], 'include')).toEqual(builtIn(['**/*']));
    expect(JSON.stringify(d['body'])).not.toContain('"layer":"file"');
  });

  it.each([
    ['a .git directory', { 'repo/.git/': '' }],
    ['a .git file', { 'repo/.git': 'gitdir: /elsewhere\n' }],
  ])('the search stops at %s in the root itself', async (_name, git) => {
    const top = await tree({ [FILE]: 'version: 1\ninclude: [above]\n', ...git });
    const d = await configJson([join(top, 'repo')]);
    expect(leaf(d['body'], 'include')).toEqual(builtIn(['**/*']));
  });

  it('consumers.vscode: auto is false at the CLI, which is headless', async () => {
    const ws = await tree({
      '.git/': '',
      [FILE]: 'version: 1\nconsumers: { inspect: true, store: falkor, vscode: auto }\n',
    });
    const d = await configJson([ws]);
    const file = { layer: 'file', source: join(ws, FILE) };
    expect(leaf(d['body'], 'consumers')).toEqual({
      inspect: { value: true, ...file },
      store: { value: 'falkor', ...file },
      vscode: { value: false, ...file },
    });
  });

  // Owner decision 1A (U2c.2): the case it exists for, at the front door.
  it('--inspect over a file setting store: falkor keeps each switch its own provenance', async () => {
    const ws = await tree({ '.git/': '', [FILE]: 'version: 1\nconsumers: { store: falkor }\n' });
    const d = await configJson([ws, '--inspect']);
    expect(leaf(d['body'], 'consumers')).toEqual({
      inspect: { value: true, layer: 'flag', source: '--inspect' },
      store: { value: 'falkor', layer: 'file', source: join(ws, FILE) },
      vscode: builtIn(false),
    });
  });

  it('--store beats the file for that switch only', async () => {
    const ws = await tree({
      '.git/': '',
      [FILE]: 'version: 1\nconsumers: { inspect: true, store: falkor }\n',
    });
    const d = await configJson([ws, '--store', 'memory']);
    expect(leaf(d['body'], 'consumers')).toEqual({
      inspect: { value: true, layer: 'file', source: join(ws, FILE) },
      store: { value: 'memory', layer: 'flag', source: '--store' },
      vscode: builtIn(false),
    });
  });

  it('without --inspect the flag layer sets no switch (a boolean flag only switches on)', async () => {
    const ws = await tree({ '.git/': '', [FILE]: 'version: 1\nconsumers: { inspect: true }\n' });
    const d = await configJson([ws]);
    expect(leaf(d['body'], 'consumers.inspect')).toEqual({
      value: true,
      layer: 'file',
      source: join(ws, FILE),
    });
  });

  it('no CPG_* env var sets a consumer switch', async () => {
    const ws = await tree({ '.git/': '' });
    const d = await configJson([ws], {
      env: { CPG_STORE: 'falkor', CPG_INSPECT: 'true', CPG_CONSUMERS_STORE: 'falkor' },
    });
    expect(leaf(d['body'], 'consumers')).toEqual({
      inspect: builtIn(false),
      store: builtIn('memory'),
      vscode: builtIn(false),
    });
  });

  it('--config names the file, even when one is nearer; relative to cwd, not the root', async () => {
    const top = await tree({
      '.git/': '',
      [FILE]: 'version: 1\ninclude: [discovered]\n',
      'other/custom.yaml': 'version: 1\ninclude: [named]\n',
    });
    const d = await configJson(['--workspace', top, '--config', 'custom.yaml'], {
      cwd: join(top, 'other'),
    });
    expect(leaf(d['body'], 'include')).toEqual({
      value: ['named'],
      layer: 'file',
      source: join(top, 'other', 'custom.yaml'),
    });
    expect(leaf(d['body'], 'root')).toEqual({ value: top, layer: 'flag', source: '--workspace' });
  });

  it('--config is not bounded by .git', async () => {
    const top = await tree({ 'custom.yaml': 'version: 1\ninclude: [named]\n', 'repo/.git/': '' });
    const d = await configJson([join(top, 'repo'), '--config', join(top, 'custom.yaml')]);
    expect(leaf(d['body'], 'include')).toMatchObject({ value: ['named'], layer: 'file' });
  });

  it('a --config that cannot be read is a config error naming it', async () => {
    const ws = await tree({ '.git/': '' });
    const missing = join(ws, 'nope.yaml');
    const r = await cli(['config', '--format=json', ws, '--config', missing]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stdout).toEqual([]);
    expect(r.stderr.join('\n')).toContain(missing);
  });

  it('an invalid file is a config error naming the file and the key', async () => {
    const ws = await tree({ '.git/': '', [FILE]: 'version: 1\nstore: { falkor: { port: 0 } }\n' });
    const r = await cli(['config', '--format=json', ws]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stdout).toEqual([]);
    expect(r.stderr.join('\n')).toContain(join(ws, FILE));
    expect(r.stderr.join('\n')).toContain('store.falkor.port');
  });

  it('a file setting languages warns on stderr that it is not applied', async () => {
    const ws = await tree({ '.git/': '', [FILE]: 'version: 1\nlanguages: { python: false }\n' });
    const r = await cli(['config', '--format=json', ws]);
    expect(r.code).toBe(EXIT.OK);
    expect(r.stderr.join('\n')).toMatch(/warning.*languages/);
    const plain = await tree({ '.git/': '', [FILE]: 'version: 1\n' });
    const quiet = await cli(['config', '--format=json', plain]);
    expect(quiet.stderr.join('\n')).not.toMatch(/warning/);
  });
});

describe('cpg config --format=text', () => {
  it('is the default: one line per key, `key value layer source`, in ResolvedConfig order', async () => {
    const ws = await tree({ '.git/': '' });
    const r = await cli(['config', ws]);
    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout.map((l) => l.split(' ')[0])).toEqual(KEYS);
    expect(r.stdout[0]).toBe(`root ${JSON.stringify(ws)} flag <root>`);
    expect(r.stdout).toContain('store.port 6382 default built-in');
    expect(r.stdout).toContain('consumers.inspect false default built-in');
    expect(r.stdout).toContain('consumers.store "memory" default built-in');
    expect(r.stdout).toContain('consumers.vscode false default built-in');
    const explicit = await cli(['config', '--format=text', ws]);
    expect(explicit.stdout).toEqual(r.stdout);
  });

  it.each([['json'], ['text']])('--format=%s stdout does not depend on isTty (I-9)', async (f) => {
    const ws = await tree({ '.git/': '' });
    const [tty, pipe] = [
      await cli(['config', `--format=${f}`, ws], { isTty: true }),
      await cli(['config', `--format=${f}`, ws], { isTty: false }),
    ];
    expect([tty.code, pipe.code]).toEqual([EXIT.OK, EXIT.OK]);
    expect(tty.stdout.length).toBeGreaterThan(0);
    expect(tty.stdout).toEqual(pipe.stdout);
  });
});

describe('the loader hands the engine one CpgConfigInput (BMO-38)', () => {
  const FILE_TEXT = [
    'version: 1',
    'include: [src/**]',
    'exclude: ["**/gen/**"]',
    'max_file_size_bytes: 4096',
    'watch: { debounce_ms: 7 }',
    'store: { falkor: { host: fh, port: 7100, graph: fg } }',
    '',
  ].join('\n');

  it('cpg index --dry-run passes the resolved values, provenance dropped', async () => {
    const ws = await tree({ '.git/': '', [FILE]: FILE_TEXT });
    const f = fakeEngine();
    const r = await cli(['index', '--dry-run', ws], { engine: f.engine });
    expect(r.code).toBe(EXIT.OK);
    expect(f.requests).toEqual([
      {
        config: {
          ...plainDefaults(ws),
          include: ['src/**'],
          exclude: ['**/gen/**'],
          maxFileSizeBytes: 4096,
          store: { host: 'fh', port: 7100, graph: 'fg', mode: 'remote' },
          watch: { trailingMs: 7, ceilingMs: 500, bulkThresholdFiles: 50 },
        },
        session: null,
        resumeFrom: null,
      },
    ]);
  });

  it('cpg verify connects to the resolved store and passes the resolved values with strict', async () => {
    const ws = await tree({ '.git/': '', [FILE]: FILE_TEXT });
    const f = fakeEngine();
    const r = await cli(['verify', '--strict', ws], { engine: f.engine, env: { CPG_GRAPH: 'eg' } });
    expect(r.code).toBe(EXIT.OK);
    // index first, then verify (owner decision 2A): both sessions open on the resolved target
    const target = { host: 'fh', port: 7100, graph: 'eg' };
    expect(f.connects).toEqual([target, target]);
    expect(f.requests.map((q) => q.config)).toEqual([
      {
        ...plainDefaults(ws),
        include: ['src/**'],
        exclude: ['**/gen/**'],
        maxFileSizeBytes: 4096,
        store: { ...target, mode: 'remote' },
        watch: { trailingMs: 7, ceilingMs: 500, bulkThresholdFiles: 50 },
      },
    ]);
    expect(f.verifies).toEqual([
      {
        ...plainDefaults(ws),
        include: ['src/**'],
        exclude: ['**/gen/**'],
        maxFileSizeBytes: 4096,
        store: { host: 'fh', port: 7100, graph: 'eg', mode: 'remote' },
        watch: { trailingMs: 7, ceilingMs: 500, bulkThresholdFiles: 50 },
        strict: true,
      },
    ]);
  });

  it('cpg verify --host and --port beat the file', async () => {
    const ws = await tree({ '.git/': '', [FILE]: FILE_TEXT });
    const f = fakeEngine();
    await cli(['verify', ws, '--host', 'h', '--port', '7200'], { engine: f.engine });
    const target = { host: 'h', port: 7200, graph: 'fg' };
    expect(f.connects).toEqual([target, target]);
  });

  it('with no file and no env, cpg verify connects to the built-in store', async () => {
    const ws = await tree({ '.git/': '' });
    const f = fakeEngine();
    await cli(['verify', ws], { engine: f.engine });
    const target = { host: '127.0.0.1', port: 6382, graph: 'cpg' };
    expect(f.connects).toEqual([target, target]);
    expect(f.verifies).toEqual([{ ...plainDefaults(ws), strict: false }]);
  });

  it.each([
    ['verify', ['verify']],
    ['index --dry-run', ['index', '--dry-run']],
    ['index', ['index']],
  ])('%s: a config error exits 2 before any engine call (I-12)', async (_name, argv) => {
    const ws = await tree({ '.git/': '', [FILE]: 'version: 1\nincludes: [typo]\n' });
    for (const env of [{}, { CPG_PORT: 'abc' }]) {
      const f = fakeEngine();
      const configs: EngineConfig[] = [];
      const bad = Object.keys(env).length > 0 ? await tree({ '.git/': '' }) : ws;
      const r = await cli([...argv, bad], { engine: f.engine, env, configs });
      expect(r.code).toBe(EXIT.USAGE);
      expect([f.connects, f.requests, f.verifies]).toEqual([[], [], []]);
      // round two (review b3): no engine is even built
      expect(configs).toEqual([]);
    }
  });

  // round two (review b2): the walk scope and the loader warnings reach index without --dry-run
  it('cpg index without --dry-run passes the same resolved values, and the loader warnings', async () => {
    const ws = await tree({
      '.git/': '',
      [FILE]: `${FILE_TEXT}languages: { python: false }\n`,
    });
    const f = fakeEngine();
    const r = await cli(['index', ws], { engine: f.engine });
    expect(r.code).toBe(EXIT.OK);
    expect(f.requests.map((q) => q.config)).toEqual([
      {
        ...plainDefaults(ws),
        include: ['src/**'],
        exclude: ['**/gen/**'],
        maxFileSizeBytes: 4096,
        store: { host: 'fh', port: 7100, graph: 'fg', mode: 'remote' },
        watch: { trailingMs: 7, ceilingMs: 500, bulkThresholdFiles: 50 },
      },
    ]);
    expect(f.requests[0]?.session).not.toBeNull();
    expect(f.connects).toEqual([{ host: 'fh', port: 7100, graph: 'fg' }]);
    expect(r.stderr.join('\n')).toMatch(/warning.*languages/);
  });

  it('--config reaches cpg index --dry-run', async () => {
    const ws = await tree({ '.git/': '', 'c.yaml': 'version: 1\ninclude: [named/**]\n' });
    const f = fakeEngine();
    await cli(['index', '--dry-run', ws, '--config', join(ws, 'c.yaml')], { engine: f.engine });
    expect(f.requests[0]?.config.include).toEqual(['named/**']);
  });

  it('--config reaches cpg verify', async () => {
    const ws = await tree({ '.git/': '', 'c.yaml': 'version: 1\ninclude: [named/**]\n' });
    const f = fakeEngine();
    await cli(['verify', ws, '--config', join(ws, 'c.yaml')], { engine: f.engine });
    expect(f.verifies[0]?.include).toEqual(['named/**']);
  });

  // index without --dry-run is built since U2c.2 (index-verb.test.ts), inspect since U2b.1 part 3b.
  it.each([['watch']])(
    'the SEAT verb %s loads no config: built-in store, still "not built yet"',
    async (verb) => {
      const ws = await tree({ '.git/': '', [FILE]: 'version: 1\nincludes: [typo]\n' });
      const f = fakeEngine();
      const r = await cli([verb, ws], { engine: f.engine, env: { CPG_HOST: 'e', CPG_PORT: 'x' } });
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.stderr.join('\n')).toContain('not built yet');
      expect(f.connects).toEqual([{ host: '127.0.0.1', port: 6382, graph: 'cpg' }]);
    },
  );

  it('the loader warnings reach stderr for index --dry-run too', async () => {
    const ws = await tree({ '.git/': '', [FILE]: 'version: 1\nlanguages: { python: false }\n' });
    const f = fakeEngine();
    const r = await cli(['index', '--dry-run', ws], { engine: f.engine });
    expect(r.code).toBe(EXIT.OK);
    expect(r.stderr.join('\n')).toMatch(/warning.*languages/);
  });
});
