// `cpg verify`, from BMO-80 ("--format=json emits one cpg.verify.report document"; exit 3 on fail,
// never 1; --strict promotes unavailable to fail) and C-CLI: verify opens a read session (I-17),
// stdout is exactly one JSON value (I-8) and never depends on isTty (I-9), diagnostics and timing
// go to stderr (I-10), a malformed flag never connects (I-12), the root is --workspace, then the
// positional, then CPG_WORKSPACE, then cwd.
// U2c.2 (BMO-41): owner decision 2A, verify indexes first. One engine, built through
// RunOptions.createEngine with the resolved switches (decision 5a), indexes the workspace through a
// write session into its memory store, then verifies through a read session; so `cpg verify` passes
// on a fresh workspace with no earlier `cpg index`. A headless run has no renderer:
// render-reconciliation is unavailable.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CheckState,
  CpgEngine,
  EngineConfig,
  EngineSession,
  IndexReport,
  IndexRequest,
  StoreTarget,
  VerifyCheckId,
  VerifyConfig,
  VerifyReport,
} from '@cpg/engine';
import { createEngine } from '@cpg/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { captureIo } from './io';
import { EXIT, run } from './run';

const manifest = { bin: 'cpg', version: '9.8.7' };
const IDS: readonly VerifyCheckId[] = [
  'filesystem-reconciliation',
  'identity-invariants',
  'id-uniqueness',
  'render-reconciliation',
  'revision-reconciliation',
  'resolution-health',
];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

type Factory = (config: EngineConfig) => CpgEngine;

async function cli(
  argv: string[],
  engine: CpgEngine | Factory,
  o: {
    isTty?: boolean;
    env?: Record<string, string>;
    cwd?: string;
    signal?: AbortSignal;
    configs?: EngineConfig[];
  } = {},
) {
  const io = captureIo({ isTty: o.isTty ?? false, ...(o.env && { env: o.env }) });
  const code = await run(argv, io, {
    manifest,
    createEngine: (config) => {
      o.configs?.push(config);
      return typeof engine === 'function' ? engine(config) : engine;
    },
    ...(o.cwd !== undefined && { cwd: o.cwd }),
    ...(o.signal && { signal: o.signal }),
  });
  return { code, stdout: io.stdout, stderr: io.stderr };
}

/** A fresh workspace (a.ts, b.py): nothing has indexed it. `config` is its cpg.config.yaml. */
async function workspace(config?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cpg-cli-verify-'));
  roots.push(root);
  // .git bounds the config search (U2c.1): a stray cpg.config.yaml above tmpdir is never read.
  await mkdir(join(root, '.git'));
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'b.py'), 'b = 2\n');
  if (config !== undefined) await writeFile(join(root, 'cpg.config.yaml'), config);
  return root;
}

/** The real engine, but b.py is edited on disk after its index returns and before verify reads. */
const editedAfterIndex =
  (root: string): Factory =>
  (config) => {
    const real = createEngine(config);
    return {
      ...real,
      index: async (req, onProgress, signal) => {
        const report = await real.index(req, onProgress, signal);
        await writeFile(join(root, 'b.py'), 'b = 3\n');
        return report;
      },
    };
  };

function isReport(v: unknown): v is VerifyReport {
  return typeof v === 'object' && v !== null && 'state' in v && 'checks' in v;
}
/** The body of the one document on stdout. */
function body(stdout: readonly string[]): VerifyReport {
  expect(stdout).toHaveLength(1);
  const doc: unknown = JSON.parse(stdout[0] ?? '');
  const b = typeof doc === 'object' && doc !== null && 'body' in doc ? doc.body : undefined;
  if (!isReport(b)) throw new Error(`not a verify report document: ${stdout[0] ?? ''}`);
  return b;
}
const stateOf = (report: VerifyReport, id: string): CheckState | undefined =>
  report.checks.find((c) => c.id === id)?.state;

