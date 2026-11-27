// `cpg index --dry-run`, from BMO-79 ("over a tmp workspace with a.ts and b.py reports filesIndexed 2
// with no store") and C-CLI: --dry-run passes session:null and never connects; the workspace root is
// --workspace, then the positional, then CPG_WORKSPACE, then cwd; one JSON document on stdout (I-8);
// diagnostics on stderr (I-10); stdout never depends on isTty (I-9); interrupted exits 130 (I-27).
// U2c.2 (BMO-41): `cpg index` without --dry-run writes the memory store consumer; run builds the
// engine through RunOptions.createEngine once the config resolves (owner decision 5a), and refuses a
// switched-on consumer that is not built yet (falkor U5, inspect U2b, vscode U3), naming its source.

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CpgEngine,
  EngineConfig,
  EngineSession,
  IndexReport,
  IndexRequest,
  StoreTarget,
} from '@cpg/engine';
import { createEngine } from '@cpg/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { captureIo } from './io';
import { EXIT, run } from './run';

const manifest = { bin: 'cpg', version: '9.8.7' };
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const REPORT: IndexReport = {
  root: '/w',
  walk: {
    filesSeen: 3,
    filesIndexed: 2,
    filesExcluded: 0,
    filesUnsupported: 1,
    filesTooLarge: 0,
    filesFailed: 0,
  },
  files: [],
  nodesWritten: 4,
  edgesWritten: 3,
  durationMs: 12.4,
  dryRun: true,
  interrupted: false,
  warnings: ['w1', 'w2'],
  target: null,
  consumers: [],
};

function fakeEngine(report: IndexReport = REPORT) {
  const requests: IndexRequest[] = [];
  const signals: AbortSignal[] = [];
  const opened: { target: StoreTarget; readOnly: boolean; session: EngineSession }[] = [];
  const log: string[] = [];
  let connects = 0;
  const engine: CpgEngine = {
    identity: { name: 'fake', version: '0', languages: [] },
    connect: (target, opts) => {
      connects++;
      log.push('connect');
      const session: EngineSession = {
        target,
        close: () => Promise.resolve(void log.push('close')),
      };
      opened.push({ target, readOnly: opts.readOnly, session });
      return Promise.resolve(session);
    },
    index: (req, onProgress, signal) => {
      log.push('index');
      requests.push(req);
      signals.push(signal);
      onProgress({ phase: 'walked', filesTotal: 3 });
      return Promise.resolve(report);
    },
    verify: () => Promise.reject(new Error('fakeEngine.verify is not driven by these tests')),
    inspect: () => Promise.reject(new Error('fakeEngine.inspect is not driven by these tests')),
    watch: () => Promise.reject(new Error('fakeEngine.watch is not driven by these tests')),
    schema: () => {
      throw new Error('fakeEngine.schema is not driven by these tests');
    },
  };
  return { engine, requests, signals, opened, log, connects: () => connects };
}

async function cli(
  argv: string[],
  engine: CpgEngine | ((config: EngineConfig) => CpgEngine),
  o: {
    isTty?: boolean;
    env?: Record<string, string>;
    cwd?: string;
    signal?: AbortSignal;
    configs?: EngineConfig[];
  } = {},
) {
  const base = captureIo({ isTty: o.isTty ?? false, ...(o.env && { env: o.env }) });
  // io.status is recorded on its own, so progress written with io.err cannot pass for it.
  const statuses: string[] = [];
  const io = { ...base, status: (line: string) => void statuses.push(line) };
  const code = await run(argv, io, {
    manifest,
    createEngine: (config) => {
      o.configs?.push(config);
      return typeof engine === 'function' ? engine(config) : engine;
    },
    ...(o.cwd !== undefined && { cwd: o.cwd }),
    ...(o.signal && { signal: o.signal }),
  });
  return { code, stdout: base.stdout, stderr: base.stderr, statuses };
}

