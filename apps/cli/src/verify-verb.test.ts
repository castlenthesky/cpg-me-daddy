// `cpg verify`, from BMO-80 ("--format=json emits one cpg.verify.report document"; exit 3 on fail,
// never 1; --strict promotes unavailable to fail) and C-CLI: verify opens a read session (I-17),
// stdout is exactly one JSON value (I-8) and never depends on isTty (I-9), diagnostics and timing
// go to stderr (I-10), a malformed flag never connects (I-12), the root is --workspace, then the
// positional, then CPG_WORKSPACE, then cwd.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CheckState,
  CpgEngine,
  EngineSession,
  IndexReport,
  StoreTarget,
  VerifyCheckId,
  VerifyConfig,
  VerifyReport,
} from '@cpg/engine';
import { createEngine } from '@cpg/engine';
import { createMemoryStore } from '@cpg/sink';
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

/** A workspace indexed through the real engine into its MemoryStore (a front door's job). */
async function indexedWorkspace(): Promise<{ root: string; engine: CpgEngine }> {
  const root = await mkdtemp(join(tmpdir(), 'cpg-cli-verify-'));
  roots.push(root);
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'b.py'), 'b = 2\n');
  const engine = createEngine({ version: manifest.version }, { sinks: [createMemoryStore()] });
  const target = { host: 'localhost', port: 6382, graph: 'cpg' };
  const session = await engine.connect(target, { readOnly: false });
  await engine.index(
    { config: { root }, session, resumeFrom: null },
    () => {},
    new AbortController().signal,
  );
  await session.close();
  return { root, engine };
}

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
  it('a freshly indexed workspace: one cpg.verify.report document, exit 0', async () => {
    const { root, engine } = await indexedWorkspace();
    const r = await cli(['verify', '--format=json', root], engine);

    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).toHaveLength(1);
    expect(JSON.parse(r.stdout[0] ?? '')).toMatchObject({
      v: 1,
      kind: 'cpg.verify.report',
      tool: 'cpg@9.8.7',
      producedAt: new Date(0).toISOString(),
      body: { state: 'unavailable', consumers: ['memory'] },
    });
    expect(body(r.stdout).checks.map((c) => c.id)).toEqual(IDS);
  });

  it('a file edited after index exits 3, never 1; the document still prints and stderr names the check', async () => {
    const { root, engine } = await indexedWorkspace();
    await writeFile(join(root, 'b.py'), 'b = 3\n');
    const r = await cli(['verify', '--format', 'json', root], engine);

    expect(r.code).toBe(EXIT.VERIFY_FAILED);
    const report = body(r.stdout);
    expect(report.state).toBe('fail');
    expect(report.checks.find((c) => c.id === 'revision-reconciliation')).toMatchObject({
      state: 'fail',
      localisedTo: ['b.py'],
    });
    expect(r.stderr.some((l) => l.includes('revision-reconciliation'))).toBe(true);
    expect(r.stderr.some((l) => l.includes('filesystem-reconciliation'))).toBe(false);
  });

  it('--strict promotes unavailable to fail: exit 3 on a graph that otherwise passes', async () => {
    const { root, engine } = await indexedWorkspace();
    const r = await cli(['verify', '--strict', '--format=json', root], engine);
    expect(r.code).toBe(EXIT.VERIFY_FAILED);
    const report = body(r.stdout);
    expect(report.state).toBe('fail');
    expect(stateOf(report, 'render-reconciliation')).toBe('fail');
    expect(stateOf(report, 'id-uniqueness')).toBe('pass');
  });

  it('text output: one line per check, in enum order, led by its id and state', async () => {
    const { root, engine } = await indexedWorkspace();
    await writeFile(join(root, 'b.py'), 'b = 3\n');
    const r = await cli(['verify', root], engine);
    expect(r.code).toBe(EXIT.VERIFY_FAILED);
    const lines = r.stdout.filter((l) => IDS.some((id) => l.startsWith(`${id} `)));
    expect(lines.map((l) => l.split(' ')[0])).toEqual(IDS);
    const revision = lines.find((l) => l.startsWith('revision-reconciliation '));
    expect(revision?.split(' ')[1]).toBe('fail');
    expect(revision).toContain('b.py');
  });

  it('stdout is byte-identical with isTty true and false (I-9); timing and consumers on stderr', async () => {
    const { root, engine } = await indexedWorkspace();
    const [tty, pipe] = [
      await cli(['verify', root], engine, { isTty: true }),
      await cli(['verify', root], engine, { isTty: false }),
    ];
    expect(tty.stdout).toEqual(pipe.stdout);
    expect(tty.code).toBe(pipe.code);
    expect(pipe.stderr.some((l) => l.includes('consumers: memory'))).toBe(true);
    expect(pipe.stdout.some((l) => / ms\b/.test(l))).toBe(false);
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

function fakeEngine(state: CheckState = 'pass', reject = false) {
  const connects: { target: StoreTarget; readOnly: boolean }[] = [];
  const calls: { session: EngineSession; config: VerifyConfig; expected: IndexReport | null }[] =
    [];
  const sessions: EngineSession[] = [];
  let closed = 0;
  const engine: CpgEngine = {
    identity: { name: 'fake', version: '0', languages: [] },
    connect: (target, opts) => {
      connects.push({ target, readOnly: opts.readOnly });
      const session = { target, close: () => Promise.resolve(void closed++) };
      sessions.push(session);
      return Promise.resolve(session);
    },
    index: () => Promise.reject(new Error('fakeEngine.index is not driven by these tests')),
    verify: (session, config, expected) => {
      calls.push({ session, config, expected });
      return reject ? Promise.reject(new Error('boom')) : Promise.resolve(REPORT(state));
    },
  };
  return { engine, connects, calls, sessions, closed: () => closed };
}

describe('cpg verify wiring', () => {
  it('connects read-only, passes {root, strict} and expected null, then closes the session', async () => {
    const f = fakeEngine();
    const r = await cli(['verify', '--strict', '--port', '7000', '/w'], f.engine);
    expect(r.code).toBe(EXIT.OK);
    expect(f.connects).toEqual([
      { target: { host: 'localhost', port: 7000, graph: 'cpg' }, readOnly: true },
    ]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.session).toBe(f.sessions[0]);
    expect(f.calls[0]?.config).toEqual({ root: '/w', strict: true });
    expect(f.calls[0]?.expected).toBeNull();
    expect(f.closed()).toBe(1);
  });

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

  it('the session closes even when verify rejects', async () => {
    const f = fakeEngine('pass', true);
    await expect(cli(['verify', '/w'], f.engine)).rejects.toThrow('boom');
    expect(f.closed()).toBe(1);
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
    ['a relative root resolves against cwd', ['sub'], {}, '/cwd/sub'],
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