describe('cpg verify with the real engine (BMO-80)', () => {
  it('a fresh workspace, never indexed: verify indexes first, one document, exit 0 (2A)', async () => {
    const root = await workspace();
    const configs: EngineConfig[] = [];
    const r = await cli(['verify', '--format=json', root], createEngine, { configs });

    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).toHaveLength(1);
    expect(JSON.parse(r.stdout[0] ?? '')).toMatchObject({
      v: 1,
      kind: 'cpg.verify.report',
      tool: 'cpg@9.8.7',
      producedAt: new Date(0).toISOString(),
      body: { state: 'unavailable', consumers: ['memory'] },
    });
    const report = body(r.stdout);
    expect(report.checks.map((c) => c.id)).toEqual(IDS);
    expect(stateOf(report, 'filesystem-reconciliation')).toBe('pass');
    expect(stateOf(report, 'id-uniqueness')).toBe('pass');
    expect(stateOf(report, 'revision-reconciliation')).toBe('pass');
    // headless: no renderer consumer, so render-reconciliation cannot be computed (ND-8)
    expect(report.checks.find((c) => c.id === 'render-reconciliation')).toMatchObject({
      state: 'unavailable',
      detail: expect.stringMatching(/no renderer consumer/),
    });
    expect(configs).toEqual([
      { version: '9.8.7', consumers: { inspect: false, store: 'memory', vscode: false } },
    ]);
  });

  it('a file edited after index exits 3, never 1; the document still prints and stderr names the check', async () => {
    const root = await workspace();
    const r = await cli(['verify', '--format', 'json', root], editedAfterIndex(root));

    expect(r.code).toBe(EXIT.VERIFY_FAILED);
    const report = body(r.stdout);
    expect(report.state).toBe('fail');
    expect(report.checks.find((c) => c.id === 'revision-reconciliation')).toMatchObject({
      state: 'fail',
      localisedTo: ['b.py'],
    });
    // only the failing check is named: not a passing one, not an unavailable one
    expect(r.stderr.some((l) => l.includes('revision-reconciliation'))).toBe(true);
    expect(r.stderr.some((l) => l.includes('filesystem-reconciliation'))).toBe(false);
    expect(r.stderr.some((l) => l.includes('render-reconciliation'))).toBe(false);
  });

  it('--strict promotes unavailable to fail: exit 3 on a graph that otherwise passes', async () => {
    const root = await workspace();
    const r = await cli(['verify', '--strict', '--format=json', root], createEngine);
    expect(r.code).toBe(EXIT.VERIFY_FAILED);
    const report = body(r.stdout);
    expect(report.state).toBe('fail');
    expect(stateOf(report, 'render-reconciliation')).toBe('fail');
    expect(stateOf(report, 'id-uniqueness')).toBe('pass');
  });

  it('text output: one line per check, in enum order, led by its id and state', async () => {
    const root = await workspace();
    const r = await cli(['verify', root], editedAfterIndex(root));
    expect(r.code).toBe(EXIT.VERIFY_FAILED);
    const lines = r.stdout.filter((l) => IDS.some((id) => l.startsWith(`${id} `)));
    expect(lines.map((l) => l.split(' ')[0])).toEqual(IDS);
    const stateOn = (id: string) => lines.find((l) => l.startsWith(`${id} `))?.split(' ')[1];
    expect(stateOn('revision-reconciliation')).toBe('fail');
    expect(stateOn('filesystem-reconciliation')).toBe('pass');
    expect(stateOn('render-reconciliation')).toBe('unavailable');
    expect(lines.find((l) => l.startsWith('revision-reconciliation '))).toContain('b.py');
    const again = await workspace();
    expect((await cli(['verify', '--format=text', again], editedAfterIndex(again))).stdout).toEqual(
      r.stdout,
    );
  });

  it('stdout is byte-identical with isTty true and false (I-9); timing and consumers on stderr', async () => {
    const root = await workspace();
    const [tty, pipe] = [
      await cli(['verify', root], createEngine, { isTty: true }),
      await cli(['verify', root], createEngine, { isTty: false }),
    ];
    expect(tty.stdout).toEqual(pipe.stdout);
    expect(tty.code).toBe(pipe.code);
    expect(pipe.stderr.some((l) => l.includes('consumers: memory'))).toBe(true);
    expect(pipe.stderr.some((l) => /\b\d+ ms\b/.test(l))).toBe(true);
    expect(pipe.stdout.some((l) => / ms\b/.test(l))).toBe(false);
  });

  it('--format=json also puts the timing and consumer summary on stderr, not stdout', async () => {
    const root = await workspace();
    const r = await cli(['verify', '--format=json', root], createEngine);
    expect(r.stdout).toHaveLength(1);
    const summary = r.stderr.find((l) => l.includes('consumers: memory'));
    expect(summary).toMatch(/\b\d+ ms\b/);
  });
});

const REPORT = (state: CheckState): VerifyReport => ({
  state,
  checks: IDS.map((id) => ({
    id,
    state: id === 'id-uniqueness' ? state : 'pass',
    observed: 0,
    expected: 0,
    localisedTo: [],
    asOfSeq: -1,
  })),
  consumers: ['memory'],
  durationMs: 1,
});

const INDEXED: IndexReport = {
  root: '/w',
  walk: {
    filesSeen: 1,
    filesIndexed: 1,
    filesExcluded: 0,
    filesUnsupported: 0,
    filesTooLarge: 0,
    filesFailed: 0,
  },
  files: [],
  nodesWritten: 2,
  edgesWritten: 1,
  durationMs: 3,
  dryRun: false,
  interrupted: false,
  warnings: ['index-warning-1'],
  target: null,
  consumers: ['memory'],
};

