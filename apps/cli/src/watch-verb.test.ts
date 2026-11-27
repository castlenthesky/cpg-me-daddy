// `cpg watch` through run() (U4.2.1 part b, BMO-60), with a scripted engine, a fake inspector, and
// the real engine over a scripted backend. Sources:
// - BMO-60 line 1: the WatchEvent stream, seq dense from 0, closed last, shutdown by the signal.
// - Controller decision 64: index's flags minus --dry-run/--rebuild; the same load(); trailingMs and
//   ceilingMs from the resolved watch.*; unbuilt consumers refused with provenance (exit 2).
// - Decision 65: each event one stdout line, JSON.stringify(event), as it arrives; the stderr lines
//   for ready, warning and batch (the batch line silenced by --quiet); no clock read (I-30).
// - Decision 66: closed signal 130; closed error exits 1 with the error event's CliError; a failed
//   connect is engine-unavailable; run returns after engine.watch resolves and the session closes.
// - Decision 67: --inspect starts the inspector once after ready; each refresh is a full graph at
//   the triggering WatchEvent seq, latest-wins, on the watch's own session; a refresh that throws is
//   a warning; an inspector exiting on its own aborts the watch and exits 1.
// - The sprint 23 design notes: the line formats, the ms rounding, `none`, the eof and missing-closed
//   ends, render-reconciliation against the payload last sent (S23-1), the inspector-end precedence.
// - renderReconciliation's semantics (stale for an older seq; C-EXT I-19).
// Expected values come from those sources, never from running the code.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CheckResult,
  CpgEngine,
  EngineConfig,
  EngineDeps,
  EngineSession,
  IndexReport,
  StoreTarget,
  VerifyCheckId,
  WatchEvent,
  WatchFailure,
  WatchRequest,
} from '@cpg/engine';
import { createEngine } from '@cpg/engine';
import { isWorkspacePath, makeNodeId, type GraphPayload, type RenderReport } from '@cpg/model';
import type { RawWatchEvent, WatchBackend, WatchCapabilities } from '@cpg/watch';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  InspectorExit,
  InspectorHandlers,
  InspectorLine,
  StartInspector,
} from './inspector-process';
import { captureIo, type CapturedIo } from './io';
import { EXIT, run } from './run';

const manifest = { bin: 'cpg', version: '9.8.7' };
const URL = 'http://127.0.0.1:4200/';
const noop = (): void => {};
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
const byText = (a: string, b: string): number => (a < b ? -1 : 1);

const roots: string[] = [];
/** A workspace with `.git/` (it bounds the config search) and a.ts; `config` is its cpg.config.yaml. */
async function workspace(config?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cpg-cli-watch-'));
  roots.push(root);
  await mkdir(join(root, '.git'));
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
  if (config !== undefined) await writeFile(join(root, 'cpg.config.yaml'), config);
  return root;
}

// ── events ──

const REPORT: IndexReport = {
  root: '/w',
  walk: {
    filesSeen: 9,
    filesIndexed: 7,
    filesExcluded: 1,
    filesUnsupported: 1,
    filesTooLarge: 0,
    filesFailed: 0,
  },
  files: [],
  nodesWritten: 8,
  edgesWritten: 7,
  durationMs: 12.6,
  dryRun: false,
  interrupted: false,
  warnings: ['first warning', 'second warning'],
  target: null,
  consumers: ['memory', 'panel'],
};
const READY_LINES = [
  'cpg: warning: first warning',
  'cpg: warning: second warning',
  'cpg: watching /w: indexed 7 files in 13 ms; consumers: memory, panel',
];

const ready = (report = REPORT): WatchEvent => ({
  kind: 'ready',
  seq: 0,
  at: 1000,
  root: '/w',
  report,
});
const batch = (seq: number, total: number, paths = ['src/a.ts']): WatchEvent => ({
  kind: 'batch',
  seq,
  at: 2000 + seq,
  changes: paths
    .filter(isWorkspacePath)
    .map((path) => ({ kind: 'changed', entry: 'file', path, observedAt: 1 })),
  write: { nodesWritten: 2, edgesWritten: 1, statementCount: 1 },
  latencyMs: { t0_t1: null, t1_t2: 3, t2_t3: total - 3, total },
});
const warning = (seq: number, message: string): WatchEvent => ({
  kind: 'warning',
  seq,
  at: 3000 + seq,
  message,
});
const failed = (seq: number, error: WatchFailure): WatchEvent => ({
  kind: 'error',
  seq,
  at: 4000 + seq,
  error,
});
const closed = (seq: number, reason: 'signal' | 'error' | 'eof'): WatchEvent => ({
  kind: 'closed',
  seq,
  at: 5000 + seq,
  reason,
});

// ── the scripted engine ──

