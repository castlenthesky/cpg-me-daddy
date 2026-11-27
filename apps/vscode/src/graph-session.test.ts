// The extension's flows (controller decisions 28, 35 to 40 and 70 to 74) over real workspaces and a scripted
// engine (decision 75): its `watch` emits what each test says, event by event, and its `inspect` reads the
// disk with a fresh real engine, so a payload is what an engine holding just those files gives. The
// configuration, the host, verify and its scheduler are real; VS Code is fake: the panel, the clock and the
// messages. One group runs the real engine and @parcel/watcher. Expected values: those decisions, C-EXT
// I-12, I-13, I-19 and I-22, 08-verification §3.1, and the doc comments.

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createEngine,
  type CpgEngine,
  type EngineConfig,
  type EngineSession,
  type IndexConfig,
  type WatchEvent,
  type WatchRequest,
} from '@cpg/engine';
import type { HostToWebview, ThemeSnapshot, VerificationReport } from '@cpg/model';
import { afterEach, describe, expect, it } from 'vitest';
import type { SourceOpener, WebviewTransport } from './contract';
import type { PanelSurface } from './graph-panel';
import { GraphSession } from './graph-session';
import type { Logger } from './log';
import type { WorkspaceFileSystem } from './workspace-probe';

const directories: string[] = [];
async function directory(spec: Readonly<Record<string, string>> = {}): Promise<string> {
  const at = await mkdtemp(join(tmpdir(), 'graph-session-'));
  directories.push(at);
  // Ends the search for a configuration file; the default excludes keep it out of the graph.
  await mkdir(join(at, '.git'));
  await Promise.all(Object.entries(spec).map(([name, text]) => writeFile(join(at, name), text)));
  return at;
}
/** Every session a test made is disposed and its watches ended, so no watch outlives its test. */
const teardowns: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(teardowns.splice(0).map((teardown) => teardown()));
  await Promise.all(directories.splice(0).map((at) => rm(at, { recursive: true, force: true })));
});

const CONFIG = 'cpg.config.yaml';
const U6A = 'the code tier is not built yet (U6a): only the filesystem tier was indexed';
const THEME: ThemeSnapshot = { kind: 'dark', nodeColors: {}, defaultNodeColor: '#999999' };
const ALL_PASS = 'pass unavailable pass pass pass unavailable';
const NOT_DRAWN = 'pass unavailable pass unavailable pass unavailable';
const READY = { type: 'ready', protocol: 1 };
const STORE = { host: '127.0.0.1', port: 6382, graph: 'cpg' };
const allMicrotasks = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
async function until(done: () => boolean, ms = 5000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!done()) {
    if (performance.now() > deadline) throw new Error('it never happened');
    // oxlint-disable-next-line no-await-in-loop -- real I/O, one tick at a time
    await allMicrotasks();
  }
}

/** A promise the test opens, and one that says the code reached it. */
interface Gate {
  readonly opened: Promise<void>;
  readonly reached: Promise<void>;
  open(): void;
  reach(): void;
}
const nothing = (): void => undefined;
function gate(): Gate {
  const held = { open: nothing, reach: nothing };
  const opened = new Promise<void>((resolve) => {
    held.open = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    held.reach = resolve;
  });
  return { opened, reached, open: () => held.open(), reach: () => held.reach() };
}

/** What a fresh engine indexes of the disk now: its report, and the graph it then holds. */
async function onDisk(engineConfig: EngineConfig, config: IndexConfig) {
  const engine = createEngine(engineConfig);
  const session = await engine.connect(STORE, { readOnly: false });
  try {
    const { signal } = new AbortController();
    const report = await engine.index(
      { config, session, resumeFrom: null },
      () => undefined,
      signal,
    );
    return { report, payload: await engine.inspect(session, config) };
  } finally {
    await session.close();
  }
}

const NO_LATENCY = { t0_t1: null, t1_t2: 0, t2_t3: 0, total: 0 };

/** One engine.watch, driven by the test. Its events' seqs are dense from 0, as the engine's (C-CLI I-23). */
class ScriptedWatch {
  ended = false;
  readonly done: Promise<void>;
  private next = 0;
  private closed = false;
  private finish: () => void = () => undefined;

  constructor(
    readonly n: number,
    readonly request: WatchRequest,
    readonly signal: AbortSignal,
    private readonly onEvent: (event: WatchEvent) => void,
    private readonly engineConfig: EngineConfig,
    /** When set, an abort or a failure leaves the watch running until `end`. */
    private readonly holdEnd: boolean,
    private readonly log: string[],
  ) {
    this.done = new Promise<void>((resolve) => {
      this.finish = resolve;
    });
    signal.addEventListener('abort', () => {
      if (this.holdEnd || this.closed) return;
      this.close('signal');
      this.end();
    });
  }

  /** `ready` with the report of an index of the disk now; `warnings` replaces the report's. */
  async ready(warnings?: readonly string[]): Promise<void> {
    const { report } = await onDisk(this.engineConfig, this.request.config);
    const seq = this.seq();
    const { root } = this.request.config;
    const sent = warnings === undefined ? report : { ...report, warnings };
    this.onEvent({ kind: 'ready', seq, at: seq, root, report: sent });
  }

  batch(): void {
    const seq = this.seq();
    const write = { nodesWritten: 1, edgesWritten: 1, statementCount: 1 };
    const event = { kind: 'batch', seq, at: seq, cause: 'live', changes: [], write } as const;
    this.onEvent({ ...event, latencyMs: NO_LATENCY });
  }

  warning(message: string): void {
    const seq = this.seq();
    this.onEvent({ kind: 'warning', seq, at: seq, message });
  }

  /** `error` then `closed { reason: 'error' }`; the watch then resolves, unless it is held. */
  fail(message: string): void {
    const seq = this.seq();
    this.onEvent({ kind: 'error', seq, at: seq, error: { kind: 'engine-rejected', message } });
    this.close('error');
    if (!this.holdEnd) this.end();
  }

  close(reason: 'signal' | 'error'): void {
    this.closed = true;
    const seq = this.seq();
    this.onEvent({ kind: 'closed', seq, at: seq, reason });
  }

