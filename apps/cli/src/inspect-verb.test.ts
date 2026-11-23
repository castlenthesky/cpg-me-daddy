// `cpg inspect <payload.json|->` and `cpg index --inspect` through run(), with a fake inspector in
// place of the child process. Sources:
// - BMO-35 line 4: `cpg inspect <payload.json|->` renders a saved payload, and `cpg index --inspect`
//   opens the picture live and prints the URL on stderr.
// - Controller decision 20: inspect reads a saved cpg.graph.payload and validates it at the
//   boundary. index --inspect runs index, verify, then CpgEngine.inspect, and stays up until Ctrl-C
//   (130) or the child exits. --dry-run with --inspect is a usage error.
// - Controller decision 21: render-reconciliation comes from each render-report, `unavailable`
//   until the first. The verification is re-sent only when that check changes.
// - Controller decision 22: a saved payload's five workspace checks are `unavailable`.
// - Controller decision 23: the verification's seq is the lowest asOfSeq.
// - C-EXT I-10: a duplicate id is a failing render-reconciliation, so the payload is not refused.
// - 08-verification §3.3: the graph is never shown without its verdict.
// Expected values come from those sources and the design notes, never from running the code.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CheckResult,
  CpgEngine,
  EngineConfig,
  EngineSession,
  IndexConfig,
  IndexReport,
  VerifyCheckId,
} from '@cpg/engine';
import { createEngine } from '@cpg/engine';
import { isWorkspacePath, makeNodeId, type GraphPayload, type RenderReport } from '@cpg/model';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  InspectorExit,
  InspectorHandlers,
  InspectorLine,
  StartInspector,
} from './inspector-process';
import { captureIo } from './io';
import { EXIT, run } from './run';
import { COMMANDS } from './spec';

const manifest = { bin: 'cpg', version: '9.8.7' };
const URL = 'http://127.0.0.1:4100/';
const SAVED = 'a saved payload has no workspace to check';
const WAITING = `no render-report yet: open ${URL}`;
const CHECK_IDS: readonly VerifyCheckId[] = [
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

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cpg-cli-inspect-'));
  roots.push(dir);
  return dir;
}

const PAYLOAD: GraphPayload = {
  seq: 4,
  nodes: [
    { id: 'd', type: 'DIRECTORY', name: '.' },
    { id: 'f', type: 'FILE', name: 'a.ts', data: { path: 'a.ts' } },
  ],
  edges: [{ source: 'd', target: 'f', type: 'HAS_ENTRY' }],
};

const envelope = (body: unknown, o: Readonly<Record<string, unknown>> = {}): string =>
  JSON.stringify({
    v: 1,
    kind: 'cpg.graph.payload',
    tool: 'cpg@9.8.7',
    producedAt: '2026-11-22T00:00:00.000Z',
    body,
    ...o,
  });

async function payloadFile(text: string, name = 'payload.json'): Promise<string> {
  const dir = await tmp();
  const file = join(dir, name);
  await writeFile(file, text);
  return file;
}

const renderReport = (o: Partial<RenderReport> = {}): RenderReport => ({
  payloadNodeCount: 2,
  renderedNodeCount: 2,
  renderedEdgeCount: 1,
  duplicateEdges: 0,
  droppedNodeIds: [],
  frameMs: 3,
  ...o,
});

/** A StartInspector that records each line it is sent and lets the test play the child. */
function fakeInspector(o: { failStart?: Error } = {}) {
  const sent: InspectorLine[] = [];
  const handlers: InspectorHandlers[] = [];
  let stops = 0;
  let settle: ((exit: InspectorExit) => void) | undefined;
  const exited = new Promise<InspectorExit>((resolve) => {
    settle = resolve;
  });
  const start: StartInspector = (h) => {
    if (o.failStart !== undefined) return Promise.reject(o.failStart);
    handlers.push(h);
    return Promise.resolve({
      url: URL,
      send: (line: InspectorLine) => void sent.push(line),
      exited,
      stop: async () => {
        stops += 1;
        settle?.({ code: 0, signal: null });
        await exited;
      },
    });
  };
  return {
    start,
    sent,
    starts: () => handlers.length,
    stops: () => stops,
    /** The page reports at `seq` (epoch 1: the CLI sends one graph). */
    report: (seq: number, r: Partial<RenderReport> = {}) =>
      handlers[0]?.onRenderReport({
        type: 'render-report',
        epoch: 1,
        seq,
        report: renderReport(r),
      }),
    exit: (exit: InspectorExit) => settle?.(exit),
  };
}