function fakeEngine(
  state: CheckState = 'pass',
  reject = false,
  o: { indexed?: IndexReport; indexRejects?: boolean } = {},
) {
  const connects: { target: StoreTarget; readOnly: boolean }[] = [];
  const calls: { session: EngineSession; config: VerifyConfig; expected: IndexReport | null }[] =
    [];
  const indexed: IndexRequest[] = [];
  const sessions: EngineSession[] = [];
  const log: string[] = [];
  let closed = 0;
  const engine: CpgEngine = {
    identity: { name: 'fake', version: '0', languages: [] },
    connect: (target, opts) => {
      connects.push({ target, readOnly: opts.readOnly });
      log.push(opts.readOnly ? 'connect:read' : 'connect:write');
      const session = {
        target,
        close: () => {
          log.push('close');
          return Promise.resolve(void closed++);
        },
      };
      sessions.push(session);
      return Promise.resolve(session);
    },
    index: (req) => {
      log.push('index');
      indexed.push(req);
      if (o.indexRejects === true) return Promise.reject(new Error('index-boom'));
      return Promise.resolve(o.indexed ?? INDEXED);
    },
    verify: (session, config, expected) => {
      log.push('verify');
      calls.push({ session, config, expected });
      return reject ? Promise.reject(new Error('boom')) : Promise.resolve(REPORT(state));
    },
    inspect: () => Promise.reject(new Error('fakeEngine.inspect is not driven by these tests')),
    schema: () => {
      throw new Error('fakeEngine.schema is not driven by these tests');
    },
  };
  return { engine, connects, calls, indexed, sessions, log, closed: () => closed };
}

