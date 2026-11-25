// The extension's flows (controller decisions 28, 35 to 38) over the real engine and real workspaces. Only
// VS Code is fake: the panel, the clock and the messages. Expected values: those decisions, 08-verification
// §3.1, and the doc comments.

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, type CpgEngine } from '@cpg/engine';
import type { HostToWebview, ThemeSnapshot, VerificationReport } from '@cpg/model';
import { afterEach, describe, expect, it } from 'vitest';
import type { SourceOpener, WebviewTransport } from './contract';
import type { PanelSurface } from './graph-panel';
import { GraphSession } from './graph-session';
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
afterEach(async () => {
  await Promise.all(directories.splice(0).map((at) => rm(at, { recursive: true, force: true })));
});

const CONFIG = 'cpg.config.yaml';
const U6A = 'the code tier is not built yet (U6a): only the filesystem tier was indexed';
const THEME: ThemeSnapshot = { kind: 'dark', nodeColors: {}, defaultNodeColor: '#999999' };
const ALL_PASS = 'pass unavailable pass pass pass unavailable';
const READY = { type: 'ready', protocol: 1 };
const allMicrotasks = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
async function until(done: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!done()) {
    if (performance.now() > deadline) throw new Error('it never happened');
    // oxlint-disable-next-line no-await-in-loop -- real I/O, one tick at a time
    await allMicrotasks();
  }
}

const diskFileSystem = (root: string, listed: string[]): WorkspaceFileSystem => ({
  readDirectory: async (path) => {
    listed.push(path);
    return (await readdir(join(root, path), { withFileTypes: true })).map(
      (entry) => [entry.name, entry.isDirectory() ? 2 : 1] as const,
    );
  },
  size: async (path) => (await stat(join(root, path))).size,
  readFile: (path) => readFile(join(root, path)),
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
    post: (message) => this.posted.push(message),
    onMessage: (handler) => {
      this.handler = handler;
      return { dispose: () => undefined };
    },
  };
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
}

interface SetUp {
  readonly root?: string | undefined;
  /** Changes one engine, by the order it was made in (from 1). */
  readonly engine?: (made: CpgEngine, n: number) => Partial<CpgEngine>;
  readonly opener?: SourceOpener;
  readonly onReport?: (report: VerificationReport) => void;
}

function setUp(over: SetUp = {}) {
  const messages: string[] = [];
  const reports: VerificationReport[] = [];
  const panels: FakeSurface[] = [];
  const engines: { version: string; consumers: unknown }[] = [];
  const closes: number[] = [];
  /** The directories verify listed: a run starts by listing '.'. */
  const listed: string[] = [];
  const timers: { ms: number; callback: () => void; cancelled: boolean }[] = [];
  const bundles = join(over.root ?? tmpdir(), 'page');
  const session = new GraphSession({
    root: over.root,
    version: '9.8.7',
    createEngine: (config) => {
      engines.push(config);
      const n = engines.length;
      const real = createEngine(config);
      return {
        ...real,
        ...over.engine?.(real, n),
        connect: async (target, opts) => {
          const opened = await real.connect(target, opts);
          return {
            ...opened,
            close: async () => {
              closes.push(n);
              await opened.close();
            },
          };
        },
      };
    },
    fileSystem: diskFileSystem(over.root ?? tmpdir(), listed),
    opener: over.opener ?? { open: () => Promise.resolve() },
    theme: THEME,
    createPanel: () => {
      const panel = new FakeSurface();
      panels.push(panel);
      return panel;
    },
    pageDirectory: bundles,
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
    showWarning: (text) => messages.push(`warning: ${text}`),
    showError: (text) => messages.push(`error: ${text}`),
  });
  /** The n-th panel made (from 0); a test that talks to one that is not there fails (review a4). */
  const page = (n = 0): FakeSurface => {
    const panel = panels[n];
    if (panel === undefined) throw new Error(`panel ${String(n)} was not made`);
    return panel;
  };
  /** Fires the one pending timer and waits for its run's report. */
  const scheduledRun = async () => {
    const pending = timers.filter((timer) => !timer.cancelled);
    if (pending.length !== 1) throw new Error(`${String(pending.length)} timers are pending`);
    const before = reports.length;
    for (const timer of pending) {
      timer.cancelled = true;
      timer.callback();
    }
    await until(() => reports.length > before);
    return pending.map((timer) => timer.ms);
  };
  const verified = async () => {
    const before = reports.length;
    await session.verify();
    await until(() => reports.length > before);
    return states(reports.at(-1));
  };
  return {
    session,
    messages,
    reports,
    panels,
    engines,
    closes,
    listed,
    timers,
    scheduledRun,
    verified,
    page,
  };
}