describe('cpg index --dry-run with the real engine (BMO-79)', () => {
  it('a.ts and b.py: one cpg.index.report document, filesIndexed 2, no store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cpg-cli-index-'));
    roots.push(root);
    // .git bounds the config search (U2c.1): a stray cpg.config.yaml above tmpdir is never read.
    await mkdir(join(root, '.git'));
    const files = { 'a.ts': 'export const a = 1;\n', 'b.py': 'b = 2\n' };
    for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
    const r = await cli(['index', '--dry-run', '--format', 'json', root], createEngine);

    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).toHaveLength(1);
    const doc: unknown = JSON.parse(r.stdout[0] ?? '');
    expect(doc).toMatchObject({
      v: 1,
      kind: 'cpg.index.report',
      tool: 'cpg@9.8.7',
      producedAt: new Date(0).toISOString(),
      body: {
        root,
        walk: { filesSeen: 2, filesIndexed: 2 },
        files: [
          { path: 'a.ts', revision_id: sha(files['a.ts']) },
          { path: 'b.py', revision_id: sha(files['b.py']) },
        ],
        dryRun: true,
        target: null,
        consumers: [],
      },
    });
  });
});

describe('cpg index --dry-run wiring', () => {
  it('passes session null and resumeFrom null, and never connects', async () => {
    const f = fakeEngine();
    const r = await cli(['index', '--dry-run', '/w'], f.engine);
    expect(r.code).toBe(EXIT.OK);
    expect(f.connects()).toBe(0);
    // The whole CpgConfigInput (provenance dropped) is pinned in config-verb.test.ts (U2c.1).
    expect(f.requests).toEqual([
      { config: expect.objectContaining({ root: '/w' }), session: null, resumeFrom: null },
    ]);
  });

  it("hands the engine run()'s own signal", async () => {
    const f = fakeEngine();
    const controller = new AbortController();
    await cli(['index', '--dry-run', '/w'], f.engine, { signal: controller.signal });
    expect(f.signals).toHaveLength(1);
    expect(f.signals[0]).toBe(controller.signal);
  });

  it.each([
    ['--workspace wins', ['--workspace', '/flag', '/pos'], { CPG_WORKSPACE: '/env' }, '/flag'],
    ['then the positional', ['/pos'], { CPG_WORKSPACE: '/env' }, '/pos'],
    ['then CPG_WORKSPACE', [], { CPG_WORKSPACE: '/env' }, '/env'],
    ['then cwd', [], {}, '/cwd'],
    ['a relative root resolves against cwd', ['sub/dir'], {}, '/cwd/sub/dir'],
    ['a relative --workspace resolves against cwd', ['--workspace', 'w'], {}, '/cwd/w'],
    ['a relative CPG_WORKSPACE resolves against cwd', [], { CPG_WORKSPACE: 'e' }, '/cwd/e'],
  ])('workspace root: %s', async (_name, args, env, root) => {
    const f = fakeEngine();
    await cli(['index', '--dry-run', ...args], f.engine, { env, cwd: '/cwd' });
    expect(f.requests.map((q) => q.config.root)).toEqual([root]);
  });

  it('no root from any source is a usage error, and the engine is never called', async () => {
    const f = fakeEngine();
    const r = await cli(['index', '--dry-run'], f.engine);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stdout).toEqual([]);
    expect(r.stderr.join('\n')).toMatch(/no workspace root/);
    expect(f.requests).toEqual([]);
  });

  it('text format: the summary on stdout; warnings and the timing line with consumers on stderr', async () => {
    const r = await cli(['index', '--dry-run', '/w'], fakeEngine().engine);
    expect(r.stdout).toEqual([
      'root /w',
      'files seen=3 indexed=2 excluded=0 unsupported=1 tooLarge=0 failed=0',
      'written nodes=4 edges=3 dryRun=true',
    ]);
    expect(r.stderr).toEqual([
      'cpg: warning: w1',
      'cpg: warning: w2',
      'cpg: indexed in 12 ms; consumers: none',
    ]);
  });

  it('the timing line names the consumer set when there is one', async () => {
    const report = { ...REPORT, dryRun: false, consumers: ['memory', 'falkor'], warnings: [] };
    const r = await cli(['index', '--dry-run', '/w'], fakeEngine(report).engine);
    expect(r.stderr).toEqual(['cpg: indexed in 12 ms; consumers: memory, falkor']);
  });

  it('json format: exactly the report as the body of one document', async () => {
    const r = await cli(['index', '--dry-run', '--format', 'json', '/w'], fakeEngine().engine);
    expect(r.stdout.map((l) => JSON.parse(l) as unknown)).toEqual([
      {
        v: 1,
        kind: 'cpg.index.report',
        tool: 'cpg@9.8.7',
        producedAt: '1970-01-01T00:00:00.000Z',
        body: REPORT,
      },
    ]);
  });

  it.each([[['--format', 'text']], [['--format', 'json']], [[]]])(
    '%j: stdout identical with isTty true and false (I-9)',
    async (format) => {
      const argv = ['index', '--dry-run', ...format, '/w'];
      const tty = await cli(argv, fakeEngine().engine, { isTty: true });
      const pipe = await cli(argv, fakeEngine().engine, { isTty: false });
      expect([tty.code, pipe.code]).toEqual([EXIT.OK, EXIT.OK]);
      expect(tty.stdout.length).toBeGreaterThan(0);
      expect(tty.stdout).toEqual(pipe.stdout);
    },
  );

  it('progress goes to the status line on a TTY, and --quiet silences it', async () => {
    const loud = await cli(['index', '--dry-run', '/w'], fakeEngine().engine, { isTty: true });
    expect(loud.statuses.filter((l) => /walked/.test(l))).toHaveLength(1);
    expect(loud.stderr.filter((l) => /walked/.test(l))).toEqual([]);
    const quiet = await cli(['index', '--dry-run', '--quiet', '/w'], fakeEngine().engine, {
      isTty: true,
    });
    expect(quiet.statuses).toEqual([]);
    expect(quiet.stderr.filter((l) => /walked/.test(l))).toEqual([]);
  });

  it('an interrupted report is still printed, and exits 130 (I-27)', async () => {
    const report = { ...REPORT, interrupted: true };
    const r = await cli(
      ['index', '--dry-run', '--format', 'json', '/w'],
      fakeEngine(report).engine,
    );
    expect(r.code).toBe(EXIT.INTERRUPTED);
    expect(r.stdout.map((l) => JSON.parse(l) as unknown)).toMatchObject([{ body: report }]);

    const text = await cli(['index', '--dry-run', '/w'], fakeEngine(report).engine);
    expect(text.code).toBe(EXIT.INTERRUPTED);
    expect(text.stdout[0]).toBe('root /w');
    expect(text.stdout).toHaveLength(3);
  });
});