  /** watch() resolves. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.log.push(`resolved ${String(this.n)}`);
    this.finish();
  }

  private seq(): number {
    const seq = this.next;
    this.next += 1;
    return seq;
  }
}

interface Disk {
  readonly listed: string[];
  readonly read: string[];
  hold: Gate | undefined;
}
const diskFileSystem = (root: string, disk: Disk): WorkspaceFileSystem => ({
  readDirectory: async (path) => {
    disk.listed.push(path);
    const { hold } = disk;
    if (hold !== undefined) {
      hold.reach();
      await hold.opened;
    }
    return (await readdir(join(root, path), { withFileTypes: true })).map(
      (entry) => [entry.name, entry.isDirectory() ? 2 : 1] as const,
    );
  },
  size: async (path) => (await stat(join(root, path))).size,
  readFile: async (path) => {
    const bytes = await readFile(join(root, path));
    disk.read.push(path);
    return bytes;
  },
});

class FakeSurface implements PanelSurface {
  html = '';
  revealed = 0;
  disposed = 0;
  readonly posted: HostToWebview[] = [];
  private handler: (message: unknown) => void = () => undefined;
  private closed: () => void = () => undefined;
  readonly transport: WebviewTransport = {
    cspSource: 'https://csp.example',
    post: (message) => {
      this.posted.push(message);
      if (message.type === 'graph') this.log?.push(`graph ${stamp(message)}`);
    },
    onMessage: (handler) => {
      this.handler = handler;
      return { dispose: () => undefined };
    },
  };
  constructor(private readonly log?: string[]) {}
  asUri(path: string): string {
    return `webview:${path}`;
  }
  setHtml(html: string): void {
    this.html = html;
  }
  reveal(): void {
    this.revealed += 1;
  }
  onDidDispose(listener: () => void) {
    this.closed = listener;
    return { dispose: () => undefined };
  }
  dispose(): void {
    this.disposed += 1;
    this.closed();
  }
  send(message: unknown): void {
    this.handler(message);
  }
  /** The page draws the latest graph it was sent, whole. */
  draw(over: Readonly<Record<string, number>> = {}): void {
    const graph = this.graphs.at(-1);
    if (graph?.type !== 'graph') throw new Error('the page has no graph');
    const count = graph.payload.nodes.length;
    this.send({
      type: 'render-report',
      epoch: graph.epoch,
      seq: graph.seq,
      report: {
        payloadNodeCount: count,
        renderedNodeCount: count,
        renderedEdgeCount: 0,
        duplicateEdges: 0,
        droppedNodeIds: [],
        frameMs: 1,
        ...over,
      },
    });
  }
  get graphs(): HostToWebview[] {
    return this.posted.filter((message) => message.type === 'graph');
  }
  get verifications(): HostToWebview[] {
    return this.posted.filter((message) => message.type === 'verification');
  }
}

/** `<epoch>/<seq>` of a message. */
function stamp(message: HostToWebview): string {
  return message.type === 'theme' ? 'theme' : `${String(message.epoch)}/${String(message.seq)}`;
}

interface SetUp {
  readonly root?: string | undefined;
  /** Changes one engine, by the order it was made in (from 1). */
  readonly engine?: (n: number) => Partial<CpgEngine>;
  /** The real engine's watch, not the script's (with its connect still recorded). */
  readonly real?: boolean;
  readonly holdEnd?: boolean;
  /** Which inspect calls (from 1) reject with `disk on fire`. */
  readonly inspectFails?: (call: number) => boolean;
  readonly opener?: SourceOpener;
  readonly closeFails?: boolean;
  readonly onReport?: (report: VerificationReport) => void;
  readonly log?: Logger;
}