function states(report: VerificationReport | undefined): string {
  return (report?.checks ?? []).map((check) => check.state).join(' ');
}
const names = (message: HostToWebview | undefined): string[] =>
  message?.type === 'graph'
    ? message.payload.nodes.map((node) => node.name ?? '').toSorted()
    : ['no graph'];
/** A promise, and what resolves it. */
function gate() {
  const held: { open: () => void } = { open: () => undefined };
  const opened = new Promise<void>((resolve) => {
    held.open = resolve;
  });
  return { opened, open: () => held.open() };
}

describe('cpg.openGraph', () => {
  it('shows the panel and delivers the index as an initial snapshot', async () => {
    const root = await directory({ 'a.ts': 'a', 'b.py': 'b' });
    const { session, panels, engines, messages } = setUp({ root });
    await session.openGraph();
    expect(panels).toHaveLength(1);
    expect(panels[0]?.html).not.toBe('');
    panels[0]?.send(READY);
    expect(panels[0]?.posted.map(({ type, epoch }) => [type, epoch])).toEqual([
      ['theme', 1],
      ['graph', 1],
    ]);
    expect(names(panels[0]?.posted[1])).toEqual(['.', 'a.ts', 'b.py']);
    expect(engines).toEqual([
      { version: '9.8.7', consumers: { inspect: false, store: 'memory', vscode: true } },
    ]);
    expect(messages).toEqual([`warning: CPG: ${U6A}`]);
  });

  it('again: reveals the panel and indexes again, with nothing left of a deleted file', async () => {
    const root = await directory({ 'a.ts': 'a', 'gone.ts': '' });
    const { session, panels, closes } = setUp({ root });
    await session.openGraph();
    panels[0]?.send(READY);
    await rm(join(root, 'gone.ts'));
    await writeFile(join(root, 'new.ts'), '');
    await session.openGraph();
    expect([panels.length, panels[0]?.revealed]).toEqual([1, 1]);
    expect(panels[0]?.graphs.map((graph) => [graph.epoch, names(graph)])).toEqual([
      [1, ['.', 'a.ts', 'gone.ts']],
      [2, ['.', 'a.ts', 'new.ts']],
    ]);
    expect(closes).toEqual([1, 2]);
  });

  it('resolves when the index is done, and requests meanwhile share that index', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const { opened, open } = gate();
    const { session, engines, panels, reports } = setUp({
      root,
      engine: (real) => ({ index: (...args) => opened.then(() => real.index(...args)) }),
    });
    let done = 0;
    const requests = [session.openGraph(), session.openGraph(), session.verify()].map((request) =>
      request.then(() => {
        done += 1;
      }),
    );
    await session.restorePanel(new FakeSurface());
    await until(() => engines.length >= 1);
    await allMicrotasks();
    expect([done, engines.length]).toEqual([0, 1]);
    open();
    await Promise.all(requests);
    await until(() => reports.length === 1);
    expect([engines.length, panels.length]).toEqual([1, 1]);
    await session.openGraph();
    expect(engines).toHaveLength(2);
  });

  // Round two (review a5): an index cpg.verify began is joined, and the panel still opens and reveals.
  it('joins an index cpg.verify began, and still shows the panel', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const { opened, open } = gate();
    const { session, engines, panels, page, reports } = setUp({
      root,
      engine: (real) => ({ index: (...args) => opened.then(() => real.index(...args)) }),
    });
    const requests = [session.verify(), session.openGraph(), session.openGraph()];
    await until(() => engines.length >= 1 && panels.length >= 1);
    page().send(READY);
    open();
    await Promise.all(requests);
    await until(() => reports.length === 1);
    expect([engines.length, panels.length, page().revealed]).toEqual([1, 1, 1]);
    expect(names(page().graphs[0])).toEqual(['.', 'a.ts']);
  });

  it('closing the panel keeps the graph: verify judges it, and a new panel is sent it', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const { session, panels, engines, verified } = setUp({ root });
    await session.openGraph();
    panels[0]?.send(READY);
    panels[0]?.draw();
    panels[0]?.dispose();
    expect(await verified()).toBe('pass unavailable pass unavailable pass unavailable');
    expect(engines).toHaveLength(1);
    await session.openGraph();
    panels[1]?.send(READY);
    expect(names(panels[1]?.graphs[0])).toEqual(['.', 'a.ts']);
  });
});