/** A workspace with a.ts and b.py; `config` is its cpg.config.yaml, when given. */
async function workspace(config?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cpg-cli-index-'));
  roots.push(root);
  // .git bounds the config search (U2c.1): a stray cpg.config.yaml above tmpdir is never read.
  await mkdir(join(root, '.git'));
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'b.py'), 'b = 2\n');
  if (config !== undefined) await writeFile(join(root, 'cpg.config.yaml'), config);
  return root;
}

const HEADLESS = { inspect: false, store: 'memory', vscode: false };

describe('cpg index without --dry-run: the memory store consumer (U2c.2)', () => {
  it('the real engine writes its memory store: one document, consumers [memory], target null', async () => {
    const root = await workspace();
    const configs: EngineConfig[] = [];
    const r = await cli(['index', '--format', 'json', root], createEngine, { configs });

    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).toHaveLength(1);
    expect(JSON.parse(r.stdout[0] ?? '')).toMatchObject({
      kind: 'cpg.index.report',
      body: {
        root,
        walk: { filesSeen: 2, filesIndexed: 2 },
        // the root DIRECTORY and two FILEs, two HAS_ENTRY; then b.py's replace-file (U6a.3-2): its
        // MODULE, module SYMBOL and FILE rows, DEFINES and SOURCE_FILE
        nodesWritten: 6,
        edgesWritten: 4,
        dryRun: false,
        interrupted: false,
        target: null,
        consumers: ['memory'],
      },
    });
    expect(r.stderr.at(-1)).toMatch(/^cpg: indexed in \d+ ms; consumers: memory$/);
    expect(configs).toEqual([{ version: '9.8.7', consumers: HEADLESS }]);
  });

  it('text format says dryRun=false', async () => {
    const root = await workspace();
    const r = await cli(['index', root], createEngine);
    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).toEqual([
      `root ${root}`,
      'files seen=2 indexed=2 excluded=0 unsupported=0 tooLarge=0 failed=0',
      'written nodes=6 edges=4 dryRun=false',
    ]);
  });

  it('connects ONE write session to the resolved target, indexes through it, then closes it', async () => {
    const f = fakeEngine({ ...REPORT, dryRun: false });
    const configs: EngineConfig[] = [];
    const r = await cli(
      ['index', '--host', 'h', '--port', '7000', '--graph', 'g', '/w'],
      f.engine,
      { configs },
    );
    expect(r.code).toBe(EXIT.OK);
    expect(f.log).toEqual(['connect', 'index', 'close']);
    expect(f.opened).toHaveLength(1);
    expect(f.opened[0]).toMatchObject({
      target: { host: 'h', port: 7000, graph: 'g' },
      readOnly: false,
    });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.session).toBe(f.opened[0]?.session);
    expect(f.requests[0]?.resumeFrom).toBeNull();
    expect(configs).toEqual([{ version: '9.8.7', consumers: HEADLESS }]);
  });

  it('the engine is built with the resolved switches: flags over the file, per switch', async () => {
    const root = await workspace('version: 1\nconsumers: { store: falkor, vscode: false }\n');
    const configs: EngineConfig[] = [];
    // --dry-run reaches no consumer, so switches that are not built yet do not stop it. U2b.1 part
    // 3b: --inspect left out, since --dry-run refuses it (inspect-verb.test.ts).
    const r = await cli(['index', '--dry-run', '--store', 'memory', root], createEngine, {
      configs,
    });
    expect(r.code).toBe(EXIT.OK);
    expect(configs).toEqual([{ version: '9.8.7', consumers: HEADLESS }]);
  });

  it('--dry-run under switches that are not built still runs, and reaches no consumer', async () => {
    const root = await workspace('version: 1\nconsumers: { vscode: true }\n');
    const r = await cli(
      ['index', '--dry-run', '--store', 'falkor', '--format', 'json', root],
      createEngine,
    );
    expect(r.code).toBe(EXIT.OK);
    expect(JSON.parse(r.stdout[0] ?? '')).toMatchObject({ body: { dryRun: true, consumers: [] } });
  });

  it.each([
    [
      '--store falkor',
      ['--store', 'falkor'],
      undefined,
      ['consumers.store', 'falkor', '--store', 'U5'],
    ],
    [
      'a file with store: falkor',
      [],
      'version: 1\nconsumers: { store: falkor }\n',
      ['consumers.store', 'falkor', 'cpg.config.yaml', 'U5'],
    ],
    [
      'a file with vscode: true',
      [],
      'version: 1\nconsumers: { vscode: true }\n',
      [
        'consumers.vscode true',
        'cpg.config.yaml',
        'the VS Code extension turns this on itself; nothing in the CLI does',
      ],
    ],
  ] as const)(
    '%s: exit 2 "not built yet", naming the switch and its source; no engine, no connect',
    async (_name, flags, config, names) => {
      const root = await workspace(config);
      const f = fakeEngine();
      const configs: EngineConfig[] = [];
      const r = await cli(['index', ...flags, root], f.engine, { configs });
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.stdout).toEqual([]);
      const err = r.stderr.join('\n');
      expect(err).toContain('not built yet');
      for (const name of names) expect(err).toContain(name);
      expect(configs).toEqual([]);
      expect(f.connects()).toBe(0);
    },
  );

  // Decision 25: the panel is the extension's own, so the refusal says who turns the switch on and
  // no longer says the panel is unbuilt (exit code 2 and the provenance stay).
  it('a file with vscode: true: the refusal names the extension, not the panel or a unit', async () => {
    const root = await workspace('version: 1\nconsumers: { vscode: true }\n');
    const r = await cli(['index', root], fakeEngine().engine);
    expect(r.code).toBe(EXIT.USAGE);
    // Round two (review d): the whole line, so no random temp suffix can match a fragment.
    expect(r.stderr).toEqual([
      `cpg: not built yet: consumers.vscode true from file ${join(root, 'cpg.config.yaml')} (the VS Code extension turns this on itself; nothing in the CLI does)`,
    ]);
  });

  it('every switch that is not built is named, each with its own source', async () => {
    const root = await workspace('version: 1\nconsumers: { vscode: true }\n');
    const r = await cli(['index', '--store', 'falkor', root], fakeEngine().engine);
    expect(r.code).toBe(EXIT.USAGE);
    const err = r.stderr.join('\n');
    expect(err).toContain('consumers.vscode');
    expect(err).toContain(join(root, 'cpg.config.yaml'));
    expect(err).toContain('consumers.store');
    expect(err).toContain('--store');
  });

  // U2b.1 part 3b: the inspector is built, so --inspect is never on the not-built list (stop-list
  // 44, the CLI copy); the switch that is not built still stops the run before any engine.
  it('--inspect beside a switch that is not built: only that switch is named', async () => {
    const root = await workspace('version: 1\nconsumers: { store: falkor }\n');
    const configs: EngineConfig[] = [];
    const r = await cli(['index', '--inspect', root], fakeEngine().engine, { configs });
    expect(r.code).toBe(EXIT.USAGE);
    const err = r.stderr.join('\n');
    expect(err).toContain('consumers.store');
    expect(err).toContain(join(root, 'cpg.config.yaml'));
    expect(err).not.toContain('consumers.inspect');
    expect(configs).toEqual([]);
  });

  it('--store with a value outside memory|falkor is a usage error before any engine (I-12)', async () => {
    const configs: EngineConfig[] = [];
    const r = await cli(['index', '--store', 'redis', '/w'], fakeEngine().engine, { configs });
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stderr.join('\n')).toContain('--store must be one of memory, falkor');
    expect(configs).toEqual([]);
  });

  it('a failed connect exits 1 and names the endpoint', async () => {
    const f = fakeEngine();
    const failing: CpgEngine = {
      ...f.engine,
      connect: () => Promise.reject(new Error('ECONNREFUSED')),
    };
    const r = await cli(['index', '/w'], failing);
    expect(r.code).toBe(EXIT.FAILED);
    expect(r.stderr.join('\n')).toContain('127.0.0.1:6382/cpg');
    expect(f.requests).toEqual([]);
  });
});