function setUp(over: SetUp = {}) {
  /** What happened, in order: connect, watch, graph, resolved, close, and the messages. */
  const log: string[] = [];
  const messages: string[] = [];
  const reports: VerificationReport[] = [];
  const panels: FakeSurface[] = [];
  const engines: EngineConfig[] = [];
  const connects: unknown[] = [];
  const sessions: EngineSession[] = [];
  const closes: number[] = [];
  const watched: ScriptedWatch[] = [];
  /** The engine of each inspect call when it starts, and when it has its answer. */
  const inspected: number[] = [];
  const answered: number[] = [];
  const inspectHolds: Gate[] = [];
  /** The directories verify listed (a run starts by listing '.') and the files it read. */
  const disk: Disk = { listed: [], read: [], hold: undefined };
  const timers: { ms: number; callback: () => void; cancelled: boolean }[] = [];
  const say = (text: string) => {
    messages.push(text);
    log.push(text);
  };

  const session = new GraphSession({
    root: over.root,
    version: '9.8.7',
    createEngine: (config) => {
      engines.push(config);
      const n = engines.length;
      const real = createEngine(config);
      const connect: CpgEngine['connect'] = async (target, opts) => {
        connects.push([target, opts]);
        const opened = await real.connect(target, opts);
        log.push(`connect ${String(n)}`);
        const made: EngineSession = {
          ...opened,
          close: async () => {
            closes.push(n);
            log.push(`close ${String(n)}`);
            await opened.close();
            if (over.closeFails === true) throw new Error('stuck');
          },
        };
        sessions.push(made);
        return made;
      };
      if (over.real === true) return { ...real, connect };
      const scripted: Partial<CpgEngine> = {
        connect,
        watch: (request, onEvent, signal) => {
          log.push(`watch ${String(n)}`);
          const hold = over.holdEnd === true;
          const watch = new ScriptedWatch(n, request, signal, onEvent, config, hold, log);
          watched.push(watch);
          return watch.done;
        },
        inspect: async (_session, scope) => {
          inspected.push(n);
          const call = inspected.length;
          const hold = inspectHolds.shift();
          if (hold !== undefined) {
            hold.reach();
            await hold.opened;
          }
          try {
            if (over.inspectFails?.(call) === true) throw new Error('disk on fire');
            return (await onDisk(config, scope)).payload;
          } finally {
            answered.push(n);
          }
        },
      };
      return { ...real, ...scripted, ...over.engine?.(n) };
    },
    fileSystem: diskFileSystem(over.root ?? tmpdir(), disk),
    opener: over.opener ?? { open: () => Promise.resolve() },
    theme: THEME,
    createPanel: () => {
      const panel = new FakeSurface(log);
      panels.push(panel);
      return panel;
    },
    pageDirectory: join(over.root ?? tmpdir(), 'page'),
    after: (ms, callback) => {
      const timer = { ms, callback, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    onReport: (report) => {
      reports.push(report);
      over.onReport?.(report);
    },
    showWarning: (text) => say(`warning: ${text}`),
    showError: (text) => say(`error: ${text}`),
    ...(over.log === undefined ? {} : { log: over.log }),
  });
  teardowns.push(async () => {
    session.dispose();
    for (const watch of watched) watch.end();
    await until(() => closes.length >= sessions.length);
  });

  /** The n-th panel made (from 0); a test that talks to one that is not there fails (review a4). */
  const page = (n = 0): FakeSurface => {
    const panel = panels[n];
    if (panel === undefined) throw new Error(`panel ${String(n)} was not made`);
    return panel;
  };
  /** The n-th watch started (from 1), once it is. */
  const watching = async (n: number): Promise<ScriptedWatch> => {
    await until(() => watched.length >= n);
    const watch = watched[n - 1];
    if (watch === undefined) throw new Error(`watch ${String(n)} was not started`);
    return watch;
  };
  /** cpg.openGraph, its watch's ready, then the first panel's page ready. */
  const opened = async (warnings?: readonly string[]): Promise<ScriptedWatch> => {
    const opening = session.openGraph();
    const watch = await watching(watched.length + 1);
    await watch.ready(warnings);
    await opening;
    page().send(READY);
    return watch;
  };
  /** Holds the next inspect call until the gate opens. */
  const holdInspect = (): Gate => {
    const held = gate();
    inspectHolds.push(held);
    return held;
  };
  /** Holds every listing of the workspace, so a verify run waits, until the gate opens. */
  const holdListing = (): Gate => {
    const held = gate();
    disk.hold = held;
    return held;
  };
  /** Fires the one pending timer and waits for its run's report. */
  const scheduledRun = async () => {
    const due = pending(timers);
    if (due.length !== 1) throw new Error(`${String(due.length)} timers are pending`);
    const before = reports.length;
    for (const timer of due) {
      timer.cancelled = true;
      timer.callback();
    }
    await until(() => reports.length > before);
    return due.map((timer) => timer.ms);
  };
  const verified = async () => {
    const before = reports.length;
    await session.verify();
    await until(() => reports.length > before);
    return states(reports.at(-1));
  };
  return {
    session,
    log,
    messages,
    reports,
    panels,
    engines,
    connects,
    sessions,
    closes,
    watched,
    inspected,
    answered,
    listed: disk.listed,
    read: disk.read,
    timers,
    page,
    watching,
    opened,
    holdInspect,
    holdListing,
    scheduledRun,
    verified,
  };
}

function states(report: VerificationReport | undefined): string {
  return (report?.checks ?? []).map((check) => check.state).join(' ');
}
const names = (message: HostToWebview | undefined): string[] =>
  message?.type === 'graph'
    ? message.payload.nodes.map((node) => node.name ?? '').toSorted()
    : ['no graph'];
/** `<epoch>/<seq>` of each graph a page was sent. */
const stamps = (page: FakeSurface): string[] => page.graphs.map(stamp);
function pending<T extends { readonly cancelled: boolean }>(timers: readonly T[]): T[] {
  return timers.filter((timer) => !timer.cancelled);
}

describe('cpg.openGraph starts one watch (decision 70)', () => {
  it.each([
    ["the file's window", 'version: 1\nwatch: { debounce_ms: 37, ceiling_ms: 412 }\n', 37, 412],
    ['the default window', undefined, 100, 500],
  ] as const)(
    'on a new engine and connection, with the configuration and %s',
    async (_what, file, trailingMs, ceilingMs) => {
      const spec = file === undefined ? { 'a.ts': 'a' } : { 'a.ts': 'a', [CONFIG]: file };
      const root = await directory(spec);
      const s = setUp({ root });
      void s.session.openGraph();
      const watch = await s.watching(1);
      expect(s.engines).toEqual([
        { version: '9.8.7', consumers: { inspect: false, store: 'memory', vscode: true } },
      ]);
      expect(s.connects).toEqual([[STORE, { readOnly: false }]]);
      expect(watch.request.session).toBe(s.sessions[0]);
      expect(watch.request.config).toMatchObject({
        root,
        trailingMs,
        ceilingMs,
        consumers: { vscode: true },
      });
      expect([watch.signal.aborted, s.closes]).toEqual([false, []]);
    },
  );

  it('resolves once ready is a graph: an initial snapshot at seq 0, a new epoch, then the warnings', async () => {
    const root = await directory({ 'a.ts': 'a', 'b.py': 'b' });
    const s = setUp({ root });
    let done = false;
    const opening = s.session.openGraph().then(() => {
      done = true;
    });
    const watch = await s.watching(1);
    s.page().send(READY);
    await allMicrotasks();
    expect([done, s.page().graphs]).toEqual([false, []]);
    await watch.ready();
    await opening;
    expect(s.page().posted.map(({ type, epoch }) => `${type}@${String(epoch)}`)).toEqual([
      'theme@0',
      'graph@1',
    ]);
    expect([stamps(s.page()), names(s.page().graphs[0])]).toEqual([['1/0'], ['.', 'a.ts', 'b.py']]);
    expect(s.log.slice(-2)).toEqual(['graph 1/0', `warning: CPG: ${U6A}`]);
    // Sabotage: the page directory is the one asked for.
    expect([s.panels.length, s.page().html]).toEqual([
      1,
      expect.stringContaining(join(root, 'page', 'graph.js')),
    ]);
  });

  it('each batch: a catch-up snapshot at its seq, so the epoch is kept and the seq grows (I-12, I-13)', async () => {
    const root = await directory({ 'a.ts': 'a', 'gone.ts': '' });
    const s = setUp({ root });
    const watch = await s.opened();
    await writeFile(join(root, 'new.ts'), '');
    watch.batch();
    await until(() => s.page().graphs.length === 2);
    await rm(join(root, 'gone.ts'));
    watch.warning('one event between takes a seq');
    watch.batch();
    await until(() => s.page().graphs.length === 3);
    expect(s.page().graphs.map(names)).toEqual([
      ['.', 'a.ts', 'gone.ts'],
      ['.', 'a.ts', 'gone.ts', 'new.ts'],
      ['.', 'a.ts', 'new.ts'],
    ]);
    expect(stamps(s.page())).toEqual(['1/0', '1/1', '1/3']);
    const report = await s.session.verify();
    expect([report?.epoch, report?.seq, s.engines.length, s.closes]).toEqual([1, 3, 1, []]);
  });

  it('refreshes are latest-wins: one in flight, at most one queued, the newest taken', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root });
    const watch = await s.opened();
    const held = s.holdInspect();
    watch.batch();
    await held.reached;
    watch.batch();
    watch.batch();
    watch.batch();
    await allMicrotasks();
    expect(s.inspected).toEqual([1, 1]);
    held.open();
    await until(() => s.page().graphs.length === 3);
    await until(() => s.answered.length === 3);
    await allMicrotasks();
    expect([stamps(s.page()), s.inspected.length]).toEqual([['1/0', '1/1', '1/4'], 3]);
  });

  it('a refresh that throws is said and the watch goes on; the first graph it brings is the initial one', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root, inspectFails: (call) => call === 1 || call === 3 });
    const opening = s.session.openGraph();
    const watch = await s.watching(1);
    await watch.ready();
    await opening;
    s.page().send(READY);
    expect([s.page().graphs, s.messages]).toEqual([
      [],
      ['error: CPG: the graph refresh failed: disk on fire'],
    ]);
    // Round two (R10): no graph, so nothing to judge; the first graph is judged.
    expect([await s.session.verify(), s.timers]).toEqual([undefined, []]);
    watch.batch();
    await until(() => s.page().graphs.length === 1);
    expect(s.timers.map(({ ms }) => ms)).toEqual([500]);
    expect((await s.session.verify())?.seq).toBe(1);
    watch.batch();
    await until(() => s.messages.length === 3);
    watch.batch();
    await until(() => s.page().graphs.length === 2);
    expect(stamps(s.page())).toEqual(['1/1', '1/3']);
    expect(s.messages).toEqual([
      'error: CPG: the graph refresh failed: disk on fire',
      `warning: CPG: ${U6A}`,
      'error: CPG: the graph refresh failed: disk on fire',
    ]);
  });

  it('closing the panel keeps the graph: verify judges it, and a new panel is sent it', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root });
    await s.opened();
    s.page().draw();
    s.page().dispose();
    expect(await s.verified()).toBe(NOT_DRAWN);
    await s.session.openGraph();
    s.page(1).send(READY);
    expect([names(s.page(1).graphs[0]), s.engines.length]).toEqual([['.', 'a.ts'], 1]);
  });
});