describe('a restored panel', () => {
  it('is shown at once, and indexed as cpg.openGraph does', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const { opened, open } = gate();
    const { session, panels, messages } = setUp({
      root,
      engine: (real) => ({ index: (...args) => opened.then(() => real.index(...args)) }),
    });
    const restored = new FakeSurface();
    await session.restorePanel(restored);
    expect(restored.html).not.toBe('');
    restored.send(READY);
    expect(restored.posted.map(({ type }) => type)).toEqual(['theme']);
    open();
    await until(() => restored.graphs.length === 1);
    expect(names(restored.graphs[0])).toEqual(['.', 'a.ts']);
    await until(() => messages.length === 1);
    await session.openGraph();
    expect([panels.length, restored.revealed]).toEqual([0, 1]);
  });
});

describe('cpg.verify', () => {
  it('judges the graph held, without indexing: one stale revision fails revision-reconciliation alone (E4)', async () => {
    const root = await directory({ 'a.ts': 'a', 'b.py': 'b' });
    const { session, panels, engines, reports, verified, timers } = setUp({ root });
    await session.openGraph();
    panels[0]?.send(READY);
    panels[0]?.draw();
    expect(await verified()).toBe(ALL_PASS);
    // Same length, same names: only the bytes differ.
    await writeFile(join(root, 'a.ts'), 'A');
    expect(await verified()).toBe('pass unavailable pass pass fail unavailable');
    expect(reports.at(-1)?.checks[4]?.localisedTo).toEqual(['a.ts']);
    expect(engines).toHaveLength(1);
    // At once, in place of the debounced run.
    expect(timers.filter((timer) => !timer.cancelled)).toEqual([]);
    const verdicts = panels[0]?.posted.filter(({ type }) => type === 'verification');
    expect(verdicts).toHaveLength(2);
    await session.openGraph();
    panels[0]?.draw();
    expect(await verified()).toBe(ALL_PASS);
  });

  it('with no graph: indexes once, opens no panel, then judges', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const { panels, engines, reports, timers, verified } = setUp({ root });
    expect(await verified()).toBe('pass unavailable pass unavailable pass unavailable');
    expect([panels.length, engines.length, reports.length]).toEqual([0, 1, 1]);
    expect(timers.filter((timer) => !timer.cancelled)).toEqual([]);
    await verified();
    expect(engines).toHaveLength(1);
  });

  it('judges by the scope the graph was indexed with, until the next index', async () => {
    const root = await directory({ 'a.ts': 'a', 'b.py': 'b', [CONFIG]: 'version: 1\n' });
    const { session, verified } = setUp({ root });
    await session.openGraph();
    await writeFile(join(root, CONFIG), 'version: 1\ninclude: ["*.ts"]\n');
    expect(await verified()).toMatch(/^pass .* fail unavailable$/);
    await session.openGraph();
    expect(await verified()).toBe('pass unavailable pass unavailable pass unavailable');
  });

  it('runs 500 ms after the graph lands and after the page draws, and reaches the page', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const { session, panels, reports, scheduledRun } = setUp({ root });
    await session.openGraph();
    panels[0]?.send(READY);
    expect(await scheduledRun()).toEqual([500]);
    expect(states(reports[0])).toBe('pass unavailable pass unavailable pass unavailable');
    panels[0]?.draw();
    expect(await scheduledRun()).toEqual([500]);
    expect(states(reports[1])).toBe(ALL_PASS);
    expect(panels[0]?.posted.map(({ type }) => type)).toEqual([
      'theme',
      'graph',
      'verification',
      'verification',
    ]);
    panels[0]?.draw({ renderedNodeCount: 1 });
    await scheduledRun();
    expect(states(reports[2])).toBe('pass unavailable pass fail pass unavailable');
  });

  it('is not asked for before there is a graph, whatever the page reports', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const { opened, open } = gate();
    const { session, panels, timers, page } = setUp({
      root,
      engine: (real) => ({ index: (...args) => opened.then(() => real.index(...args)) }),
    });
    const opening = session.openGraph();
    await until(() => panels.length === 1);
    page().send(READY);
    const report = { payloadNodeCount: 0, renderedNodeCount: 0, renderedEdgeCount: 0 };
    page().send({
      type: 'render-report',
      epoch: 0,
      seq: -1,
      report: { ...report, duplicateEdges: 0, droppedNodeIds: [], frameMs: 1 },
    });
    expect(timers).toEqual([]);
    open();
    await opening;
    expect(timers.map(({ ms }) => ms)).toEqual([500]);
  });

  it('says so when a run or its report fails, and the next one still runs', async () => {
    const root = await directory({ 'a.ts': 'a' });
    let broken = true;
    const { session, messages, reports, verified } = setUp({
      root,
      onReport: () => {
        if (broken) throw new Error('no status bar');
      },
    });
    await session.openGraph();
    await verified();
    expect(messages.slice(1)).toEqual(['error: CPG: verify failed: no status bar']);
    broken = false;
    await verified();
    expect([messages.length, reports.length]).toEqual([2, 2]);
  });
});