type Fake = ReturnType<typeof fakeInspector>;

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Starts run() and leaves it running; abort() is Ctrl-C. */
function live(
  argv: string[],
  o: {
    stdin?: string;
    cwd?: string;
    inspector?: Fake;
    engine?: CpgEngine;
    configs?: EngineConfig[];
    noInspector?: boolean;
    /** Round two (review b4): a start that is not the fake's. */
    start?: StartInspector;
  } = {},
) {
  const io = captureIo(o.stdin !== undefined ? { stdin: o.stdin } : {});
  const inspector = o.inspector ?? fakeInspector();
  const controller = new AbortController();
  let code: number | undefined;
  const done = run(argv, io, {
    manifest,
    createEngine: (config: EngineConfig) => {
      o.configs?.push(config);
      return o.engine ?? createEngine(config);
    },
    ...(o.noInspector === true ? {} : { startInspector: o.start ?? inspector.start }),
    cwd: o.cwd ?? tmpdir(),
    signal: controller.signal,
  }).then((c) => {
    code = c;
    return c;
  });
  return { io, inspector, done, abort: () => controller.abort(), code: () => code };
}

const savedCheck = (id: VerifyCheckId, asOfSeq = 4): CheckResult => ({
  id,
  state: 'unavailable',
  observed: 0,
  expected: 0,
  localisedTo: [],
  detail: SAVED,
  asOfSeq,
});

const waiting = (asOfSeq: number): CheckResult => ({
  id: 'render-reconciliation',
  state: 'unavailable',
  observed: 0,
  expected: 0,
  localisedTo: [],
  detail: WAITING,
  asOfSeq,
});

const verificationAt = (f: Fake, i: number) => {
  const line = f.sent[i];
  if (line?.type !== 'verification') throw new Error(`line ${i} is not a verification`);
  return line.report;
};

const renderAt = (f: Fake, i: number): CheckResult | undefined =>
  verificationAt(f, i).checks.find((c) => c.id === 'render-reconciliation');