describe('a watch that is replaced (decision 71, BMO-121)', () => {
  // Round two (R7, R8, R9): the old refresh is still in flight when the old watch() resolves, one more is
  // queued behind it, and the configuration changes while the old watch ends.
  it('ends before the new one loads anything, and its late refresh never lands', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root, holdEnd: true });
    const first = await s.opened();
    const held = s.holdInspect();
    first.batch();
    await held.reached;
    first.batch();
    first.fail('the root went away');
    const reopening = s.session.openGraph();
    await allMicrotasks();
    expect(first.signal.aborted).toBe(true);
    await writeFile(join(root, 'b.ts'), '');
    first.end();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    // watch() has resolved, and its refresh is still in flight: nothing is closed or made yet.
    expect([s.engines.length, s.closes, s.inspected.length]).toEqual([1, [], 2]);
    await writeFile(join(root, CONFIG), 'version: 1\nwatch: { debounce_ms: 77 }\n');
    held.open();
    const second = await s.watching(2);
    expect(second.request.config).toMatchObject({ trailingMs: 77 });
    await second.ready();
    await reopening;
    // The queued refresh was dropped, and the one in flight did not land.
    expect([s.inspected, stamps(s.page())]).toEqual([
      [1, 1, 2],
      ['1/0', '2/0'],
    ]);
    expect(names(s.page().graphs[1])).toEqual(['.', 'a.ts', 'b.ts', CONFIG]);
    expect(s.log.filter((entry) => !entry.includes(': '))).toEqual([
      'connect 1',
      'watch 1',
      'graph 1/0',
      'resolved 1',
      'close 1',
      'connect 2',
      'watch 2',
      'graph 2/0',
    ]);
    expect([second.signal.aborted, s.closes]).toEqual([false, [1]]);
  });
});

describe('while a watch is live (decision 72, BMO-109)', () => {
  it('during its index, requests share it: one engine, and each resolves with its first graph', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root });
    let done = 0;
    const requests = [s.session.openGraph(), s.session.openGraph(), s.session.verify()].map(
      (request) =>
        request.then(() => {
          done += 1;
        }),
    );
    await s.session.restorePanel(new FakeSurface());
    const watch = await s.watching(1);
    await allMicrotasks();
    expect([done, s.engines.length]).toEqual([0, 1]);
    await watch.ready();
    await Promise.all(requests);
    await until(() => s.reports.length === 1);
    expect([s.engines.length, s.panels.length]).toEqual([1, 1]);
    await s.session.openGraph();
    expect(s.engines).toHaveLength(1);
  });

  // Round two (review a5): a watch cpg.verify began is joined, and the panel still opens and reveals.
  it('joins a watch cpg.verify began, and still shows the panel', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root });
    const requests = [s.session.verify(), s.session.openGraph(), s.session.openGraph()];
    const watch = await s.watching(1);
    await until(() => s.panels.length >= 1);
    s.page().send(READY);
    await watch.ready();
    await Promise.all(requests);
    await until(() => s.reports.length === 1);
    expect([s.engines.length, s.panels.length, s.page().revealed]).toEqual([1, 1, 1]);
    expect(names(s.page().graphs[0])).toEqual(['.', 'a.ts']);
  });

  it('after its first graph: only shows the panel, and an edit since comes with the watch', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root });
    const watch = await s.opened();
    await writeFile(join(root, 'b.ts'), '');
    await s.session.openGraph();
    expect([s.engines.length, s.page().revealed, s.page().graphs.length]).toEqual([1, 1, 1]);
    watch.batch();
    await until(() => s.page().graphs.length === 2);
    expect([stamps(s.page()), names(s.page().graphs[1])]).toEqual([
      ['1/0', '1/1'],
      ['.', 'a.ts', 'b.ts'],
    ]);
  });

  it('a restored panel is shown at once; it starts a watch when none is live, and none while one is', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root });
    const restored = new FakeSurface();
    await s.session.restorePanel(restored);
    expect(restored.html).not.toBe('');
    restored.send(READY);
    expect(restored.posted.map(({ type }) => type)).toEqual(['theme']);
    const first = await s.watching(1);
    await first.ready();
    await until(() => restored.graphs.length === 1);
    expect(names(restored.graphs[0])).toEqual(['.', 'a.ts']);
    await s.session.openGraph();
    expect([s.panels.length, restored.revealed, s.engines.length]).toEqual([0, 1, 1]);
    first.fail('gone');
    await until(() => s.closes.length === 1);
    // Round two (m2): VS Code restores one panel; a second is closed, and the one there is revealed.
    const again = new FakeSurface();
    await s.session.restorePanel(again);
    await (await s.watching(2)).ready();
    // Round two (R3): ready resolves before its refresh lands.
    await until(() => restored.graphs.length === 2);
    expect([again.disposed, restored.revealed, stamps(restored)]).toEqual([1, 2, ['1/0', '2/0']]);
  });

  it('cpg.verify with no graph: starts the watch, opens no panel, waits for its first graph, then judges', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root });
    let answer: unknown = 'waiting';
    const asked = s.session.verify().then((report) => {
      answer = report;
    });
    const watch = await s.watching(1);
    await allMicrotasks();
    expect([answer, s.listed]).toEqual(['waiting', []]);
    await watch.ready();
    await asked;
    expect(states(s.reports[0])).toBe(NOT_DRAWN);
    expect([answer, s.panels.length, s.engines.length]).toEqual([s.reports[0], 0, 1]);
    expect(pending(s.timers)).toEqual([]);
    await s.session.verify();
    expect(s.engines).toHaveLength(1);
  });

  it("cpg.verify with no graph, or the watch's end when it stops first: undefined, until there is one", async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root });
    const asked = s.session.verify();
    (await s.watching(1)).fail('disk on fire');
    expect(await asked).toBeUndefined();
    expect([s.messages, s.reports]).toEqual([['error: CPG: the watch stopped: disk on fire'], []]);
    const again = s.session.verify();
    await (await s.watching(2)).ready();
    expect(states(await again)).toBe(NOT_DRAWN);
    expect(await setUp({ root: undefined }).session.verify()).toBeUndefined();
  });
});