describe('cpg verify wiring', () => {
  it('indexes through a write session first, then verifies read-only with strict and expected null (2A)', async () => {
    const f = fakeEngine();
    const r = await cli(['verify', '--strict', '--port', '7000', '/w'], f.engine);
    expect(r.code).toBe(EXIT.OK);
    expect(f.log).toEqual(['connect:write', 'index', 'close', 'connect:read', 'verify', 'close']);
    const target = { host: '127.0.0.1', port: 7000, graph: 'cpg' };
    expect(f.connects).toEqual([
      { target, readOnly: false },
      { target, readOnly: true },
    ]);
    expect(f.indexed).toHaveLength(1);
    expect(f.indexed[0]?.session).toBe(f.sessions[0]);
    expect(f.indexed[0]?.resumeFrom).toBeNull();
    expect(f.indexed[0]?.config).toMatchObject({ root: '/w' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.session).toBe(f.sessions[1]);
    // The whole CpgConfigInput (provenance dropped) is pinned in config-verb.test.ts (U2c.1).
    expect(f.calls[0]?.config).toMatchObject({ root: '/w', strict: true });
    expect(f.calls[0]?.expected).toBeNull();
    expect(f.closed()).toBe(2);
  });

  it("the index run's warnings reach stderr; stdout is only the verify document", async () => {
    const r = await cli(['verify', '--format=json', '/w'], fakeEngine().engine);
    expect(r.stderr).toContain('cpg: warning: index-warning-1');
    expect(r.stdout).toHaveLength(1);
    expect(r.stdout[0]).not.toContain('index-warning-1');
  });

  it('an interrupted index exits 130 and never verifies (I-27)', async () => {
    const f = fakeEngine('pass', false, { indexed: { ...INDEXED, interrupted: true } });
    const r = await cli(['verify', '--format=json', '/w'], f.engine);
    expect(r.code).toBe(EXIT.INTERRUPTED);
    expect(r.stdout).toEqual([]);
    expect(f.calls).toEqual([]);
    expect(f.log).toEqual(['connect:write', 'index', 'close']);
  });

  it('the write session closes even when index rejects, and nothing is verified', async () => {
    const f = fakeEngine('pass', false, { indexRejects: true });
    await expect(cli(['verify', '/w'], f.engine)).rejects.toThrow('index-boom');
    expect(f.log).toEqual(['connect:write', 'index', 'close']);
  });

  it("hands the index run()'s own signal", async () => {
    const f = fakeEngine();
    const seen: AbortSignal[] = [];
    const engine: CpgEngine = {
      ...f.engine,
      index: (req, onProgress, signal) => {
        seen.push(signal);
        return f.engine.index(req, onProgress, signal);
      },
    };
    const controller = new AbortController();
    await cli(['verify', '/w'], engine, { signal: controller.signal });
    expect(seen).toEqual([controller.signal]);
  });

  it.each([
    [
      '--store falkor',
      ['--store', 'falkor'],
      undefined,
      ['consumers.store "falkor"', '--store', 'U5'],
    ],
    // U2b.1 part 3b: verify does not start the inspector, so the switch is refused with the verb
    // that does (design note 9)
    [
      '--inspect',
      ['--inspect'],
      undefined,
      ['consumers.inspect true', '--inspect', 'cpg index --inspect'],
    ],
    [
      'a file with vscode: true',
      [],
      'version: 1\nconsumers: { vscode: true }\n',
      ['consumers.vscode true', 'cpg.config.yaml', 'U3'],
    ],
    // round two (review b4): a file's store, and two switches each with its own source
    [
      'a file with store: falkor, plus --inspect',
      ['--inspect'],
      'version: 1\nconsumers: { store: falkor }\n',
      [
        'consumers.store "falkor"',
        'cpg.config.yaml',
        'U5',
        'consumers.inspect true',
        '--inspect',
        'cpg index --inspect',
      ],
    ],
  ] as const)(
    '%s: exit 2 "not built yet" naming the switch and its source; no engine, no connect',
    async (_name, flags, config, names) => {
      const root = await workspace(config);
      const f = fakeEngine();
      const configs: EngineConfig[] = [];
      const r = await cli(['verify', ...flags, root], f.engine, { configs });
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.stdout).toEqual([]);
      const err = r.stderr.join('\n');
      expect(err).toContain('not built yet');
      for (const name of names) expect(err).toContain(name);
      expect(configs).toEqual([]);
      expect(f.connects).toEqual([]);
    },
  );

  it('without --strict the engine is not asked to be strict', async () => {
    const f = fakeEngine();
    await cli(['verify', '/w'], f.engine);
    expect(f.calls[0]?.config.strict ?? false).toBe(false);
  });

  it.each([
    ['pass', EXIT.OK],
    ['unavailable', EXIT.OK],
    ['stale', EXIT.OK],
    ['fail', EXIT.VERIFY_FAILED],
  ] as const)('report state %s exits %i', async (state, code) => {
    const r = await cli(['verify', '--format=json', '/w'], fakeEngine(state).engine);
    expect(r.code).toBe(code);
    expect(body(r.stdout).state).toBe(state);
  });

  it.each([['json'], ['text']])(
    '--format=%s: stdout is byte-identical with isTty true and false (I-9)',
    async (format) => {
      const argv = ['verify', `--format=${format}`, '/w'];
      const [tty, pipe] = [
        await cli(argv, fakeEngine().engine, { isTty: true }),
        await cli(argv, fakeEngine().engine, { isTty: false }),
      ];
      expect(tty.stdout).toEqual(pipe.stdout);
      expect(pipe.stdout).toHaveLength(format === 'json' ? 1 : 7);
    },
  );

  // round two (review a6): the refusal reads the resolved winner, not the file
  it('--store memory over a file with store: falkor verifies', async () => {
    const root = await workspace('version: 1\nconsumers: { store: falkor }\n');
    const f = fakeEngine();
    const r = await cli(['verify', '--store', 'memory', root], f.engine);
    expect(r.code).toBe(EXIT.OK);
    expect(f.calls).toHaveLength(1);
  });

  it('the read session closes even when verify rejects', async () => {
    const f = fakeEngine('pass', true);
    await expect(cli(['verify', '/w'], f.engine)).rejects.toThrow('boom');
    expect(f.closed()).toBe(2);
    expect(f.log.at(-1)).toBe('close');
  });

  it('a malformed --port exits 2 and never connects (I-12)', async () => {
    const f = fakeEngine();
    const r = await cli(['verify', '--port', 'abc', '/w'], f.engine);
    expect(r.code).toBe(EXIT.USAGE);
    expect(f.connects).toHaveLength(0);
  });

  it.each([
    ['--workspace wins', ['--workspace', '/flag', '/pos'], { CPG_WORKSPACE: '/env' }, '/flag'],
    ['then the positional', ['/pos'], { CPG_WORKSPACE: '/env' }, '/pos'],
    ['then CPG_WORKSPACE', [], { CPG_WORKSPACE: '/env' }, '/env'],
    ['then cwd', [], {}, '/cwd'],
    ['a relative positional resolves against cwd', ['sub'], {}, '/cwd/sub'],
    ['so does a relative --workspace', ['--workspace', 'ws'], {}, '/cwd/ws'],
    ['and a relative CPG_WORKSPACE', [], { CPG_WORKSPACE: 'env' }, '/cwd/env'],
  ])('workspace root: %s', async (_, args, env, want) => {
    const f = fakeEngine();
    await cli(['verify', ...args], f.engine, { env, cwd: '/cwd' });
    expect(f.calls[0]?.config.root).toBe(want);
  });

  it('no root at all is a usage error, before any connect', async () => {
    const f = fakeEngine();
    const r = await cli(['verify'], f.engine);
    expect(r.code).toBe(EXIT.USAGE);
    expect(f.connects).toHaveLength(0);
  });
});