const CHECK_IDS: readonly VerifyCheckId[] = [
  'filesystem-reconciliation',
  'identity-invariants',
  'id-uniqueness',
  'render-reconciliation',
  'revision-reconciliation',
  'resolution-health',
];
const VERIFIED: readonly CheckResult[] = CHECK_IDS.map((id, i) => ({
  id,
  state: id === 'render-reconciliation' ? 'unavailable' : 'pass',
  observed: i,
  expected: i,
  localisedTo: [],
  asOfSeq: -1,
}));

/** The store's payload: merge-filesystem allocates no seq, so it is at -1. */
const payloadOf = (...ids: string[]): GraphPayload => ({
  seq: -1,
  nodes: ids.map((id) => ({ id, type: 'FILE', name: id })),
  edges: [],
});
const P2 = payloadOf('n1', 'n2');
const P3 = payloadOf('n1', 'n2', 'n3');

interface Read {
  readonly what: 'verify' | 'inspect';
  readonly session: EngineSession;
  readonly config: unknown;
  readonly expected?: unknown;
}

interface ScriptOptions {
  /** inspect's i-th call returns payloads[i]; the last one repeats. Default: P2. */
  readonly payloads?: readonly GraphPayload[];
  /** The first inspect call waits for it. */
  readonly gate?: Promise<void>;
  /** inspect calls (0-based) that reject with `inspect-boom-<i>`. */
  readonly failInspect?: readonly number[];
  /** Default true: an abort emits `closed { signal }` (unless closed was emitted) and resolves. */
  readonly closeOnAbort?: boolean;
  readonly failConnect?: boolean;
  readonly rejectWatch?: Error;
}

function scripted(o: ScriptOptions = {}) {
  const log: string[] = [];
  const requests: WatchRequest[] = [];
  const targets: StoreTarget[] = [];
  const sessions: EngineSession[] = [];
  const reads: Read[] = [];
  let onEvent: ((event: WatchEvent) => void) | undefined;
  let signal: AbortSignal | undefined;
  let finish: (() => void) | undefined;
  let lastSeq = -1;
  let closedSent = false;
  let inspects = 0;

  const emit = (event: WatchEvent): void => {
    lastSeq = event.seq;
    if (event.kind === 'closed') closedSent = true;
    onEvent?.(event);
  };

  const engine: CpgEngine = {
    identity: { name: 'scripted', version: '0', languages: [] },
    connect: (target, opts) => {
      log.push(opts.readOnly ? 'connect:read' : 'connect:write');
      targets.push(target);
      if (o.failConnect === true) return Promise.reject(new Error('refused'));
      const session: EngineSession = {
        target,
        close: () => {
          log.push('close');
          return Promise.resolve();
        },
      };
      sessions.push(session);
      return Promise.resolve(session);
    },
    index: () => Promise.reject(new Error('scripted.index is not driven by these tests')),
    watch: (req, cb, sig) => {
      log.push('watch');
      requests.push(req);
      if (o.rejectWatch !== undefined) return Promise.reject(o.rejectWatch);
      onEvent = cb;
      signal = sig;
      return new Promise<void>((done) => {
        finish = () => {
          finish = undefined;
          log.push('watch resolved');
          done();
        };
        if (o.closeOnAbort === false) return;
        const onAbort = (): void => {
          if (!closedSent) emit(closed(lastSeq + 1, 'signal'));
          finish?.();
        };
        if (sig.aborted) onAbort();
        else sig.addEventListener('abort', onAbort, { once: true });
      });
    },
    verify: (session, config, expected) => {
      reads.push({ what: 'verify', session, config, expected });
      return Promise.resolve({
        state: 'pass',
        checks: VERIFIED,
        consumers: ['memory'],
        durationMs: 1,
      });
    },
    inspect: async (session, config) => {
      const i = inspects;
      inspects += 1;
      reads.push({ what: 'inspect', session, config });
      if (i === 0 && o.gate !== undefined) await o.gate;
      if (o.failInspect?.includes(i) === true) throw new Error(`inspect-boom-${String(i)}`);
      const payloads = o.payloads ?? [P2];
      return payloads[Math.min(i, payloads.length - 1)] ?? P2;
    },
    schema: () => {
      throw new Error('scripted.schema is not driven by these tests');
    },
  };
  return {
    engine,
    log,
    requests,
    targets,
    sessions,
    reads,
    emit,
    end: () => finish?.(),
    signal: () => signal,
    inspects: () => inspects,
  };
}
type Scripted = ReturnType<typeof scripted>;

// ── the fake inspector ──