describe('a verify run that finishes after a newer graph landed (decision 73, BMO-85)', () => {
  it('is shown nowhere, and cpg.verify resolves with the next run, which is posted (I-19, I-22)', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root });
    const watch = await s.opened();
    s.page().draw();
    await s.scheduledRun();
    const held = s.holdListing();
    let answer: unknown = 'waiting';
    const asked = s.session.verify().then((report) => {
      answer = report;
    });
    await held.reached;
    await writeFile(join(root, 'b.ts'), 'b');
    watch.batch();
    await until(() => s.page().graphs.length === 2);
    const reads = s.read.length;
    held.open();
    await until(() => s.read.length > reads);
    await allMicrotasks();
    expect([answer, s.reports.length, s.page().verifications.length]).toEqual(['waiting', 1, 1]);
    expect(await s.scheduledRun()).toEqual([500]);
    await asked;
    const fresh = s.reports[1];
    expect([answer, fresh?.epoch, fresh?.seq, s.reports.length]).toEqual([fresh, 1, 1, 2]);
    // The page drew seq 0, so its report lags the graph judged (I-19).
    expect(states(fresh)).toBe('pass unavailable pass stale pass unavailable');
    expect(s.page().verifications.map(stamp)).toEqual(['1/0', '1/1']);
  });

  it("after a new epoch too: a run on the stopped watch's graph is dropped once the new one's lands", async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root });
    const first = await s.opened();
    first.fail('gone');
    await until(() => s.closes.length === 1);
    const held = s.holdListing();
    let answer: unknown = 'waiting';
    const asked = s.session.verify().then((report) => {
      answer = report;
    });
    await held.reached;
    const reopening = s.session.openGraph();
    await (await s.watching(2)).ready();
    await reopening;
    const reads = s.read.length;
    held.open();
    await until(() => s.read.length > reads);
    await allMicrotasks();
    // Both graphs are at seq 0: only the epoch says that the run is stale.
    expect([answer, s.reports, s.page().verifications]).toEqual(['waiting', [], []]);
    await s.scheduledRun();
    await asked;
    expect([answer, s.reports[0]?.epoch, s.reports[0]?.seq]).toEqual([s.reports[0], 2, 0]);
  });
});