describe('what goes wrong is said once and leaves the extension usable', () => {
  it('no folder: a message, no panel and no engine', async () => {
    const { session, messages, panels, engines, reports } = setUp({ root: undefined });
    await session.openGraph();
    await session.verify();
    expect(messages).toEqual([
      'error: CPG: open a folder first',
      'error: CPG: open a folder first',
    ]);
    expect([panels.length, engines.length, reports.length]).toEqual([0, 0, 0]);
    const restored = new FakeSurface();
    await session.restorePanel(restored);
    expect(restored.html).not.toBe('');
    await until(() => messages.length === 3);
  });

  it('a bad configuration: names the file, keeps the graph and what judges it', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const { session, messages, engines, verified, panels } = setUp({ root });
    await session.openGraph();
    panels[0]?.send(READY);
    await writeFile(join(root, CONFIG), 'version: 1\nincludes: [x]\n');
    await session.openGraph();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatch(
      /^error: CPG: cannot read the configuration: .*cpg\.config\.yaml.*includes/,
    );
    expect([engines.length, panels[0]?.graphs.length]).toEqual([1, 1]);
    // The graph is judged as it was indexed: the new config file is an extra file on disk.
    expect(await verified()).toMatch(/^fail /);
    await rm(join(root, CONFIG));
    expect(await verified()).toMatch(/^pass /);
    await session.openGraph();
    expect(panels[0]?.graphs).toHaveLength(2);
  });

  // Round two (review a6): with a graph held, so a run that clears it, or the scope it is judged by, shows.
  const NARROW = 'include: ["nothing.ts"]\n';

  it('a refused store: said, and the held graph is still judged as it was indexed', async () => {
    const root = await directory({ 'a.ts': 'a', 'b.py': 'b' });
    const { session, messages, reports, closes, page, verified } = setUp({ root });
    await session.openGraph();
    page().send(READY);
    await writeFile(join(root, CONFIG), `version: 1\n${NARROW}consumers: { store: falkor }\n`);
    await session.openGraph();
    expect(messages.slice(1)).toEqual([
      'error: CPG: cannot open the graph store: SEAT: not built yet: consumers.store falkor (FalkorStore, U5)',
    ]);
    expect([closes, page().graphs.length]).toEqual([[1], 1]);
    await rm(join(root, CONFIG));
    expect(await verified()).toBe('pass unavailable pass unavailable pass unavailable');
    expect(reports).toHaveLength(1);
  });

  it.each([
    ['index', { index: () => Promise.reject(new Error('disk on fire')) }],
    ['inspect', { inspect: () => Promise.reject(new Error('disk on fire')) }],
  ] as const)(
    'a failed %s: said, closed, and the held graph is still judged',
    async (_what, fails) => {
      const root = await directory({ 'a.ts': 'a', 'b.py': 'b' });
      const { session, messages, closes, page, verified } = setUp({
        root,
        engine: (_real, n) => (n === 2 ? fails : {}),
      });
      await session.openGraph();
      page().send(READY);
      await writeFile(join(root, CONFIG), `version: 1\n${NARROW}`);
      await session.openGraph();
      expect(messages.slice(1)).toEqual(['error: CPG: the index failed: disk on fire']);
      expect([closes, page().graphs.length]).toEqual([[1, 2], 1]);
      await rm(join(root, CONFIG));
      expect(await verified()).toBe('pass unavailable pass unavailable pass unavailable');
      await session.openGraph();
      expect(page().graphs).toHaveLength(2);
      expect(closes).toEqual([1, 2, 3]);
    },
  );

  it('a first index that fails: cpg.verify says so and judges nothing', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const { session, messages, reports, engines } = setUp({
      root,
      engine: () => ({ index: () => Promise.reject(new Error('disk on fire')) }),
    });
    await session.verify();
    await session.verify();
    await allMicrotasks();
    expect(messages).toEqual([
      'error: CPG: the index failed: disk on fire',
      'error: CPG: the index failed: disk on fire',
    ]);
    expect([reports.length, engines.length]).toEqual([0, 2]);
  });

  it("shows the warnings: the configuration's, then the index's, zero files included", async () => {
    const root = await directory({
      'a.txt': '',
      [CONFIG]: 'version: 1\ninclude: [/nowhere/*]\nlanguages: { python: true }\n',
    });
    const { session, messages } = setUp({ root });
    await session.openGraph();
    expect(messages).toEqual([
      `warning: CPG: ${join(root, CONFIG)}: 'languages' is parsed but not applied (ResolvedConfig has no languages key); ${U6A}; no files indexed under ${root}`,
    ]);
  });
});