describe('cpg inspect <payload.json|-> (controller decisions 20 and 22)', () => {
  it('sends the graph, then its verdict; prints the URL on stderr; stays up until Ctrl-C (130)', async () => {
    const file = await payloadFile(envelope(PAYLOAD));
    const l = live(['inspect', file]);
    await until(() => l.inspector.sent.length >= 2, 'the graph and the verification');
    expect(l.inspector.sent).toEqual([
      { type: 'graph', payload: PAYLOAD },
      {
        type: 'verification',
        report: {
          seq: 4,
          state: 'unavailable',
          checks: [
            savedCheck('filesystem-reconciliation'),
            savedCheck('identity-invariants'),
            savedCheck('id-uniqueness'),
            waiting(4),
            savedCheck('revision-reconciliation'),
            savedCheck('resolution-health'),
          ],
        },
      },
    ]);
    expect(l.io.stderr).toContain(
      `cpg: inspector at ${URL} (open it in a browser; Ctrl-C stops it)`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(l.code()).toBeUndefined();
    expect(l.inspector.stops()).toBe(0);

    l.abort();
    expect(await l.done).toBe(EXIT.INTERRUPTED);
    expect(l.io.stderr).toContain('cpg: interrupted');
    expect(l.inspector.stops()).toBeGreaterThanOrEqual(1);
    expect(l.io.stdout).toEqual([]);
  });

  it('a relative path is read from the cwd', async () => {
    const file = await payloadFile(envelope(PAYLOAD), 'saved.json');
    const l = live(['inspect', 'saved.json'], { cwd: join(file, '..') });
    await until(() => l.inspector.sent.length >= 1, 'the graph');
    expect(l.inspector.sent[0]).toEqual({ type: 'graph', payload: PAYLOAD });
    l.abort();
    expect(await l.done).toBe(EXIT.INTERRUPTED);
  });

  it('- reads the document from stdin', async () => {
    const l = live(['inspect', '-'], { stdin: envelope(PAYLOAD) });
    await until(() => l.inspector.sent.length >= 1, 'the graph');
    expect(l.inspector.sent[0]).toEqual({ type: 'graph', payload: PAYLOAD });
    l.abort();
    expect(await l.done).toBe(EXIT.INTERRUPTED);
  });

  it('every node drawn: a new verification with render-reconciliation pass at the payload seq', async () => {
    const l = live(['inspect', await payloadFile(envelope(PAYLOAD))]);
    await until(() => l.inspector.sent.length >= 2, 'the verification');
    l.inspector.report(4);
    await until(() => l.inspector.sent.length >= 3, 'the second verification');
    expect(verificationAt(l.inspector, 2)).toEqual({
      seq: 4,
      // the five workspace checks are still unavailable
      state: 'unavailable',
      checks: [
        savedCheck('filesystem-reconciliation'),
        savedCheck('identity-invariants'),
        savedCheck('id-uniqueness'),
        {
          id: 'render-reconciliation',
          state: 'pass',
          observed: 2,
          expected: 2,
          localisedTo: [],
          asOfSeq: 4,
        },
        savedCheck('revision-reconciliation'),
        savedCheck('resolution-health'),
      ],
    });
    expect(l.io.stderr).toContain('cpg: render-reconciliation pass');
    l.abort();
    await l.done;
  });

  it('the same report again sends nothing; a report that changes the check sends it', async () => {
    const l = live(['inspect', await payloadFile(envelope(PAYLOAD))]);
    await until(() => l.inspector.sent.length >= 2, 'the verification');
    l.inspector.report(4);
    await until(() => l.inspector.sent.length >= 3, 'the pass');
    // a page reload: the same counts, another frame time
    l.inspector.report(4, { frameMs: 99 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(l.inspector.sent).toHaveLength(3);

    l.inspector.report(4, { renderedNodeCount: 1, droppedNodeIds: ['f'] });
    await until(() => l.inspector.sent.length >= 4, 'the fail');
    expect(verificationAt(l.inspector, 3).state).toBe('fail');
    expect(renderAt(l.inspector, 3)).toMatchObject({
      state: 'fail',
      observed: 1,
      expected: 2,
      localisedTo: ['f'],
      detail: '1 of 2 payload nodes drawn',
    });
    expect(l.io.stderr).toContain('cpg: render-reconciliation fail: 1 of 2 payload nodes drawn');
    l.abort();
    await l.done;
  });

  it('a report at an older seq is stale, never pass (C-EXT I-19)', async () => {
    const l = live(['inspect', await payloadFile(envelope(PAYLOAD))]);
    await until(() => l.inspector.sent.length >= 2, 'the verification');
    l.inspector.report(3);
    await until(() => l.inspector.sent.length >= 3, 'the stale verification');
    expect(renderAt(l.inspector, 2)).toMatchObject({ state: 'stale', asOfSeq: 4 });
    expect(verificationAt(l.inspector, 2).state).toBe('stale');
    l.abort();
    await l.done;
  });

  it('a duplicate id is not refused: it reaches the page and fails render-reconciliation (I-10)', async () => {
    const dup = { ...PAYLOAD, nodes: [...PAYLOAD.nodes, { id: 'f', type: 'FILE' }] };
    const l = live(['inspect', await payloadFile(envelope(dup))]);
    await until(() => l.inspector.sent.length >= 2, 'the verification');
    expect(l.inspector.sent[0]).toEqual({ type: 'graph', payload: dup });
    expect(
      l.io.stderr.some((line) =>
        line.startsWith('cpg: warning: payload defect duplicate-node-id: '),
      ),
    ).toBe(true);
    l.inspector.report(4, { payloadNodeCount: 3, renderedNodeCount: 2, droppedNodeIds: ['f'] });
    await until(() => l.inspector.sent.length >= 3, 'the fail');
    expect(verificationAt(l.inspector, 2).state).toBe('fail');
    l.abort();
    await l.done;
  });

  it('payload defects: ten warning lines at most, then a count of the rest', async () => {
    const dangling = Array.from({ length: 12 }, (_, i) => ({ source: 'd', target: `gone${i}` }));
    const l = live(['inspect', await payloadFile(envelope({ ...PAYLOAD, edges: dangling }))]);
    await until(() => l.inspector.sent.length >= 2, 'the verification');
    const defects = l.io.stderr.filter((line) => line.startsWith('cpg: warning: payload defect '));
    expect(defects).toHaveLength(10);
    expect(defects.every((line) => line.includes('dangling-edge'))).toBe(true);
    expect(l.io.stderr).toContain('cpg: warning: and 2 more payload defects');
    l.abort();
    await l.done;
  });

  it('a clean payload prints no defect warning', async () => {
    const l = live(['inspect', await payloadFile(envelope(PAYLOAD))]);
    await until(() => l.inspector.sent.length >= 2, 'the verification');
    expect(l.io.stderr.filter((line) => line.startsWith('cpg: warning:'))).toEqual([]);
    l.abort();
    await l.done;
  });

  it('the child exiting on its own: exit 1 naming the inspector, and it is still stopped', async () => {
    const l = live(['inspect', await payloadFile(envelope(PAYLOAD))]);
    await until(() => l.inspector.sent.length >= 2, 'the verification');
    l.inspector.exit({ code: 3, signal: null });
    expect(await l.done).toBe(EXIT.FAILED);
    expect(l.io.stderr.join('\n')).toMatch(/^cpg: .*inspector exited.*3/m);
    expect(l.inspector.stops()).toBeGreaterThanOrEqual(1);
  });

  it('the child ended by SIGINT (Ctrl-C reaches the process group): exit 130', async () => {
    const l = live(['inspect', await payloadFile(envelope(PAYLOAD))]);
    await until(() => l.inspector.sent.length >= 2, 'the verification');
    l.inspector.exit({ code: null, signal: 'SIGINT' });
    expect(await l.done).toBe(EXIT.INTERRUPTED);
    expect(l.io.stderr).toContain('cpg: interrupted');
  });

  it('an inspector that cannot start: exit 1, the reason on stderr', async () => {
    const inspector = fakeInspector({ failStart: new Error('spawn boom') });
    const l = live(['inspect', await payloadFile(envelope(PAYLOAD))], { inspector });
    expect(await l.done).toBe(EXIT.FAILED);
    expect(l.io.stderr.join('\n')).toMatch(/^cpg: cannot start the inspector: .*spawn boom/m);
  });

  it('no inspector wired: exit 2 "not built yet", before the payload is read', async () => {
    const l = live(['inspect', join(tmpdir(), 'cpg-no-such-payload.json')], { noInspector: true });
    expect(await l.done).toBe(EXIT.USAGE);
    expect(l.io.stderr).toEqual(["cpg: 'inspect' is not built yet"]);
  });

  it('no payload given: a usage error naming it; nothing starts', async () => {
    const l = live(['inspect']);
    expect(await l.done).toBe(EXIT.USAGE);
    expect(l.io.stderr.join('\n')).toMatch(/payload/);
    expect(l.inspector.starts()).toBe(0);
  });

  // Round two (review b3): --format, --port and --graph too
  it.each([
    ['--host', 'h'],
    ['--workspace', '/w'],
    ['--serve'],
    ['--format', 'json'],
    ['--port', '1'],
    ['--graph', 'g'],
  ])('no store, workspace or serve flag: %s is a usage error', async (...flag) => {
    const l = live(['inspect', ...flag, '-'], { stdin: envelope(PAYLOAD) });
    expect(await l.done).toBe(EXIT.USAGE);
    expect(l.inspector.starts()).toBe(0);
  });

  it('a file that cannot be read: exit 2 naming the path; nothing starts', async () => {
    const missing = join(await tmp(), 'missing.json');
    const l = live(['inspect', missing]);
    expect(await l.done).toBe(EXIT.USAGE);
    const err = l.io.stderr.join('\n');
    expect(err).toContain(missing);
    expect(err).toContain('cannot read');
    expect(l.inspector.starts()).toBe(0);
  });

  it('stdin that is not JSON: exit 2 naming stdin', async () => {
    const l = live(['inspect', '-'], { stdin: 'nope' });
    expect(await l.done).toBe(EXIT.USAGE);
    expect(l.io.stderr.join('\n')).toMatch(/stdin.*not JSON/);
    expect(l.inspector.starts()).toBe(0);
  });

  it.each([
    ['not JSON', '{"v":1,', 'not JSON'],
    ['another kind', envelope(PAYLOAD, { kind: 'cpg.index.report' }), 'not a cpg.graph.payload'],
    ['v 2', envelope(PAYLOAD, { v: 2 }), 'not a cpg.graph.payload'],
    ['no tool', envelope(PAYLOAD, { tool: undefined }), 'not a cpg.graph.payload'],
    ['a numeric producedAt', envelope(PAYLOAD, { producedAt: 0 }), 'not a cpg.graph.payload'],
    ['no body', envelope(undefined), 'not a cpg.graph.payload'],
    ['a bare payload', JSON.stringify(PAYLOAD), 'not a cpg.graph.payload'],
    ['an array', '[]', 'not a cpg.graph.payload'],
    ['a null body', envelope(null), 'not a GraphPayload'],
    ['nodes not an array', envelope({ ...PAYLOAD, nodes: {} }), 'not a GraphPayload'],
    ['edges missing', envelope({ seq: 0, nodes: [] }), 'not a GraphPayload'],
    ['a fractional seq', envelope({ ...PAYLOAD, seq: 1.5 }), 'not a GraphPayload'],
    ['seq below -1', envelope({ ...PAYLOAD, seq: -2 }), 'not a GraphPayload'],
    ['a string seq', envelope({ ...PAYLOAD, seq: '4' }), 'not a GraphPayload'],
    [
      'a numeric node id',
      envelope({ ...PAYLOAD, nodes: [{ id: 1, type: 'FILE' }] }),
      'GraphPayload',
    ],
    ['a node with no type', envelope({ ...PAYLOAD, nodes: [{ id: 'f' }] }), 'not a GraphPayload'],
    [
      'a numeric node name',
      envelope({ ...PAYLOAD, nodes: [{ id: 'f', type: 'FILE', name: 7 }] }),
      'not a GraphPayload',
    ],
    [
      'array node data',
      envelope({ ...PAYLOAD, nodes: [{ id: 'f', type: 'FILE', data: [] }] }),
      'not a GraphPayload',
    ],
    ['a null node', envelope({ ...PAYLOAD, nodes: [null] }), 'not a GraphPayload'],
    ['an edge with no target', envelope({ ...PAYLOAD, edges: [{ source: 'd' }] }), 'GraphPayload'],
    [
      'a numeric edge type',
      envelope({ ...PAYLOAD, edges: [{ source: 'd', target: 'f', type: 1 }] }),
      'not a GraphPayload',
    ],
    [
      'string edge data',
      envelope({ ...PAYLOAD, edges: [{ source: 'd', target: 'f', data: 'x' }] }),
      'not a GraphPayload',
    ],
  ])('%s: exit 2 naming the file and why; nothing starts', async (_name, text, reason) => {
    const file = await payloadFile(text);
    const l = live(['inspect', file]);
    expect(await l.done).toBe(EXIT.USAGE);
    const err = l.io.stderr.join('\n');
    expect(err).toContain(file);
    expect(err).toContain(reason);
    expect(l.inspector.starts()).toBe(0);
  });
});

// --- cpg index --inspect -------------------------------------------------------------------------

function wp(s: string) {
  if (!isWorkspacePath(s)) throw new Error(`not a WorkspacePath: ${s}`);
  return s;
}

/** A workspace with a.ts and b.py; `config` is its cpg.config.yaml, when given. */
async function workspace(config?: string): Promise<string> {
  const root = await tmp();
  // .git bounds the config search (U2c.1): a stray cpg.config.yaml above tmpdir is never read.
  await mkdir(join(root, '.git'));
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'b.py'), 'b = 2\n');
  if (config !== undefined) await writeFile(join(root, 'cpg.config.yaml'), config);
  return root;
}

const INDEXED: IndexReport = {
  root: '/w',
  walk: {
    filesSeen: 2,
    filesIndexed: 2,
    filesExcluded: 0,
    filesUnsupported: 0,
    filesTooLarge: 0,
    filesFailed: 0,
  },
  files: [],
  nodesWritten: 3,
  edgesWritten: 2,
  durationMs: 1,
  dryRun: false,
  interrupted: false,
  warnings: [],
  target: null,
  consumers: ['memory'],
};

/** An engine that logs each call; verify's checks carry `asOfSeq[i]` (default 4). */
function scriptedEngine(
  o: { interrupted?: boolean; asOfSeq?: readonly number[]; payload?: GraphPayload } = {},
) {
  const log: string[] = [];
  const sessions: { readOnly: boolean; session: EngineSession }[] = [];
  const verified: EngineSession[] = [];
  const inspected: { session: EngineSession; config: IndexConfig }[] = [];
  const engine: CpgEngine = {
    identity: { name: 'scripted', version: '0', languages: [] },
    connect: (target, opts) => {
      log.push(opts.readOnly ? 'connect:read' : 'connect:write');
      const session: EngineSession = {
        target,
        close: () => {
          log.push('close');
          return Promise.resolve();
        },
      };
      sessions.push({ readOnly: opts.readOnly, session });
      return Promise.resolve(session);
    },
    index: () => {
      log.push('index');
      return Promise.resolve({ ...INDEXED, interrupted: o.interrupted ?? false });
    },
    verify: (session) => {
      log.push('verify');
      verified.push(session);
      const checks = CHECK_IDS.map((id, i): CheckResult => ({
        id,
        state: id === 'render-reconciliation' ? 'unavailable' : 'pass',
        observed: 1,
        expected: 1,
        localisedTo: [],
        ...(id === 'render-reconciliation' && { detail: 'no renderer consumer is enabled' }),
        asOfSeq: o.asOfSeq?.[i] ?? 4,
      }));
      return Promise.resolve({
        state: 'unavailable',
        checks,
        consumers: ['memory'],
        durationMs: 1,
      });
    },
    inspect: (session, config) => {
      log.push('inspect');
      inspected.push({ session, config });
      return Promise.resolve(o.payload ?? PAYLOAD);
    },
    schema: () => {
      throw new Error('scriptedEngine.schema is not driven by these tests');
    },
  };
  return { engine, log, sessions, verified, inspected };
}

const passing = (id: VerifyCheckId): CheckResult => ({
  id,
  state: 'pass',
  observed: 1,
  expected: 1,
  localisedTo: [],
  asOfSeq: 4,
});

describe('cpg index --inspect (controller decisions 20, 21, 23)', () => {
  it('the real engine: the report on stdout, the memory payload and its verdict to the inspector', async () => {
    const root = await workspace();
    const l = live(['index', root, '--inspect']);
    await until(() => l.inspector.sent.length >= 2, 'the graph and the verification');
    // the index report is printed before the picture starts
    expect(l.io.stdout).toEqual([
      `root ${root}`,
      'files seen=2 indexed=2 excluded=0 unsupported=0 tooLarge=0 failed=0',
      'written nodes=3 edges=2 dryRun=false',
    ]);
    const [graph] = l.inspector.sent;
    if (graph?.type !== 'graph') throw new Error('the first line is not the graph');
    // merge-filesystem folds no delta: the store is at the fresh seq
    expect(graph.payload.seq).toBe(-1);
    expect(graph.payload.nodes.map((n) => n.id).toSorted()).toEqual(
      [
        makeNodeId({ form: 'directory', path: wp('.') }),
        makeNodeId({ form: 'file', path: wp('a.ts') }),
        makeNodeId({ form: 'file', path: wp('b.py') }),
      ].toSorted(),
    );
    expect(graph.payload.edges).toHaveLength(2);
    const report = verificationAt(l.inspector, 1);
    expect(report.seq).toBe(-1);
    expect(report.state).toBe('unavailable');
    expect(report.checks.map((c) => [c.id, c.state])).toEqual([
      ['filesystem-reconciliation', 'pass'],
      ['identity-invariants', 'unavailable'],
      ['id-uniqueness', 'pass'],
      ['render-reconciliation', 'unavailable'],
      ['revision-reconciliation', 'pass'],
      ['resolution-health', 'unavailable'],
    ]);
    expect(renderAt(l.inspector, 1)).toEqual(waiting(-1));
    expect(l.io.stderr).toContain(
      `cpg: inspector at ${URL} (open it in a browser; Ctrl-C stops it)`,
    );
    l.abort();
    expect(await l.done).toBe(EXIT.INTERRUPTED);
    expect(l.inspector.stops()).toBeGreaterThanOrEqual(1);
  });

  it('the page reports every node: render-reconciliation pass in a new verification', async () => {
    const root = await workspace();
    const l = live(['index', root, '--inspect']);
    await until(() => l.inspector.sent.length >= 2, 'the verification');
    l.inspector.report(-1, { payloadNodeCount: 3, renderedNodeCount: 3 });
    await until(() => l.inspector.sent.length >= 3, 'the pass');
    expect(renderAt(l.inspector, 2)).toEqual({
      id: 'render-reconciliation',
      state: 'pass',
      observed: 3,
      expected: 3,
      localisedTo: [],
      asOfSeq: -1,
    });
    l.abort();
    await l.done;
  });

  it('--format json: one cpg.index.report document on stdout, then the picture', async () => {
    const root = await workspace();
    const l = live(['index', root, '--inspect', '--format', 'json']);
    await until(() => l.inspector.sent.length >= 2, 'the verification');
    expect(l.io.stdout).toHaveLength(1);
    expect(l.io.stdout[0]).toMatch(/"kind":"cpg\.index\.report"/);
    l.abort();
    await l.done;
  });

  it('a cpg.config.yaml with consumers.inspect true switches it on without the flag', async () => {
    const root = await workspace('version: 1\nconsumers: { inspect: true }\n');
    const l = live(['index', root]);
    await until(() => l.inspector.sent.length >= 2, 'the verification');
    expect(l.inspector.starts()).toBe(1);
    l.abort();
    expect(await l.done).toBe(EXIT.INTERRUPTED);
  });

  it('index, then ONE read session for verify and inspect, closed before the picture starts', async () => {
    const s = scriptedEngine();
    const l = live(['index', '/w', '--inspect'], { engine: s.engine });
    await until(() => l.inspector.sent.length >= 2, 'the verification');
    expect(s.log).toEqual([
      'connect:write',
      'index',
      'close',
      'connect:read',
      'verify',
      'inspect',
      'close',
    ]);
    const read = s.sessions[1]?.session;
    expect(s.sessions[1]?.readOnly).toBe(true);
    expect(s.verified).toEqual([read]);
    expect(s.inspected.map((i) => i.session)).toEqual([read]);
    expect(s.inspected[0]?.config.root).toBe('/w');
    expect(l.inspector.sent[0]).toEqual({ type: 'graph', payload: PAYLOAD });
    l.abort();
    await l.done;
  });

  it("the engine's render-reconciliation is replaced; the other five are sent as verify made them", async () => {
    const s = scriptedEngine();
    const l = live(['index', '/w', '--inspect'], { engine: s.engine });
    await until(() => l.inspector.sent.length >= 2, 'the verification');
    const report = verificationAt(l.inspector, 1);
    expect(report.checks.map((c) => c.id)).toEqual(CHECK_IDS);
    expect(renderAt(l.inspector, 1)).toEqual(waiting(4));
    expect(report.checks.filter((c) => c.id !== 'render-reconciliation')).toEqual(
      CHECK_IDS.filter((id) => id !== 'render-reconciliation').map((id) => ({
        id,
        state: 'pass',
        observed: 1,
        expected: 1,
        localisedTo: [],
        asOfSeq: 4,
      })),
    );
    // worst of five passes and an unavailable
    expect(report.state).toBe('unavailable');
    l.abort();
    await l.done;
  });

  it("the verification's seq is the lowest asOfSeq of its checks (decision 23)", async () => {
    const s = scriptedEngine({ asOfSeq: [4, 4, 3, 4, 4, 4] });
    const l = live(['index', '/w', '--inspect'], { engine: s.engine });
    await until(() => l.inspector.sent.length >= 2, 'the verification');
    expect(verificationAt(l.inspector, 1).seq).toBe(3);
    l.abort();
    await l.done;
  });

  it('a pass from the page makes the whole verdict pass when verify passed the rest', async () => {
    const s = scriptedEngine();
    const engine: CpgEngine = {
      ...s.engine,
      verify: () =>
        Promise.resolve({
          state: 'pass',
          checks: CHECK_IDS.map(passing),
          consumers: ['memory'],
          durationMs: 1,
        }),
    };
    const l = live(['index', '/w', '--inspect'], { engine });
    await until(() => l.inspector.sent.length >= 2, 'the verification');
    expect(verificationAt(l.inspector, 1).state).toBe('unavailable');
    l.inspector.report(4);
    await until(() => l.inspector.sent.length >= 3, 'the pass');
    expect(verificationAt(l.inspector, 2).state).toBe('pass');
    l.abort();
    await l.done;
  });

  it('an interrupted index exits 130 and starts no picture', async () => {
    const s = scriptedEngine({ interrupted: true });
    const l = live(['index', '/w', '--inspect'], { engine: s.engine });
    expect(await l.done).toBe(EXIT.INTERRUPTED);
    expect(l.inspector.starts()).toBe(0);
    expect(s.log).not.toContain('verify');
  });

  it('--dry-run with --inspect: a usage error naming the switch and its source; no engine', async () => {
    const configs: EngineConfig[] = [];
    const l = live(['index', '/w', '--dry-run', '--inspect'], { configs });
    expect(await l.done).toBe(EXIT.USAGE);
    const err = l.io.stderr.join('\n');
    expect(err).toContain('consumers.inspect');
    expect(err).toContain('--inspect');
    expect(err).toContain('--dry-run');
    expect(configs).toEqual([]);
    expect(l.inspector.starts()).toBe(0);
  });

  it('--dry-run in a workspace whose file switches inspect on: refused, naming the file', async () => {
    const root = await workspace('version: 1\nconsumers: { inspect: true }\n');
    const configs: EngineConfig[] = [];
    const l = live(['index', root, '--dry-run'], { configs });
    expect(await l.done).toBe(EXIT.USAGE);
    expect(l.io.stderr.join('\n')).toContain(join(root, 'cpg.config.yaml'));
    expect(configs).toEqual([]);
  });

  it('--dry-run without inspect still runs headless and starts nothing', async () => {
    const root = await workspace();
    const l = live(['index', root, '--dry-run']);
    expect(await l.done).toBe(EXIT.OK);
    expect(l.inspector.starts()).toBe(0);
  });

  it('cpg index without inspect starts nothing and exits 0', async () => {
    const root = await workspace();
    const l = live(['index', root]);
    expect(await l.done).toBe(EXIT.OK);
    expect(l.inspector.starts()).toBe(0);
  });

  it('no inspector wired: exit 2 "not built yet" before any engine', async () => {
    const configs: EngineConfig[] = [];
    const l = live(['index', '/w', '--inspect'], { noInspector: true, configs });
    expect(await l.done).toBe(EXIT.USAGE);
    expect(l.io.stderr.join('\n')).toMatch(/not built yet/);
    expect(configs).toEqual([]);
  });

  it('the child exiting on its own: exit 1', async () => {
    const s = scriptedEngine();
    const l = live(['index', '/w', '--inspect'], { engine: s.engine });
    await until(() => l.inspector.sent.length >= 2, 'the verification');
    l.inspector.exit({ code: 1, signal: null });
    expect(await l.done).toBe(EXIT.FAILED);
    expect(l.inspector.stops()).toBeGreaterThanOrEqual(1);
  });
});

// Round two, after the test review (named defects a1-a5, a8, b3, b4).
describe('cpg inspect and cpg index --inspect: round two', () => {
  it('a change within one state still re-sends: fail with other counts, pass gaining duplicates (a1)', async () => {
    const l = live(['inspect', await payloadFile(envelope(PAYLOAD))]);
    await until(() => l.inspector.sent.length >= 2, 'the verification');
    l.inspector.report(4, { renderedNodeCount: 1, droppedNodeIds: ['f'] });
    await until(() => l.inspector.sent.length >= 3, 'the first fail');
    l.inspector.report(4, { renderedNodeCount: 0, droppedNodeIds: ['f', 'd'] });
    await until(() => l.inspector.sent.length >= 4, 'the second fail');
    expect(renderAt(l.inspector, 3)).toMatchObject({
      state: 'fail',
      observed: 0,
      localisedTo: ['d', 'f'],
    });
    l.inspector.report(4);
    await until(() => l.inspector.sent.length >= 5, 'the pass');
    l.inspector.report(4, { duplicateEdges: 1 });
    await until(() => l.inspector.sent.length >= 6, 'the pass with a duplicate edge');
    expect(renderAt(l.inspector, 5)).toMatchObject({
      state: 'pass',
      detail: '1 duplicate edge drawn once',
    });
    l.abort();
    await l.done;
  });

  it('a payload at seq -1 (a fresh store) is accepted, and its verdict is at seq -1 (a2)', async () => {
    const fresh = { ...PAYLOAD, seq: -1 };
    const l = live(['inspect', await payloadFile(envelope(fresh))]);
    await until(() => l.inspector.sent.length >= 2, 'the verification');
    expect(l.inspector.sent[0]).toEqual({ type: 'graph', payload: fresh });
    expect(verificationAt(l.inspector, 1).seq).toBe(-1);
    expect(renderAt(l.inspector, 1)).toEqual(waiting(-1));
    l.abort();
    await l.done;
  });

  it("the render check's asOfSeq (the payload's) counts toward the lowest seq (a3)", async () => {
    const s = scriptedEngine({ payload: { ...PAYLOAD, seq: 2 } });
    const l = live(['index', '/w', '--inspect'], { engine: s.engine });
    await until(() => l.inspector.sent.length >= 2, 'the verification');
    expect(renderAt(l.inspector, 1)).toEqual(waiting(2));
    expect(verificationAt(l.inspector, 1).seq).toBe(2);
    l.abort();
    await l.done;
  });

  it.each([
    [{ code: null, signal: 'SIGTERM' }, /signal SIGTERM/],
    [{ code: 0, signal: null }, /code 0/],
  ])('the child ending %j on its own is exit 1, not 130 or 0 (a4)', async (exit, said) => {
    const l = live(['inspect', await payloadFile(envelope(PAYLOAD))]);
    await until(() => l.inspector.sent.length >= 2, 'the verification');
    l.inspector.exit(exit);
    expect(await l.done).toBe(EXIT.FAILED);
    expect(l.io.stderr.join('\n')).toMatch(said);
  });

  it.each([
    ['null node data', { ...PAYLOAD, nodes: [{ id: 'f', type: 'FILE', data: null }] }],
    ['null edge data', { ...PAYLOAD, edges: [{ source: 'd', target: 'f', data: null }] }],
    ['array edge data', { ...PAYLOAD, edges: [{ source: 'd', target: 'f', data: [] }] }],
  ])('%s: not a GraphPayload, exit 2 (a5)', async (_name, body) => {
    const file = await payloadFile(envelope(body));
    const l = live(['inspect', file]);
    expect(await l.done).toBe(EXIT.USAGE);
    expect(l.io.stderr.join('\n')).toContain('not a GraphPayload');
    expect(l.inspector.starts()).toBe(0);
  });

  it('the engine is built with the inspect switch on (a8)', async () => {
    const root = await workspace();
    const configs: EngineConfig[] = [];
    const l = live(['index', root, '--inspect'], { configs });
    await until(() => l.inspector.sent.length >= 2, 'the verification');
    expect(configs).toEqual([
      { version: '9.8.7', consumers: { inspect: true, store: 'memory', vscode: false } },
    ]);
    l.abort();
    await l.done;
  });

  it('the inspect verb in the flag table: one payload positional, stdin, nothing on stdout, no session (b3)', () => {
    const spec = COMMANDS.find((c) => c.verb === 'inspect');
    expect(spec).toMatchObject({
      positionals: [{ name: 'payload' }],
      flags: [],
      stdin: 'optional-document',
      stdout: 'none',
      session: 'none',
    });
  });

  it('an inspector that cannot start during index --inspect: exit 1, the read session closed (b4)', async () => {
    const s = scriptedEngine();
    const inspector = fakeInspector({ failStart: new Error('spawn boom') });
    const l = live(['index', '/w', '--inspect'], { engine: s.engine, inspector });
    expect(await l.done).toBe(EXIT.FAILED);
    expect(l.io.stderr.join('\n')).toMatch(/^cpg: cannot start the inspector: .*spawn boom/m);
    expect(s.log.at(-1)).toBe('close');
  });

  it('Ctrl-C while the inspector is starting: once it starts it is stopped, exit 130 (b4)', async () => {
    let release: (() => void) | undefined;
    let stops = 0;
    const start: StartInspector = () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            url: URL,
            send: () => {},
            exited: new Promise<InspectorExit>(() => {}),
            stop: () => {
              stops += 1;
              return Promise.resolve();
            },
          });
      });
    const l = live(['inspect', await payloadFile(envelope(PAYLOAD))], { start });
    await until(() => release !== undefined, 'the start');
    l.abort();
    release?.();
    expect(await l.done).toBe(EXIT.INTERRUPTED);
    expect(stops).toBeGreaterThanOrEqual(1);
  });
});