describe('what the watch says (decision 74)', () => {
  it('a warning event: CPG: <message>, as a warning, and the watch goes on', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root });
    const watch = await s.opened([]);
    watch.warning('cannot watch sub: EACCES');
    watch.batch();
    await until(() => s.page().graphs.length === 2);
    expect(s.messages).toEqual(['warning: CPG: cannot watch sub: EACCES']);
  });

  it('an error event: said; the graph and what judges it stay; the next openGraph starts a new watch', async () => {
    const root = await directory({ 'a.ts': 'a', 'b.py': 'b' });
    const s = setUp({ root });
    const watch = await s.opened();
    watch.fail('disk on fire');
    await until(() => s.closes.length === 1);
    expect(s.messages.slice(1)).toEqual(['error: CPG: the watch stopped: disk on fire']);
    expect(s.page().graphs).toHaveLength(1);
    expect(await s.verified()).toBe(NOT_DRAWN);
    const reopening = s.session.openGraph();
    await (await s.watching(2)).ready();
    await reopening;
    expect(stamps(s.page())).toEqual(['1/0', '2/0']);
  });

  it('a bad configuration, after a watch stopped: names the file, keeps the graph and what judges it', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root });
    (await s.opened()).fail('gone');
    await writeFile(join(root, CONFIG), 'version: 1\nincludes: [x]\n');
    await s.session.openGraph();
    expect(s.messages).toHaveLength(3);
    expect(s.messages[2]).toMatch(
      /^error: CPG: cannot read the configuration: .*cpg\.config\.yaml.*includes/,
    );
    expect([s.engines.length, s.page().graphs.length]).toEqual([1, 1]);
    // The graph is judged as it was indexed: the new config file is an extra file on disk.
    expect(await s.verified()).toMatch(/^fail /);
    await rm(join(root, CONFIG));
    expect(await s.verified()).toMatch(/^pass /);
    const reopening = s.session.openGraph();
    await (await s.watching(2)).ready();
    await reopening;
    expect(s.page().graphs).toHaveLength(2);
  });

  // Round two (review a6): a narrower scope, so a run that clears the graph, or what judges it, shows.
  it('a refused store, after a watch stopped: said, and the graph is still judged as it was indexed', async () => {
    const root = await directory({ 'a.ts': 'a', 'b.py': 'b' });
    const s = setUp({ root });
    (await s.opened()).fail('gone');
    await writeFile(
      join(root, CONFIG),
      'version: 1\ninclude: ["nothing.ts"]\nconsumers: { store: falkor }\n',
    );
    await s.session.openGraph();
    expect(s.messages.slice(2)).toEqual([
      'error: CPG: cannot open the graph store: SEAT: not built yet: consumers.store falkor (FalkorStore, U5)',
    ]);
    expect([s.closes, s.page().graphs.length]).toEqual([[1], 1]);
    await rm(join(root, CONFIG));
    expect(await s.verified()).toBe(NOT_DRAWN);
  });

  // Post-implementation (sabotage #12): a watch that stops while it is still the latest.
  it('a watch that stops on an error: its refresh in flight lands, the one queued behind it is dropped', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root });
    const watch = await s.opened();
    const held = s.holdInspect();
    watch.batch();
    await held.reached;
    watch.batch();
    watch.fail('gone');
    held.open();
    await until(() => s.closes.length === 1);
    await allMicrotasks();
    expect([s.inspected.length, stamps(s.page())]).toEqual([2, ['1/0', '1/1']]);
  });

  it('a session that will not close: said once the watch has ended', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root, closeFails: true });
    const watch = await s.opened([]);
    expect(s.messages).toEqual([]);
    watch.fail('gone');
    await until(() => s.messages.length === 2);
    expect(s.messages).toEqual([
      'error: CPG: the watch stopped: gone',
      'error: CPG: cannot close the graph store: stuck',
    ]);
  });

  // Round two (R12).
  it('a watch() that rejects: said as the watch stopping; its session closes, and the next one starts', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({
      root,
      engine: (n) => (n === 1 ? { watch: () => Promise.reject(new Error('broken')) } : {}),
    });
    await s.session.openGraph();
    expect([s.messages, s.closes]).toEqual([['error: CPG: the watch stopped: broken'], [1]]);
    const reopening = s.session.openGraph();
    await (await s.watching(1)).ready([]);
    await reopening;
    expect([s.engines.length, stamps(s.page())]).toEqual([2, []]);
    s.page().send(READY);
    expect(stamps(s.page())).toEqual(['1/0']);
  });

  // Round two (R12).
  it('a session that will not close after dispose: nothing is said', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root, closeFails: true });
    await s.opened([]);
    s.session.dispose();
    await until(() => s.closes.length === 1);
    await allMicrotasks();
    expect(s.messages).toEqual([]);
  });

  it("shows the warnings: the configuration's, then ready's, zero files included", async () => {
    const root = await directory({
      'a.txt': '',
      [CONFIG]: 'version: 1\ninclude: [/nowhere/*]\nlanguages: { python: true }\n',
    });
    const s = setUp({ root });
    await s.opened();
    expect(s.messages).toEqual([
      `warning: CPG: ${join(root, CONFIG)}: 'languages' is parsed but not applied (ResolvedConfig has no languages key); ${U6A}; no files indexed under ${root}`,
    ]);
  });

  // Round two (review a7): the real index always warns, so this one drops its warnings.
  it('with nothing to warn about: says nothing', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root });
    await s.opened([]);
    expect(s.messages).toEqual([]);
  });

  it('no folder: a message, no panel and no engine', async () => {
    const s = setUp({ root: undefined });
    await s.session.openGraph();
    await s.session.verify();
    expect(s.messages).toEqual([
      'error: CPG: open a folder first',
      'error: CPG: open a folder first',
    ]);
    expect([s.panels.length, s.engines.length, s.reports.length]).toEqual([0, 0, 0]);
    const restored = new FakeSurface();
    await s.session.restorePanel(restored);
    expect(restored.html).not.toBe('');
    await until(() => s.messages.length === 3);
  });
});

// Sprint 25 (the drift crawl): controller decision 78 (the watch's interval comes from the configuration)
// and 79 (cpg.rescan fires the live watch's trigger, or says there is none).
const NONE = 'warning: CPG: no graph is being watched';

describe('cpg.rescan (decisions 78, 79)', () => {
  it.each([
    ['the default', undefined, 300000],
    ["the file's", 'version: 1\nwatch: { rescan_interval_ms: 0 }\n', 0],
  ] as const)('the watch asks for %s rescan interval', async (_what, file, ms) => {
    const root = await directory(file === undefined ? {} : { [CONFIG]: file });
    const s = setUp({ root });
    void s.session.openGraph();
    const watch = await s.watching(1);
    expect(watch.request.config.rescanIntervalMs).toBe(ms);
  });

  it('during a live watch it reaches every listener the watch subscribed, and says nothing', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root });
    const watch = await s.opened();
    const said = [...s.messages];
    const heard: string[] = [];
    const offFirst = watch.request.rescan?.subscribe(() => heard.push('first'));
    watch.request.rescan?.subscribe(() => heard.push('second'));
    s.session.rescan();
    offFirst?.();
    s.session.rescan();
    expect([heard, s.messages]).toEqual([['first', 'second', 'second'], said]);
  });

  it('with no live watch it only says so: before any, once the watch has closed, with no folder', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root });
    s.session.rescan();
    const watch = await s.opened();
    const heard: string[] = [];
    watch.request.rescan?.subscribe(() => heard.push('closed'));
    watch.fail('gone');
    await until(() => watch.ended);
    s.session.rescan();
    const none = setUp({ root: undefined });
    none.session.rescan();
    expect(heard).toEqual([]);
    expect(s.messages.filter((m) => m === NONE)).toHaveLength(2);
    expect(none.messages).toEqual([NONE]);
  });

  it('reaches only the watch now live, never one it replaced; after dispose it does nothing and says nothing', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root });
    const first = await s.opened();
    const heard: string[] = [];
    first.request.rescan?.subscribe(() => heard.push('first'));
    first.fail('stopped');
    await until(() => first.ended);
    void s.session.openGraph();
    const second = await s.watching(2);
    second.request.rescan?.subscribe(() => heard.push('second'));
    s.session.rescan();
    s.session.dispose();
    const said = s.messages.length;
    s.session.rescan();
    expect([heard, s.messages.length]).toEqual([['second'], said]);
  });
});

