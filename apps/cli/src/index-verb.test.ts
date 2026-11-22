// `cpg index --dry-run`, from BMO-79 ("over a tmp workspace with a.ts and b.py reports filesIndexed 2
// with no store") and C-CLI: --dry-run passes session:null and never connects; the workspace root is
// --workspace, then the positional, then CPG_WORKSPACE, then cwd; one JSON document on stdout (I-8);
// diagnostics on stderr (I-10); stdout never depends on isTty (I-9); interrupted exits 130 (I-27).

import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CpgEngine, IndexReport, IndexRequest } from '@cpg/engine';
import { createEngine } from '@cpg/engine';
import { createMemoryStore } from '@cpg/sink';
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
  let connects = 0;
  const engine: CpgEngine = {
    identity: { name: 'fake', version: '0', languages: [] },
    connect: (target) => {
      connects++;
      return Promise.resolve({ target, close: () => Promise.resolve() });
    },
    index: (req, onProgress) => {
      requests.push(req);
      onProgress({ phase: 'walked', filesTotal: 3 });
      return Promise.resolve(report);
    },
  };
  return { engine, requests, connects: () => connects };
}

async function cli(
  argv: string[],
  engine: CpgEngine,
  o: { isTty?: boolean; env?: Record<string, string>; cwd?: string } = {},
) {
  const io = captureIo({ isTty: o.isTty ?? false, ...(o.env && { env: o.env }) });
  const code = await run(argv, io, {
    manifest,
    engine,
    ...(o.cwd !== undefined && { cwd: o.cwd }),
  });
  return { code, stdout: io.stdout, stderr: io.stderr };
}

describe('cpg index --dry-run with the real engine (BMO-79)', () => {
  it('a.ts and b.py: one cpg.index.report document, filesIndexed 2, no store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cpg-cli-index-'));
    roots.push(root);
    const files = { 'a.ts': 'export const a = 1;\n', 'b.py': 'b = 2\n' };
    for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
    const memory = createMemoryStore();
    const engine = createEngine({ version: manifest.version }, { sinks: [memory] });

    const r = await cli(['index', '--dry-run', '--format', 'json', root], engine);

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
    expect(await memory.inspect()).toMatchObject({ highWaterSeq: -1, nodeCount: 0, edgeCount: 0 });
  });
});

describe('cpg index --dry-run wiring', () => {
  it('passes session null and resumeFrom null, and never connects', async () => {
    const f = fakeEngine();
    const r = await cli(['index', '--dry-run', '/w'], f.engine);
    expect(r.code).toBe(EXIT.OK);
    expect(f.connects()).toBe(0);
    expect(f.requests).toEqual([{ config: { root: '/w' }, session: null, resumeFrom: null }]);
  });

  it.each([
    ['--workspace wins', ['--workspace', '/flag', '/pos'], { CPG_WORKSPACE: '/env' }, '/flag'],
    ['then the positional', ['/pos'], { CPG_WORKSPACE: '/env' }, '/pos'],
    ['then CPG_WORKSPACE', [], { CPG_WORKSPACE: '/env' }, '/env'],
    ['then cwd', [], {}, '/cwd'],
    ['a relative root resolves against cwd', ['sub/dir'], {}, '/cwd/sub/dir'],
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

  it.each([['text'], ['json']])(
    '%s: stdout identical with isTty true and false (I-9)',
    async (format) => {
      const argv = ['index', '--dry-run', '--format', format, '/w'];
      const tty = await cli(argv, fakeEngine().engine, { isTty: true });
      const pipe = await cli(argv, fakeEngine().engine, { isTty: false });
      expect([tty.code, pipe.code]).toEqual([EXIT.OK, EXIT.OK]);
      expect(tty.stdout.length).toBeGreaterThan(0);
      expect(tty.stdout).toEqual(pipe.stdout);
    },
  );

  it('progress goes to the status line on a TTY, and --quiet silences it', async () => {
    const loud = await cli(['index', '--dry-run', '/w'], fakeEngine().engine, { isTty: true });
    expect(loud.stderr.filter((l) => /walked/.test(l))).toHaveLength(1);
    const quiet = await cli(['index', '--dry-run', '--quiet', '/w'], fakeEngine().engine, {
      isTty: true,
    });
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
  });
});