// Post-implementation (sabotage group B, live.ts #15 survived): a render-report that arrives while
// the CLI is stopping the inspector is ignored. It prints no render-reconciliation line and sends
// no verification after Ctrl-C.
describe('cpg inspect: post-implementation (sabotage group B)', () => {
  it('a render-report during shutdown is ignored: no line, no verification after Ctrl-C', async () => {
    const sent: InspectorLine[] = [];
    let handlers: InspectorHandlers | undefined;
    const start: StartInspector = (h) => {
      handlers = h;
      return Promise.resolve({
        url: URL,
        send: (line: InspectorLine) => void sent.push(line),
        exited: new Promise<InspectorExit>(() => {}),
        stop: () => {
          handlers?.onRenderReport({
            type: 'render-report',
            epoch: 1,
            seq: PAYLOAD.seq,
            report: renderReport({ renderedNodeCount: 0, droppedNodeIds: ['f'] }),
          });
          return Promise.resolve();
        },
      });
    };
    const l = live(['inspect', await payloadFile(envelope(PAYLOAD))], { start });
    await until(() => sent.length === 2, 'the graph and its verdict');
    l.abort();
    expect(await l.done).toBe(EXIT.INTERRUPTED);
    expect(sent.map((line) => line.type)).toEqual(['graph', 'verification']);
    expect(l.io.stderr.filter((line) => line.includes('render-reconciliation'))).toEqual([]);
  });
});