function fakeInspector(o: { failStart?: Error; startGate?: Promise<void> } = {}) {
  const sent: InspectorLine[] = [];
  const handlers: InspectorHandlers[] = [];
  let stops = 0;
  let settle: ((exit: InspectorExit) => void) | undefined;
  const exited = new Promise<InspectorExit>((r) => {
    settle = r;
  });
  const start: StartInspector = async (h) => {
    handlers.push(h);
    if (o.startGate !== undefined) await o.startGate;
    if (o.failStart !== undefined) throw o.failStart;
    return {
      url: URL,
      send: (line: InspectorLine) => void sent.push(line),
      exited,
      stop: async () => {
        stops += 1;
        settle?.({ code: 0, signal: null });
        await exited;
      },
    };
  };
  const report = (seq: number, r: Partial<RenderReport> = {}): void =>
    handlers[0]?.onRenderReport({
      type: 'render-report',
      epoch: 1,
      seq,
      report: {
        payloadNodeCount: 2,
        renderedNodeCount: 2,
        renderedEdgeCount: 0,
        duplicateEdges: 0,
        droppedNodeIds: [],
        frameMs: 3,
        ...r,
      },
    });
  return {
    start,
    sent,
    report,
    starts: () => handlers.length,
    stops: () => stops,
    exit: (exit: InspectorExit) => settle?.(exit),
    graphs: () => sent.flatMap((l) => (l.type === 'graph' ? [l.payload] : [])),
    verifications: () => sent.flatMap((l) => (l.type === 'verification' ? [l.report] : [])),
  };
}
type Fake = ReturnType<typeof fakeInspector>;

// ── the harness ──