describe('cpg.verify', () => {
  it('judges the graph held: one stale revision fails revision-reconciliation alone (E4), until its batch', async () => {
    const root = await directory({ 'a.ts': 'a', 'b.py': 'b' });
    const s = setUp({ root });
    const watch = await s.opened();
    s.page().draw();
    expect(await s.verified()).toBe(ALL_PASS);
    // Same length, same names: only the bytes differ.
    await writeFile(join(root, 'a.ts'), 'A');
    expect(await s.verified()).toBe('pass unavailable pass pass fail unavailable');
    expect(s.reports.at(-1)?.checks[4]?.localisedTo).toEqual(['a.ts']);
    // At once, in place of the debounced run.
    expect(pending(s.timers)).toEqual([]);
    expect(s.page().verifications).toHaveLength(2);
    watch.batch();
    await until(() => s.page().graphs.length === 2);
    s.page().draw();
    expect(await s.verified()).toBe(ALL_PASS);
    expect(s.engines).toHaveLength(1);
  });

  it('judges by the scope its watch started with, until the next watch', async () => {
    const root = await directory({ 'a.ts': 'a', 'b.py': 'b', [CONFIG]: 'version: 1\n' });
    const s = setUp({ root });
    const first = await s.opened();
    await writeFile(join(root, CONFIG), 'version: 1\ninclude: ["*.ts"]\n');
    expect(await s.verified()).toMatch(/^pass .* fail unavailable$/);
    first.fail('gone');
    const reopening = s.session.openGraph();
    await (await s.watching(2)).ready();
    await reopening;
    expect(await s.verified()).toBe(NOT_DRAWN);
  });

  it('runs 500 ms after the graph lands and after the page draws, and reaches the page', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root });
    await s.opened();
    expect(await s.scheduledRun()).toEqual([500]);
    expect(states(s.reports[0])).toBe(NOT_DRAWN);
    s.page().draw();
    expect(await s.scheduledRun()).toEqual([500]);
    expect(states(s.reports[1])).toBe(ALL_PASS);
    expect(s.page().posted.map(({ type }) => type)).toEqual([
      'theme',
      'graph',
      'verification',
      'verification',
    ]);
    s.page().draw({ renderedNodeCount: 1 });
    await s.scheduledRun();
    expect(states(s.reports[2])).toBe('pass unavailable pass fail pass unavailable');
  });

  it('is not asked for before there is a graph, whatever the page reports', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root });
    const opening = s.session.openGraph();
    const watch = await s.watching(1);
    s.page().send(READY);
    const report = { payloadNodeCount: 0, renderedNodeCount: 0, renderedEdgeCount: 0 };
    s.page().send({
      type: 'render-report',
      epoch: 0,
      seq: -1,
      report: { ...report, duplicateEdges: 0, droppedNodeIds: [], frameMs: 1 },
    });
    expect(s.timers).toEqual([]);
    await watch.ready();
    await opening;
    expect(s.timers.map(({ ms }) => ms)).toEqual([500]);
  });

  it('says so when a run or its report fails, and the next one still runs', async () => {
    const root = await directory({ 'a.ts': 'a' });
    let broken = true;
    const s = setUp({
      root,
      onReport: () => {
        if (broken) throw new Error('no status bar');
      },
    });
    await s.opened();
    await s.verified();
    expect(s.messages.slice(1)).toEqual(['error: CPG: verify failed: no status bar']);
    broken = false;
    await s.verified();
    expect([s.messages.length, s.reports.length]).toEqual([2, 2]);
  });
});

// Controller decision 40 (U3.1.2): what a host test reads.
describe('what cpg.verify resolves with', () => {
  it('the report the editor is shown, of the run it caused', async () => {
    const root = await directory({ 'a.ts': 'a', 'b.py': 'b' });
    const s = setUp({ root });
    await s.opened();
    s.page().draw();
    const fine = await s.session.verify();
    expect(states(fine)).toBe(ALL_PASS);
    await writeFile(join(root, 'a.ts'), 'A');
    const stale = await s.session.verify();
    expect(states(stale)).toBe('pass unavailable pass pass fail unavailable');
    expect([stale?.epoch, stale?.seq]).toEqual([1, 0]);
    expect([s.reports.length, s.reports[0], s.reports[1]]).toEqual([2, fine, stale]);
  });

  it("with no graph: the first graph's", async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root });
    const asked = Promise.all([s.session.verify(), s.session.verify()]);
    await (await s.watching(1)).ready();
    expect((await asked).map(states)).toEqual([NOT_DRAWN, NOT_DRAWN]);
    expect(s.engines).toHaveLength(1);
  });

  it('undefined once deactivated, and the run going then', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root });
    const asked = s.session.verify();
    await (await s.watching(1)).ready();
    expect(states(await asked)).toBe(NOT_DRAWN);
    const going = s.session.verify();
    s.session.dispose();
    expect([await going, await s.session.verify()]).toEqual([undefined, undefined]);
    expect(s.reports).toHaveLength(1);
  });
});

describe('the page', () => {
  it('opens source through the opener, and shows what went wrong', async () => {
    const root = await directory({ 'a.ts': 'a', 'b.py': '' });
    const asked: unknown[] = [];
    const opener: SourceOpener = {
      open: (request) => {
        asked.push(request);
        return request.filePath === 'b.py' ? Promise.reject(new Error('busy')) : Promise.resolve();
      },
    };
    const s = setUp({ root, opener });
    await s.opened();
    for (const id of ['file:a.ts', 'file:b.py', 'dir:.', 'file:nope']) {
      s.page().send({ type: 'reveal', nodeId: id });
    }
    await until(() => s.messages.length === 4);
    expect(asked).toEqual([{ filePath: 'a.ts' }, { filePath: 'b.py' }]);
    expect(s.messages.slice(1).toSorted()).toEqual([
      'warning: CPG: cannot open b.py: busy',
      'warning: CPG: dir:. has no source location to open',
      'warning: CPG: the graph has no node file:nope',
    ]);
  });

  it('is sent a theme change alone', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root });
    await s.opened();
    const light: ThemeSnapshot = { ...THEME, kind: 'light' };
    s.session.setTheme(light);
    expect(s.page().posted.slice(2)).toEqual([
      { type: 'theme', protocol: 1, epoch: 1, theme: light },
    ]);
  });
});