// Round two, after the test review (named defects a4-a6, b1).
describe('cpg index without --dry-run: round two', () => {
  it('connects to the resolved store target: env and file layers, not the flags alone (a5)', async () => {
    const root = await workspace('version: 1\nstore: { falkor: { graph: fg, port: 7100 } }\n');
    const f = fakeEngine({ ...REPORT, dryRun: false });
    const r = await cli(['index', root], f.engine, { env: { CPG_HOST: 'eh' } });
    expect(r.code).toBe(EXIT.OK);
    expect(f.opened.map((o) => o.target)).toEqual([{ host: 'eh', port: 7100, graph: 'fg' }]);
  });

  it('--store memory over a file with store: falkor is the resolved winner, so it runs (a6)', async () => {
    const root = await workspace('version: 1\nconsumers: { store: falkor }\n');
    const f = fakeEngine({ ...REPORT, dryRun: false });
    const configs: EngineConfig[] = [];
    const r = await cli(['index', '--store', 'memory', root], f.engine, { configs });
    expect(r.code).toBe(EXIT.OK);
    expect(configs).toEqual([{ version: '9.8.7', consumers: HEADLESS }]);
    expect(f.log).toEqual(['connect', 'index', 'close']);
  });

  it('the write session closes even when index rejects (b1)', async () => {
    const f = fakeEngine();
    const failing: CpgEngine = {
      ...f.engine,
      index: () => Promise.reject(new Error('index-boom')),
    };
    await expect(cli(['index', '/w'], failing)).rejects.toThrow('index-boom');
    expect(f.log).toEqual(['connect', 'close']);
  });

  it('an interrupted report is still printed, the session closes, and it exits 130 (b1, I-27)', async () => {
    const report = { ...REPORT, dryRun: false, interrupted: true };
    const f = fakeEngine(report);
    const r = await cli(['index', '--format', 'json', '/w'], f.engine);
    expect(r.code).toBe(EXIT.INTERRUPTED);
    expect(r.stdout.map((l) => JSON.parse(l) as unknown)).toMatchObject([{ body: report }]);
    expect(f.log).toEqual(['connect', 'index', 'close']);
  });
});