describe('with nothing to warn about', () => {
  // Round two (review a7): the real index always warns, so this one drops its warnings.
  it('says nothing', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const { session, messages } = setUp({
      root,
      engine: (real) => ({
        index: async (...args) => ({ ...(await real.index(...args)), warnings: [] }),
      }),
    });
    await session.openGraph();
    expect(messages).toEqual([]);
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
    const { session, panels, messages } = setUp({ root, opener });
    await session.openGraph();
    panels[0]?.send(READY);
    for (const id of ['file:a.ts', 'file:b.py', 'dir:.', 'file:nope']) {
      panels[0]?.send({ type: 'reveal', nodeId: id });
    }
    await until(() => messages.length === 4);
    expect(asked).toEqual([{ filePath: 'a.ts' }, { filePath: 'b.py' }]);
    expect(messages.slice(1).toSorted()).toEqual([
      'warning: CPG: cannot open b.py: busy',
      'warning: CPG: dir:. has no source location to open',
      'warning: CPG: the graph has no node file:nope',
    ]);
  });

  it('is sent a theme change alone', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const { session, panels } = setUp({ root });
    await session.openGraph();
    panels[0]?.send(READY);
    const light: ThemeSnapshot = { ...THEME, kind: 'light' };
    session.setTheme(light);
    expect(panels[0]?.posted.slice(2)).toEqual([
      { type: 'theme', protocol: 1, epoch: 1, theme: light },
    ]);
  });
});

describe('deactivation', () => {
  it('cancels the pending verify and leaves the panel open', async () => {
    const root = await directory({ 'a.ts': 'a' });
    const { session, panels, timers, listed } = setUp({ root });
    await session.openGraph();
    panels[0]?.send(READY);
    session.dispose();
    expect(timers.every((timer) => timer.cancelled)).toBe(true);
    expect(panels[0]?.disposed).toBe(0);
    const before = panels[0]?.posted.length;
    session.setTheme(THEME);
    expect(panels[0]?.posted).toHaveLength(before ?? -1);
    await session.verify();
    await allMicrotasks();
    expect(listed).toEqual([]);
  });

  it.each(['index', 'inspect'] as const)(
    'in an index (%s): aborts it, delivers and says nothing, and closes its session',
    async (held) => {
      const root = await directory({ 'a.ts': 'a' });
      const { opened, open } = gate();
      const reached = gate();
      const signals: boolean[] = [];
      const { session, panels, messages, closes, engines } = setUp({
        root,
        engine: (real) => ({
          index: async (req, onProgress, signal) => {
            if (held === 'index') {
              reached.open();
              await opened;
              signals.push(signal.aborted);
            }
            return real.index(req, onProgress, signal);
          },
          inspect: async (...args) => {
            if (held === 'inspect') {
              reached.open();
              await opened;
            }
            return real.inspect(...args);
          },
        }),
      });
      const opening = session.openGraph();
      await reached.opened;
      panels[0]?.send(READY);
      session.dispose();
      open();
      await opening;
      expect(signals).toEqual(held === 'index' ? [true] : []);
      expect([messages, closes]).toEqual([[], [1]]);
      expect(panels[0]?.graphs).toEqual([]);
      await session.verify();
      expect([engines.length, messages]).toEqual([1, []]);
    },
  );
});