describe('deactivation (decision 74)', () => {
  it('aborts the watch at once, says nothing after, cancels the pending verify, and leaves the panel open', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root, holdEnd: true });
    const watch = await s.opened();
    s.session.dispose();
    expect(watch.signal.aborted).toBe(true);
    expect(s.timers.every((timer) => timer.cancelled)).toBe(true);
    expect(s.page().disposed).toBe(0);
    watch.warning('late');
    watch.batch();
    watch.fail('later');
    // Round two (m1): a refresh the batch may start (it should not) has settled before anything is read.
    await until(() => s.answered.length === s.inspected.length);
    await allMicrotasks();
    expect([s.messages, s.closes, stamps(s.page())]).toEqual([
      [`warning: CPG: ${U6A}`],
      [],
      ['1/0'],
    ]);
    watch.end();
    await until(() => s.closes.length === 1);
    const before = s.page().posted.length;
    s.session.setTheme(THEME);
    expect(s.page().posted).toHaveLength(before);
    await s.session.verify();
    await allMicrotasks();
    expect([s.listed, s.messages.length]).toEqual([[], 1]);
  });

  // Post-implementation (sabotage #25): dispose lands before the engine has closed the watch.
  it('a refresh queued behind the one in flight is never started after dispose', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root, holdEnd: true });
    const watch = await s.opened();
    const held = s.holdInspect();
    watch.batch();
    await held.reached;
    watch.batch();
    s.session.dispose();
    held.open();
    await until(() => s.answered.length === 2);
    await allMicrotasks();
    expect([s.inspected.length, s.closes]).toEqual([2, []]);
    watch.end();
    await until(() => s.closes.length === 1);
  });

  it.each(['before ready', "with ready's refresh in flight"] as const)(
    '%s: delivers and says nothing, and the session closes',
    async (when) => {
      const root = await directory({ 'a.ts': 'a' });
      const s = setUp({ root });
      const opening = s.session.openGraph();
      const watch = await s.watching(1);
      s.page().send(READY);
      const held = s.holdInspect();
      if (when !== 'before ready') {
        void watch.ready();
        await held.reached;
        // Round two (R9): one more queued behind it, dropped.
        watch.batch();
      }
      s.session.dispose();
      // Round two (R7): the session is not closed while a refresh is in flight.
      await allMicrotasks();
      expect(s.closes).toEqual(when === 'before ready' ? [1] : []);
      held.open();
      await opening;
      await until(() => s.closes.length === 1);
      await allMicrotasks();
      expect([s.messages, s.page().graphs, watch.signal.aborted]).toEqual([[], [], true]);
      expect(s.inspected).toHaveLength(when === 'before ready' ? 0 : 1);
      await s.session.verify();
      expect([s.engines.length, s.messages]).toEqual([1, []]);
    },
  );

  // Post-implementation (review of the diff): the watch of a restored panel starts after its HTML.
  it('in a restored panel, before its watch: nothing starts, nothing is said', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const s = setUp({ root });
    const restored = new FakeSurface();
    const shown = s.session.restorePanel(restored);
    s.session.dispose();
    await shown;
    expect(restored.html).not.toBe('');
    // A session that is not disposed, started later, makes its engine: time enough for this one.
    const control = setUp({ root });
    await control.session.restorePanel(new FakeSurface());
    await until(() => control.engines.length === 1);
    expect([s.engines.length, s.messages.length, s.timers.length]).toEqual([0, 0, 0]);
  });
});

describe('on the real engine and @parcel/watcher', () => {
  // Round two (R6): the waits below are 10 s each, so the test's own limit is above both.
  it(
    'a file written joins the graph and a deleted one leaves it, in one epoch; dispose closes it',
    { timeout: 30_000 },
    async () => {
      const root = await directory({ 'a.ts': 'a' });
      const s = setUp({ root, real: true });
      await s.session.openGraph();
      s.page().send(READY);
      expect(names(s.page().graphs[0])).toEqual(['.', 'a.ts']);
      await writeFile(join(root, 'b.ts'), 'b');
      await until(() => names(s.page().graphs.at(-1)).includes('b.ts'), 10_000);
      await rm(join(root, 'a.ts'));
      await until(() => !names(s.page().graphs.at(-1)).includes('a.ts'), 10_000);
      expect(names(s.page().graphs.at(-1))).toEqual(['.', 'b.ts']);
      const seen = stamps(s.page()).map((at) => at.split('/').map(Number));
      expect([...new Set(seen.map(([epoch]) => epoch))]).toEqual([1]);
      expect(seen[0]).toEqual([1, 0]);
      const seqs = seen.map(([, seq]) => seq ?? -1);
      expect(seqs.every((seq, at) => at === 0 || seq > (seqs[at - 1] ?? seq))).toBe(true);
      s.session.dispose();
      await until(() => s.closes.length === 1);
    },
  );
});

/** A Logger that records `<level> <message>`, and the stack of an Error argument. */
const recorder = () => {
  const lines: string[] = [];
  const at =
    (level: string) =>
    (message: string | Error, ...args: unknown[]): void => {
      const extra = args.find((arg): arg is Error => arg instanceof Error);
      lines.push(`${level} ${String(message)}${extra === undefined ? '' : ` | ${extra.message}`}`);
    };
  const log: Logger = {
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  };
  return { log, lines };
};

describe('the log', () => {
  it('says what the session does, and logs each message it shows', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const { log, lines } = recorder();
    const s = setUp({ root, log });
    await s.opened(['one warning']);
    expect(lines).toContain('info cpg.openGraph');
    expect(lines).toContain(`info watch 1: starting in ${root}`);
    expect(lines).toContain('warn CPG: one warning');
    expect(s.messages).toContain('warning: CPG: one warning');
  });

  it('logs a protocol fault from the page as a warning', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const { log, lines } = recorder();
    const s = setUp({ root, log });
    await s.opened();
    s.page().send('not a message');
    expect(lines).toContain('warn protocol fault: unknown-message');
  });

  it('logs an error it shows with the cause', async () => {
    const { log, lines } = recorder();
    const s = setUp({ log });
    await s.session.openGraph();
    expect(lines).toContain('error CPG: open a folder first');
  });
});