interface Live {
  readonly io: CapturedIo;
  readonly inspector: Fake;
  readonly done: Promise<number>;
  abort(): void;
  code(): number | undefined;
  ended(): boolean;
}
const lives: Live[] = [];
afterEach(async () => {
  for (const l of lives.splice(0)) {
    l.abort();
    l.inspector.exit({ code: 0, signal: null });
    // oxlint-disable-next-line no-await-in-loop
    await l.done.catch(noop);
  }
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

interface LiveOptions {
  readonly engine?: CpgEngine;
  readonly deps?: EngineDeps;
  readonly inspector?: Fake;
  readonly noInspector?: boolean;
  readonly configs?: EngineConfig[];
  readonly io?: CapturedIo;
}

function live(argv: string[], o: LiveOptions = {}): Live {
  const io = o.io ?? captureIo();
  const inspector = o.inspector ?? fakeInspector();
  const controller = new AbortController();
  let code: number | undefined;
  let ended = false;
  const done = run(argv, io, {
    manifest,
    createEngine: (config: EngineConfig) => {
      o.configs?.push(config);
      return o.engine ?? createEngine(config, o.deps);
    },
    ...(o.noInspector === true ? {} : { startInspector: inspector.start }),
    cwd: tmpdir(),
    signal: controller.signal,
  }).finally(() => {
    ended = true;
  });
  void done.then((c) => {
    code = c;
  }, noop);
  const l: Live = {
    io,
    inspector,
    done,
    abort: () => controller.abort(),
    code: () => code,
    ended: () => ended,
  };
  lives.push(l);
  return l;
}

async function until(l: Live, check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    if (l.ended()) throw new Error(`run ended before ${what}`);
    // oxlint-disable-next-line no-await-in-loop
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Starts `cpg watch` on the scripted engine and waits until engine.watch has been called. */
async function watching(argv: string[], s: Scripted, inspector?: Fake): Promise<Live> {
  const l = live(argv, { engine: s.engine, ...(inspector !== undefined && { inspector }) });
  await until(l, () => s.requests.length === 1, 'engine.watch');
  return l;
}

const parsed = (l: Live): unknown[] => l.io.stdout.map((line) => JSON.parse(line) as unknown);
const field = (e: unknown, key: string): unknown =>
  typeof e === 'object' && e !== null ? (Reflect.get(e, key) as unknown) : undefined;
const lastErr = (l: Live): string | undefined => l.io.stderr.at(-1);

// ── decision 64: flags and config ──

describe('cpg watch: flags and config (decision 64)', () => {
  it("--help: index's flags minus --dry-run and --rebuild; --format takes ndjson only", async () => {
    const l = live(['watch', '--help'], { engine: scripted().engine });
    expect(await l.done).toBe(EXIT.OK);
    const usage = l.io.stdout.join('\n');
    expect(usage).toContain('usage: cpg watch [root] [flags]');
    expect(new Set(usage.match(/--[a-z-]+/g))).toEqual(
      new Set(
        ['--workspace', '--config', '--format', '--host', '--port', '--graph'].concat([
          '--inspect',
          '--store',
          '--quiet',
          '--help',
        ]),
      ),
    );
    expect(usage).toContain('--format <ndjson>');
  });

  it.each([
    [['--dry-run'], "Unknown option '--dry-run'"],
    [['--rebuild'], "Unknown option '--rebuild'"],
    [['--format', 'json'], "--format must be one of ndjson, got 'json'"],
  ])('%j is a usage error before any engine', async (flags, message) => {
    const configs: EngineConfig[] = [];
    const s = scripted();
    const l = live(['watch', '/w', ...flags], { engine: s.engine, configs });
    expect(await l.done).toBe(EXIT.USAGE);
    expect(l.io.stderr.join('\n')).toContain(message);
    expect([l.io.stdout, configs, s.log]).toEqual([[], [], []]);
  });

  it.each([
    [
      'a file sets them',
      'version: 1\ninclude: [src/**]\nwatch: { debounce_ms: 40, ceiling_ms: 300 }\n',
      ['src/**'],
      40,
      300,
    ],
    ['the built-in 100 / 500', undefined, undefined, 100, 500],
  ])(
    'the root, include and window come from the same config as index: %s',
    async (_w, file, include, trailing, ceiling) => {
      const root = await workspace(file);
      const s = scripted();
      const l = await watching(['watch', root], s);
      const req = s.requests[0];
      expect([
        req?.config.root,
        req?.config.include,
        req?.config.trailingMs,
        req?.config.ceilingMs,
      ]).toEqual([root, include, trailing, ceiling]);
      expect(req?.session).toBe(s.sessions[0]);
      l.abort();
      expect(await l.done).toBe(EXIT.INTERRUPTED);
    },
  );

  it('the store flags reach the one write session; the engine gets the resolved switches', async () => {
    const configs: EngineConfig[] = [];
    const s = scripted();
    const l = live(['watch', '/w', '--host', 'h', '--port', '7001', '--graph', 'g'], {
      engine: s.engine,
      configs,
    });
    await until(l, () => s.requests.length === 1, 'engine.watch');
    expect(s.targets).toEqual([{ host: 'h', port: 7001, graph: 'g' }]);
    expect(configs).toEqual([
      { version: '9.8.7', consumers: { inspect: false, store: 'memory', vscode: false } },
    ]);
    l.abort();
    await l.done;
    expect(s.log).toEqual(['connect:write', 'watch', 'watch resolved', 'close']);
  });

  it.each([
    [
      '--store falkor',
      ['--store', 'falkor'],
      undefined,
      'consumers.store "falkor" from flag --store (FalkorStore, U5)',
    ],
    [
      'a file with vscode: true',
      [],
      'version: 1\nconsumers: { vscode: true }\n',
      'consumers.vscode true from file <file> (the VS Code extension turns this on itself; nothing in the CLI does)',
    ],
  ])(
    '%s: refused before any engine, with its source (exit 2)',
    async (_w, flags, file, refusal) => {
      const root = await workspace(file);
      const configs: EngineConfig[] = [];
      const l = live(['watch', root, ...flags], { engine: scripted().engine, configs });
      expect(await l.done).toBe(EXIT.USAGE);
      const named = refusal.replace('<file>', join(root, 'cpg.config.yaml'));
      expect([l.io.stderr, configs]).toEqual([[`cpg: not built yet: ${named}`], []]);
    },
  );

  it('--inspect with no inspector wired: exit 2 not built yet, before any engine', async () => {
    const configs: EngineConfig[] = [];
    const l = live(['watch', '/w', '--inspect'], {
      engine: scripted().engine,
      configs,
      noInspector: true,
    });
    expect(await l.done).toBe(EXIT.USAGE);
    expect(lastErr(l)).toMatch(/^cpg: .*watch --inspect.*not built yet/);
    expect(configs).toEqual([]);
  });
});

// ── decision 65: the stream ──

describe('cpg watch: the stream (decision 65)', () => {
  it('each event is one stdout line, JSON.stringify of the event, written as it arrives', async () => {
    const s = scripted();
    const l = await watching(['watch', '/w'], s);
    const events = [ready(), warning(1, 'w1'), batch(2, 9)];
    for (const [i, event] of events.entries()) {
      s.emit(event);
      // synchronously: nothing is buffered behind a promise
      expect(l.io.stdout).toEqual(events.slice(0, i + 1).map((e) => JSON.stringify(e)));
    }
    l.abort();
    expect(await l.done).toBe(EXIT.INTERRUPTED);
    expect(l.io.stdout).toEqual([...events, closed(3, 'signal')].map((e) => JSON.stringify(e)));
  });

  it.each<[string, string[], IndexReport, string[]]>([
    [
      'ready, a warning and a batch',
      [],
      REPORT,
      [
        ...READY_LINES,
        'cpg: warning: 2 path(s) not written',
        'cpg: batch 2: 2 change(s) in 7 ms; consumers: memory, panel',
        'cpg: warning: w3',
      ],
    ],
    [
      '--quiet drops the batch line only',
      ['--quiet'],
      REPORT,
      [...READY_LINES, 'cpg: warning: 2 path(s) not written', 'cpg: warning: w3'],
    ],
    [
      'an empty enabled set is none',
      [],
      { ...REPORT, warnings: [], consumers: [] },
      [
        'cpg: watching /w: indexed 7 files in 13 ms; consumers: none',
        'cpg: warning: 2 path(s) not written',
        'cpg: batch 2: 2 change(s) in 7 ms; consumers: none',
        'cpg: warning: w3',
      ],
    ],
  ])('stderr: %s', async (_w, flags, report, lines) => {
    const s = scripted();
    const l = await watching(['watch', '/w', ...flags], s);
    const before = l.io.stderr.length;
    s.emit(ready(report));
    s.emit(warning(1, '2 path(s) not written'));
    s.emit(batch(2, 7.4, ['src/a.ts', 'src/b.ts']));
    s.emit(warning(3, 'w3'));
    expect(l.io.stderr.slice(before)).toEqual(lines);
    expect(l.io.stdout).toHaveLength(4);
  });

  it('the CLI reads no clock (I-30)', async () => {
    let reads = 0;
    const io: CapturedIo = { ...captureIo(), now: () => ++reads };
    const s = scripted();
    const l = live(['watch', '/w'], { engine: s.engine, io });
    await until(l, () => s.requests.length === 1, 'engine.watch');
    s.emit(ready());
    s.emit(batch(1, 4));
    l.abort();
    expect(await l.done).toBe(EXIT.INTERRUPTED);
    expect(reads).toBe(0);
  });
});

// ── decision 66: the end ──

describe('cpg watch: the end (decision 66)', () => {
  it('the signal reaches the engine; run returns after watch resolves, then closes the session', async () => {
    const s = scripted({ closeOnAbort: false });
    const l = await watching(['watch', '/w'], s);
    s.emit(ready());
    expect(s.signal()?.aborted).toBe(false);
    l.abort();
    expect(s.signal()?.aborted).toBe(true);
    s.emit(closed(1, 'signal'));
    await tick();
    await tick();
    expect([l.code(), s.log]).toEqual([undefined, ['connect:write', 'watch']]);
    s.end();
    expect(await l.done).toBe(EXIT.INTERRUPTED);
    expect(lastErr(l)).toBe('cpg: interrupted');
    expect(s.log).toEqual(['connect:write', 'watch', 'watch resolved', 'close']);
  });

  it.each<[string, WatchFailure, WatchEvent[]]>([
    ['workspace', { kind: 'workspace', path: '/w', message: 'root-missing: /w is gone' }, []],
    ['engine-rejected', { kind: 'engine-rejected', message: 'the index failed: EACCES' }, []],
    [
      'after ready and a batch',
      { kind: 'workspace', path: '/w/x', message: 'overflow: lost' },
      [ready(), batch(1, 4)],
    ],
  ])(
    'closed { error } after an error event (%s): exit 1 with its message',
    async (_k, error, before) => {
      const s = scripted({ closeOnAbort: false });
      const l = await watching(['watch', '/w'], s);
      for (const event of before) s.emit(event);
      s.emit(failed(before.length, error));
      s.emit(closed(before.length + 1, 'error'));
      s.end();
      expect(await l.done).toBe(EXIT.FAILED);
      expect(lastErr(l)).toBe(`cpg: ${error.message}`);
      expect(parsed(l).slice(-2)).toEqual([
        failed(before.length, error),
        closed(before.length + 1, 'error'),
      ]);
      expect(s.log.at(-1)).toBe('close');
    },
  );

  it.each([
    ['closed { error } with no error event', [closed(0, 'error')]],
    ['a watch that resolves with no closed', [ready()]],
  ])('%s exits 1', async (_what, events) => {
    const s = scripted({ closeOnAbort: false });
    const l = await watching(['watch', '/w'], s);
    for (const event of events) s.emit(event);
    s.end();
    expect(await l.done).toBe(EXIT.FAILED);
    expect(lastErr(l)).toMatch(/^cpg: \S/);
    expect(s.log.at(-1)).toBe('close');
  });

  it('closed { eof } exits 0', async () => {
    const s = scripted({ closeOnAbort: false });
    const l = await watching(['watch', '/w'], s);
    s.emit(ready());
    s.emit(closed(1, 'eof'));
    s.end();
    expect(await l.done).toBe(EXIT.OK);
  });

  it('a failed connect: exit 1 naming the endpoint, nothing on stdout, no watch', async () => {
    const s = scripted({ failConnect: true });
    const l = live(['watch', '/w'], { engine: s.engine });
    expect(await l.done).toBe(EXIT.FAILED);
    expect(lastErr(l)).toMatch(/^cpg: cannot reach the graph store at 127\.0\.0\.1:6382\/cpg/);
    expect([l.io.stdout, s.log]).toEqual([[], ['connect:write']]);
  });

  it('a watch that rejects (it never should): the session still closes', async () => {
    const s = scripted({ rejectWatch: new Error('watch-boom') });
    const l = live(['watch', '/w'], { engine: s.engine });
    await expect(l.done).rejects.toThrow('watch-boom');
    expect(s.log).toEqual(['connect:write', 'watch', 'close']);
  });
});

// ── decision 67: --inspect ──

const waitingFor = (seq: number): CheckResult => ({
  id: 'render-reconciliation',
  state: 'unavailable',
  observed: 0,
  expected: 0,
  localisedTo: [],
  detail: `no render-report yet: open ${URL}`,
  asOfSeq: seq,
});
const renderOf = (f: Fake, i: number): CheckResult | undefined =>
  f.verifications()[i]?.checks.find((c) => c.id === 'render-reconciliation');
const render = (
  state: CheckResult['state'],
  observed: number,
  expected: number,
  o: Partial<CheckResult> = {},
) => ({
  id: 'render-reconciliation',
  state,
  observed,
  expected,
  localisedTo: [],
  ...o,
});

/** `cpg watch /w --inspect` after ready, with its first graph sent. */
async function inspecting(s: Scripted, f = fakeInspector()): Promise<{ l: Live; f: Fake }> {
  const l = await watching(['watch', '/w', '--inspect'], s, f);
  s.emit(ready());
  await until(l, () => f.verifications().length >= 1, 'the first graph and verdict');
  return { l, f };
}

describe('cpg watch --inspect (decision 67)', () => {
  it("starts once, after ready: the store payload at seq 0, its verdict, all on the watch's session", async () => {
    const s = scripted();
    const f = fakeInspector();
    const l = await watching(['watch', '/w', '--inspect'], s, f);
    await tick();
    expect(f.starts()).toBe(0);
    s.emit(ready());
    await until(l, () => f.sent.length >= 2, 'the first graph and verdict');
    expect(f.sent[0]).toEqual({ type: 'graph', payload: { ...P2, seq: 0 } });
    expect(f.verifications()[0]?.checks).toEqual(
      VERIFIED.map((c) => (c.id === 'render-reconciliation' ? waitingFor(0) : c)),
    );
    expect(l.io.stderr).toContain(
      `cpg: inspector at ${URL} (open it in a browser; Ctrl-C stops it)`,
    );
    s.emit(batch(1, 4));
    await until(l, () => f.graphs().length >= 2, 'the second graph');
    l.abort();
    expect(await l.done).toBe(EXIT.INTERRUPTED);
    expect([f.starts(), f.stops(), s.targets.length]).toEqual([1, 1, 1]);
    expect(
      s.reads
        .map((r) => r.what)
        .toSorted(byText)
        .join(),
    ).toBe('inspect,inspect,verify,verify');
    expect(
      s.reads.filter((r) => r.session !== s.sessions[0] || field(r.config, 'root') !== '/w'),
    ).toEqual([]);
    expect(s.reads.filter((r) => r.what === 'verify').map((r) => r.expected)).toEqual([null, null]);
  });

  it('the graph seq is the triggering event seq, not a count: ready 0, batches 2 and 4', async () => {
    const s = scripted();
    const { l, f } = await inspecting(s);
    s.emit(warning(1, 'w1'));
    s.emit(batch(2, 4));
    await until(l, () => f.graphs().length >= 2, 'graph 2');
    s.emit(warning(3, 'w3'));
    s.emit(batch(4, 4));
    await until(l, () => f.graphs().length >= 3, 'graph 4');
    expect([f.graphs().map((p) => p.seq), s.inspects()]).toEqual([[0, 2, 4], 3]);
  });

  it('render-reconciliation is judged against the payload last sent (S23-1)', async () => {
    const s = scripted({ payloads: [P2, P3] });
    const { l, f } = await inspecting(s);
    expect(renderOf(f, 0)).toEqual(waitingFor(0));
    f.report(0);
    await until(l, () => f.verifications().length >= 2, 'the pass at seq 0');
    expect(renderOf(f, 1)).toEqual(render('pass', 2, 2, { asOfSeq: 0 }));
    expect(l.io.stderr).toContain('cpg: render-reconciliation pass');

    s.emit(batch(1, 4));
    await until(l, () => f.verifications().length >= 3, 'graph 1 and its verdict');
    expect(f.graphs()[1]).toEqual({ ...P3, seq: 1 });
    const detail = "render-report at seq 0 lags the payload's seq 1";
    expect(renderOf(f, 2)).toEqual(render('stale', 2, 3, { detail, asOfSeq: 1 }));
    // the page still reporting the old graph changes nothing
    f.report(0);
    await tick();
    expect(f.verifications()).toHaveLength(3);

    f.report(1, { payloadNodeCount: 3, droppedNodeIds: ['n3'] });
    await until(l, () => f.verifications().length >= 4, 'the fail at seq 1');
    const fail = { localisedTo: ['n3'], detail: '2 of 3 payload nodes drawn', asOfSeq: 1 };
    expect(renderOf(f, 3)).toEqual(render('fail', 2, 3, fail));
    f.report(1, { payloadNodeCount: 3, renderedNodeCount: 3 });
    await until(l, () => f.verifications().length >= 5, 'the pass at seq 1');
    expect(renderOf(f, 4)).toEqual(render('pass', 3, 3, { asOfSeq: 1 }));
  });

  it('latest-wins: one refresh in flight, one queued at the newest seq; stdout never waits', async () => {
    let open = noop;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const s = scripted({ gate });
    const f = fakeInspector();
    const l = await watching(['watch', '/w', '--inspect'], s, f);
    s.emit(ready());
    await until(l, () => s.inspects() === 1, 'the first refresh to read');
    for (const seq of [1, 2, 3]) s.emit(batch(seq, 4));
    expect(l.io.stdout).toHaveLength(4);
    await tick();
    await tick();
    expect([s.inspects(), f.graphs()]).toEqual([1, []]);
    open();
    await until(l, () => f.graphs().length >= 2, 'the queued refresh');
    await tick();
    await tick();
    expect([f.graphs().map((p) => p.seq), s.inspects()]).toEqual([[0, 3], 2]);
  });

  it('a refresh that throws is a warning, and the watch goes on', async () => {
    const s = scripted({ failInspect: [1] });
    const { l, f } = await inspecting(s);
    s.emit(batch(1, 4));
    const line = 'cpg: warning: inspector refresh at seq 1 failed: inspect-boom-1';
    await until(l, () => l.io.stderr.includes(line), 'the refresh warning');
    s.emit(batch(2, 4));
    await until(l, () => f.graphs().length >= 2, 'graph 2');
    expect(f.graphs().map((p) => p.seq)).toEqual([0, 2]);
    l.abort();
    expect(await l.done).toBe(EXIT.INTERRUPTED);
  });

  // SIGINT is the same Ctrl-C (the process group): 130. Any other exit is the inspector's failure.
  it.each<[InspectorExit, number, string]>([
    [{ code: 3, signal: null }, EXIT.FAILED, 'cpg: the inspector exited unexpectedly (code 3)'],
    [
      { code: null, signal: 'SIGTERM' },
      EXIT.FAILED,
      'cpg: the inspector exited unexpectedly (signal SIGTERM)',
    ],
    [{ code: null, signal: 'SIGINT' }, EXIT.INTERRUPTED, 'cpg: interrupted'],
  ])(
    'the inspector exiting by itself (%j) aborts the watch; after closed: %i',
    async (exit, code, line) => {
      const s = scripted();
      const { l, f } = await inspecting(s);
      f.exit(exit);
      expect(await l.done).toBe(code);
      expect(s.signal()?.aborted).toBe(true);
      expect([lastErr(l), parsed(l).at(-1), s.log.at(-1)]).toEqual([
        line,
        closed(1, 'signal'),
        'close',
      ]);
    },
  );

  it('an inspector that cannot start aborts the watch, then exits 1 naming why', async () => {
    const s = scripted();
    const f = fakeInspector({ failStart: new Error('no free port') });
    const l = await watching(['watch', '/w', '--inspect'], s, f);
    s.emit(ready());
    expect(await l.done).toBe(EXIT.FAILED);
    expect(s.signal()?.aborted).toBe(true);
    expect(lastErr(l)).toBe('cpg: cannot start the inspector: no free port');
  });

  it('Ctrl-C first: an inspector exit after it keeps 130', async () => {
    const s = scripted({ closeOnAbort: false });
    const { l, f } = await inspecting(s);
    l.abort();
    f.exit({ code: 1, signal: null });
    await tick();
    s.emit(closed(1, 'signal'));
    s.end();
    expect(await l.done).toBe(EXIT.INTERRUPTED);
  });

  it("the watch's own error wins over an inspector exit", async () => {
    const s = scripted({ closeOnAbort: false });
    const { l, f } = await inspecting(s);
    f.exit({ code: 3, signal: null });
    await until(l, () => s.signal()?.aborted === true, 'the abort');
    s.emit(failed(1, { kind: 'workspace', path: '/w', message: 'root-missing: gone' }));
    s.emit(closed(2, 'error'));
    s.end();
    expect(await l.done).toBe(EXIT.FAILED);
    expect(lastErr(l)).toBe('cpg: root-missing: gone');
  });

  it('the inspector is stopped once the watch has resolved, before run returns', async () => {
    const s = scripted({ closeOnAbort: false });
    const { l, f } = await inspecting(s);
    l.abort();
    s.emit(closed(1, 'signal'));
    await tick();
    expect(f.stops()).toBe(0);
    s.end();
    expect(await l.done).toBe(EXIT.INTERRUPTED);
    expect(f.stops()).toBe(1);
  });

  it('a start still pending when the watch ends: run waits for it, then stops it', async () => {
    let open = noop;
    const startGate = new Promise<void>((r) => {
      open = r;
    });
    const s = scripted();
    const f = fakeInspector({ startGate });
    const l = await watching(['watch', '/w', '--inspect'], s, f);
    s.emit(ready());
    await until(l, () => f.starts() === 1, 'the start');
    l.abort();
    await tick();
    await tick();
    expect(l.code()).toBeUndefined();
    open();
    expect(await l.done).toBe(EXIT.INTERRUPTED);
    expect(f.stops()).toBe(1);
  });

  it('without inspect nothing starts and nothing is read', async () => {
    const s = scripted();
    const f = fakeInspector();
    const l = await watching(['watch', '/w'], s, f);
    s.emit(ready());
    s.emit(batch(1, 4));
    await tick();
    l.abort();
    await l.done;
    expect([f.starts(), s.reads]).toEqual([0, []]);
  });
});

// ── the real engine over a scripted backend ──

const CAPS: WatchCapabilities = {
  id: 'scripted',
  directoryEvents: 'all',
  moveEvents: 'none',
  reportsErrors: true,
  reportsOverflow: true,
  honoursIgnore: 'none',
  pathCase: 'sensitive',
};

/** A backend the test fires; a created event for `path` after the file is on disk. */
function scriptedBackend() {
  let onEvents: ((events: readonly RawWatchEvent[]) => void) | undefined;
  const backend: WatchBackend = {
    capabilities: CAPS,
    subscribe: (_root, events) => {
      onEvents = events;
      return Promise.resolve({ capabilities: CAPS, close: () => Promise.resolve() });
    },
  };
  const create = async (root: string, path: string): Promise<void> => {
    await writeFile(join(root, path), `export const x = '${path}';\n`);
    onEvents?.([
      { kind: 'created', path: join(root, path), entry: 'file', observedAt: Date.now() },
    ]);
  };
  return { backend, create };
}

const FAST = 'version: 1\nwatch: { debounce_ms: 5, ceiling_ms: 20 }\n';
const idsOf = (p: GraphPayload | undefined): string[] =>
  (p?.nodes ?? []).map((n) => n.id).toSorted(byText);
const fileIds = (...paths: string[]): string[] =>
  paths
    .filter(isWorkspacePath)
    .map((path) => makeNodeId({ form: path === '.' ? 'directory' : 'file', path }))
    .toSorted(byText);

describe('cpg watch over the real engine (I-23, decision 67)', () => {
  it('every line parses; seq dense from 0; the batch holds the new file; closed last; 130', async () => {
    const root = await workspace(FAST);
    const b = scriptedBackend();
    const l = live(['watch', root], { deps: { watchBackend: b.backend } });
    await until(l, () => l.io.stdout.length >= 1, 'ready');
    await b.create(root, 'b.ts');
    await until(l, () => l.io.stdout.length >= 2, 'the batch');
    l.abort();
    expect(await l.done).toBe(EXIT.INTERRUPTED);
    const events = parsed(l);
    expect(events.map((e) => [field(e, 'kind'), field(e, 'seq')])).toEqual([
      ['ready', 0],
      ['batch', 1],
      ['closed', 2],
    ]);
    expect(events[0]).toMatchObject({ root });
    expect(events[1]).toMatchObject({
      changes: [{ kind: 'created', entry: 'file', path: 'b.ts' }],
    });
    expect(events[2]).toMatchObject({ reason: 'signal' });
    expect(l.io.stderr.some((e) => e.startsWith(`cpg: watching ${root}: indexed `))).toBe(true);
    expect(
      l.io.stderr.filter((e) =>
        /^cpg: batch 1: 1 change\(s\) in \d+ ms; consumers: memory$/.test(e),
      ),
    ).toHaveLength(1);
  });

  it('--inspect: each refresh is the memory store whole, at the triggering seq', async () => {
    const root = await workspace(FAST);
    const b = scriptedBackend();
    const f = fakeInspector();
    const l = live(['watch', root, '--inspect'], {
      deps: { watchBackend: b.backend },
      inspector: f,
    });
    await until(l, () => f.graphs().length >= 1, 'graph 0');
    expect([f.graphs()[0]?.seq, idsOf(f.graphs()[0])]).toEqual([
      0,
      fileIds('.', 'a.ts', 'cpg.config.yaml'),
    ]);
    await b.create(root, 'b.ts');
    await until(l, () => f.graphs().length >= 2, 'graph 1');
    expect([f.graphs()[1]?.seq, idsOf(f.graphs()[1])]).toEqual([
      1,
      fileIds('.', 'a.ts', 'b.ts', 'cpg.config.yaml'),
    ]);
    l.abort();
    expect(await l.done).toBe(EXIT.INTERRUPTED);
    expect(field(parsed(l).at(-1), 'kind')).toBe('closed');
  });
});
