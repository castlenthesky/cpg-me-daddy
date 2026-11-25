// C-EXT conformance, part 2: verify (I-10, I-18, I-19, I-22, E4; controller decisions 29 and 36). The
// probe is a fake over a record, and one group runs the real engine over a temporary workspace.
// Expected values come from 05-contracts.yaml C-EXT, 08-verification §3.1 and the doc comments.

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createEngine, walkWorkspace } from '@cpg/engine';
import {
  applyGraphDelta,
  isWorkspacePath,
  type GraphDelta,
  type GraphNode,
  type GraphPayload,
  type HostToWebview,
  type RenderReport,
  type VerificationReport,
  type VerifyCheckId,
  type WebviewToHost,
  type WorkspacePath,
} from '@cpg/model';
import { afterEach, describe, expect, it } from 'vitest';
import type { FilesystemProbe, WebviewTransport } from './contract';
import { PanelGraphHost } from './graph-host';

const FS = 'filesystem-reconciliation';
const UNIQUE = 'id-uniqueness';
const RENDER = 'render-reconciliation';
const REVISION = 'revision-reconciliation';
const IN_ORDER = [FS, 'identity-invariants', UNIQUE, RENDER, REVISION, 'resolution-health'];
/** Every check that can be computed passes; the other two are the engine's SEATs until U6c. */
const ALL_PASS = 'pass unavailable pass pass pass unavailable';
const ONLY_REVISION_FAILS = 'pass unavailable pass pass fail unavailable';

function path(value: string): WorkspacePath {
  if (!isWorkspacePath(value)) throw new Error(`not a workspace path: ${value}`);
  return value;
}
const noop = () => undefined;
const allMicrotasks = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

const fileNode = (at: string, revision: string): GraphNode => ({
  id: `file:${at}`,
  type: 'FILE',
  data: { path: at, revision_id: revision },
});
const methodNode = (id: string, file: string, revision: string): GraphNode => ({
  id,
  type: 'METHOD',
  data: { file, revision_id: revision },
});
/** In step with DISK, code tier included: 4 nodes, seq 4. */
const P: GraphPayload = {
  seq: 4,
  nodes: [
    { id: 'dir:src', type: 'DIRECTORY', data: { path: 'src' } },
    fileNode('a.ts', 'ra'),
    fileNode('src/b.py', 'rb'),
    methodNode('m', 'src/b.py', 'rb'),
  ],
  edges: [{ source: 'dir:src', target: 'file:src/b.py', type: 'HAS_ENTRY' }],
};
const DISK = { 'a.ts': 'ra', 'src/b.py': 'rb' };
/** P with the node `id` replaced. */
const swap = (id: string, node: GraphNode): GraphPayload => ({
  ...P,
  nodes: P.nodes.map((old) => (old.id === id ? node : old)),
});
const delta = (seq: number, parts: Partial<GraphDelta> = {}): GraphDelta => ({
  seq,
  file: path('a.ts'),
  revision_id: 'r',
  producer: 'filesystem',
  addedNodes: [],
  addedEdges: [],
  removedNodeIds: [],
  ...parts,
});
const ADD_C = delta(5, { addedNodes: [fileNode('c.ts', 'rc')] });

/** The disk: names and digests. A listed name with no digest is gone or unreadable. */
class FakeProbe implements FilesystemProbe {
  readonly asked: string[] = [];
  mostAtOnce = 0;
  private inFlight = 0;
  private readonly digests: ReadonlyMap<string, string>;
  private readonly listing: readonly string[];

  constructor(digests: Readonly<Record<string, string>> = DISK, listing = Object.keys(digests)) {
    this.digests = new Map(Object.entries(digests));
    this.listing = listing;
  }
  listFiles(): Promise<WorkspacePath[]> {
    return Promise.resolve(this.listing.map(path));
  }
  async digest(at: WorkspacePath): Promise<string | undefined> {
    this.asked.push(at);
    this.inFlight += 1;
    this.mostAtOnce = Math.max(this.mostAtOnce, this.inFlight);
    await allMicrotasks();
    this.inFlight -= 1;
    return this.digests.get(at);
  }
}

class FakeTransport implements WebviewTransport {
  readonly cspSource = 'vscode-webview:';
  readonly posted: HostToWebview[] = [];
  onPost: () => void = noop;
  private handler: (message: unknown) => void = noop;

  post(message: HostToWebview): void {
    this.posted.push(message);
    this.onPost();
  }
  onMessage(handler: (message: unknown) => void) {
    this.handler = handler;
    return { dispose: noop };
  }
  send(message: WebviewToHost): void {
    this.handler(message);
  }
  get verifications(): HostToWebview[] {
    return this.posted.filter((message) => message.type === 'verification');
  }
}

const READY: WebviewToHost = { type: 'ready', protocol: 1 };
/** A page that drew `nodes` nodes of a payload it counted the same way. */
const drew = (epoch: number, seq: number, nodes: number, over: Partial<RenderReport> = {}) => {
  const report: RenderReport = {
    payloadNodeCount: nodes,
    renderedNodeCount: nodes,
    renderedEdgeCount: 1,
    duplicateEdges: 0,
    droppedNodeIds: [],
    frameMs: 2,
    ...over,
  };
  return { type: 'render-report', epoch, seq, report } as const;
};

function setUp() {
  /** The host's seq at each onChange. */
  const changes: number[] = [];
  const host = new PanelGraphHost({
    theme: { kind: 'dark', nodeColors: {}, defaultNodeColor: 'x' },
    parse: (message) => message as WebviewToHost, // oxlint-disable-line typescript/no-unsafe-type-assertion -- the fake page sends only WebviewToHost
    opener: { open: () => Promise.resolve() },
    onReveal: noop,
    onChange: () => changes.push(host.seq()),
  });
  const page = new FakeTransport();
  host.attach(page);
  return { host, page, changes };
}
/** `payload` at epoch 1, the page ready, and its render-report in (by default, everything drawn). */
async function showing(payload = P, report = drew(1, payload.seq, payload.nodes.length)) {
  const made = setUp();
  await made.host.onSnapshot(payload, { seq: payload.seq, cause: 'initial' });
  made.page.send(READY);
  made.page.send(report);
  return made;
}

const find = (report: { readonly checks: VerificationReport['checks'] }, id: string) =>
  report.checks.find((check) => check.id === id);
/** One check as `<state> <observed>/<expected> <localisedTo>`. */
function row(report: VerificationReport, id: VerifyCheckId): string {
  const { state, observed, expected, localisedTo = [] } = find(report, id) ?? {};
  return [state, `${String(observed)}/${String(expected)}`, ...localisedTo].join(' ');
}
const states = (report: VerificationReport) => report.checks.map((c) => c.state).join(' ');

/** A probe whose listing waits until `open`: what happens meanwhile happens mid-verify. */
function gated(probe = new FakeProbe()) {
  let open: () => void = noop;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const fs: FilesystemProbe = {
    listFiles: async () => {
      await gate;
      return probe.listFiles();
    },
    digest: (at) => probe.digest(at),
  };
  return { fs, open: () => open() };
}

describe('I-18: all six checks, in enum order, stamped with the seq and epoch of the call', () => {
  it('a graph in step with the disk and its page: everything computable passes', async () => {
    const { host } = await showing();
    const report = await host.verify(new FakeProbe());
    const base = { observed: 0, expected: 0, localisedTo: [], asOfSeq: 4 };
    const unavailable = { ...base, state: 'unavailable' };
    const pass = { ...base, state: 'pass' };
    const identity = 'identity-invariants is computed from U6c (no code tier yet)';
    const health = 'resolution-health is computed from U6c (no ResolveReport yet)';
    const checks = [
      { ...pass, id: FS, observed: 2, expected: 2 },
      { ...unavailable, id: 'identity-invariants', detail: identity },
      { ...pass, id: UNIQUE, observed: 4, expected: 4 },
      { ...pass, id: RENDER, observed: 4, expected: 4 },
      { ...pass, id: REVISION },
      { ...unavailable, id: 'resolution-health', detail: health },
    ];
    expect(report).toStrictEqual({ epoch: 1, seq: 4, state: 'unavailable', checks });
  });

  it('seq -1 is where an indexed graph is until U4, not "no graph": judged like any other', async () => {
    const { host } = await showing({ ...P, seq: -1 });
    const report = await host.verify(new FakeProbe());
    expect(states(report)).toBe(ALL_PASS);
    expect(report.checks.map((check) => check.asOfSeq)).toEqual([-1, -1, -1, -1, -1, -1]);
    const stale = await host.verify(new FakeProbe({ ...DISK, 'a.ts': 'new' }));
    expect(stale).toMatchObject({ seq: -1, epoch: 1, state: 'fail' });
  });

  it('a host that holds nothing judges the empty graph: the files are missing from it', async () => {
    const { host } = setUp();
    const report = await host.verify(new FakeProbe());
    expect(report.checks.map((check) => check.id)).toEqual(IN_ORDER);
    expect(report).toMatchObject({ epoch: 0, seq: -1, state: 'fail' });
    expect(row(report, FS)).toBe('fail 0/2 . src');
    expect(row(report, RENDER)).toBe('unavailable 0/0');
  });

  it('a delta and its render-report mid-verify are not judged: the report lags by its seq', async () => {
    const { host, page } = await showing();
    const { fs, open } = gated();
    const pending = host.verify(fs);
    await host.onDelta(ADD_C, { seq: 5, cause: 'live' });
    page.send(drew(1, 5, 5));
    open();
    const report = await pending;
    expect(states(report)).toBe(ALL_PASS);
    expect(report).toMatchObject({ epoch: 1, seq: 4 });
    expect(report.checks.map((check) => check.asOfSeq)).toEqual([4, 4, 4, 4, 4, 4]);
    expect(page.verifications).toMatchObject([{ epoch: 1, seq: 4 }]);
    expect(host.seq()).toBe(5);
  });

  it('a snapshot mid-verify is not judged either: the epoch lags too', async () => {
    const { host, page } = await showing();
    const { fs, open } = gated();
    const pending = host.verify(fs);
    await host.onSnapshot({ seq: 9, nodes: [], edges: [] }, { seq: 9, cause: 'initial' });
    open();
    const report = await pending;
    expect(states(report)).toBe(ALL_PASS);
    expect(report).toMatchObject({ epoch: 1, seq: 4 });
    expect(page.verifications).toMatchObject([{ epoch: 1, seq: 4 }]);
  });
});

describe('E4: one stale revision fails only revision-reconciliation', () => {
  it('identical counts, ids and edges, and one FILE revision behind the disk', async () => {
    const { host: current } = await showing();
    const { host: behind } = await showing(swap('file:a.ts', fileNode('a.ts', 'old')));
    const good = await current.verify(new FakeProbe());
    const bad = await behind.verify(new FakeProbe());
    expect(states(good)).toBe(ALL_PASS);
    expect(states(bad)).toBe(ONLY_REVISION_FAILS);
    expect(row(bad, REVISION)).toBe('fail 1/0 a.ts');
    expect(bad.checks.toSpliced(4, 1)).toStrictEqual(good.checks.toSpliced(4, 1));
    expect(bad.state).toBe('fail');
  });

  it('one code node behind its own FILE, which is in step with the disk', async () => {
    const { host } = await showing(swap('m', methodNode('m', 'src/b.py', 'before')));
    const report = await host.verify(new FakeProbe());
    expect(states(report)).toBe(ONLY_REVISION_FAILS);
    expect(row(report, REVISION)).toBe('fail 1/0 src/b.py');
  });

  it('a FILE with no revision never matches; a node with none, or with no FILE, is not stale', async () => {
    const nodes: GraphNode[] = [
      { id: 'file:a.ts', type: 'FILE', data: { path: 'a.ts' } },
      fileNode('src/b.py', 'rb'),
      methodNode('on-a', 'a.ts', 'ra'),
      methodNode('orphan', 'gone.ts', 'rx'),
      { id: 'bare', type: 'METHOD', data: { file: 'src/b.py' } },
      { id: 'dataless', type: 'METHOD' },
    ];
    const { host } = await showing({ ...P, nodes });
    expect(row(await host.verify(new FakeProbe()), REVISION)).toBe('fail 1/0 a.ts');
  });
});

describe('the disk checks: the payload against the probe', () => {
  it('a file the graph lacks and a FILE the disk lacks: named by directory, no revision mismatch', async () => {
    const { host } = await showing();
    const report = await host.verify(new FakeProbe({ 'a.ts': 'ra', 'lib/x/new.ts': 'rn' }));
    expect(row(report, FS)).toBe('fail 2/2 lib/x src');
    expect(row(report, REVISION)).toBe('pass 0/0');
  });

  it('a path listed twice is one file, read once (stop-list 84)', async () => {
    const { host } = await showing();
    const probe = new FakeProbe(DISK, ['a.ts', 'src/b.py', 'a.ts', 'src/b.py', 'a.ts']);
    expect(row(await host.verify(probe), FS)).toBe('pass 2/2');
    expect(probe.asked.toSorted()).toEqual(['a.ts', 'src/b.py']);
  });

  it('a listed file with no digest is not admitted: no pass for a FILE nobody could compare', async () => {
    const { host } = await showing();
    const report = await host.verify(new FakeProbe({ 'a.ts': 'ra' }, ['a.ts', 'src/b.py', 'n.ts']));
    expect(row(report, FS)).toBe('fail 2/1 src');
    expect(row(report, REVISION)).toBe('pass 0/0');
  });

  it("a FILE's path is its property, not its id; one with no path is an offender, not dropped", async () => {
    const nodes: GraphNode[] = [
      { ...fileNode('odd:name.ts', 'ro'), id: 'file:odd%3Aname.ts' },
      { id: 'file:nowhere.ts', type: 'FILE', data: { revision_id: 'rn' } },
      { id: 'd', type: 'DIRECTORY', data: { path: 'a.ts', revision_id: 'ra' } },
    ];
    const { host } = await showing({ ...P, nodes });
    const report = await host.verify(new FakeProbe({ 'odd:name.ts': 'ro' }));
    expect(row(report, FS)).toBe('fail 2/1 .');
    expect(row(report, REVISION)).toBe('pass 0/0');
  });

  it('compares every file of a large workspace, at most 32 at a time', async () => {
    const names = Array.from({ length: 100 }, (_, i) => `f${String(i)}.ts`);
    const { host } = await showing({ ...P, nodes: names.map((name) => fileNode(name, 'same')) });
    const onDisk = Object.fromEntries(names.map((name) => [name, 'same']));
    const changed = { 'f0.ts': 'x', 'f31.ts': 'x', 'f32.ts': 'x', 'f99.ts': 'x' };
    const probe = new FakeProbe({ ...onDisk, ...changed });
    const report = await host.verify(probe);
    expect(row(report, REVISION)).toBe('fail 4/0 f0.ts f31.ts f32.ts f99.ts');
    expect(row(report, FS)).toBe('pass 100/100');
    expect(probe.asked).toHaveLength(100);
    expect(probe.mostAtOnce).toBe(32);
  });
});

describe('decision 29: a probe that throws is unavailable with the error, never a pass', () => {
  const gone = new TypeError('remote filesystem gone');
  const said = 'the filesystem probe failed: TypeError: remote filesystem gone';
  const failing: readonly (readonly [string, () => Promise<never>])[] = [
    ['rejects', () => Promise.reject(gone)],
    [
      'throws before it returns a promise',
      () => {
        throw gone;
      },
    ],
  ];

  it.each(failing)('listFiles %s: both disk checks', async (_how, listFiles) => {
    const { host, page } = await showing();
    const report = await host.verify({ listFiles, digest: () => Promise.resolve('ra') });
    expect(states(report)).toBe('unavailable unavailable pass pass unavailable unavailable');
    expect(row(report, FS)).toBe('unavailable 0/0');
    expect([find(report, FS)?.detail, find(report, REVISION)?.detail]).toEqual([said, said]);
    expect(report).toMatchObject({ epoch: 1, seq: 4, state: 'unavailable' });
    expect(page.verifications).toHaveLength(1);
  });

  it.each(failing)('digest %s for one file: revision-reconciliation alone', async (_how, fail) => {
    const { host } = await showing();
    const report = await host.verify({
      listFiles: () => new FakeProbe().listFiles(),
      digest: (at) => (at === 'src/b.py' ? fail() : Promise.resolve('ra')),
    });
    expect(states(report)).toBe('pass unavailable pass pass unavailable unavailable');
    expect(find(report, REVISION)?.detail).toBe(said);
  });
});

describe('I-10, I-19: render-reconciliation', () => {
  it('a duplicate id fails it, and id-uniqueness, whatever the page says it was sent', async () => {
    const twice: GraphPayload = { ...P, nodes: [...P.nodes, fileNode('a.ts', 'ra')] };
    const { host } = await showing(twice, drew(1, 4, 4, { droppedNodeIds: ['file:a.ts'] }));
    const report = await host.verify(new FakeProbe());
    expect(row(report, RENDER)).toBe('fail 4/5 file:a.ts');
    expect(row(report, UNIQUE)).toBe('fail 5/4 file:a.ts');
    expect(row(report, FS)).toBe('pass 2/2');
    const { host: short } = await showing(P, drew(1, 4, 2));
    expect(row(await short.verify(new FakeProbe()), RENDER)).toBe('fail 2/4');
  });

  it('is unavailable with no render-report, and says what to open', async () => {
    const { host } = setUp();
    await host.onSnapshot(P, { seq: 4, cause: 'initial' });
    const report = await host.verify(new FakeProbe());
    expect(row(report, RENDER)).toBe('unavailable 0/0');
    expect(find(report, RENDER)?.detail).toBe(
      'no render-report yet: open the graph panel (CPG: Open Graph)',
    );
  });

  it('is stale when the report lags the payload, and passes once the page has drawn it', async () => {
    const { host, page } = await showing();
    const edge = delta(5, { addedEdges: [{ source: 'm', target: 'm', type: 'CALLS' }] });
    await host.onDelta(edge, { seq: 5, cause: 'live' });
    const lagging = await host.verify(new FakeProbe());
    expect(states(lagging)).toBe('pass unavailable pass stale pass unavailable');
    expect(lagging).toMatchObject({ state: 'stale', seq: 5 });
    page.send(drew(1, 5, 4));
    expect(states(await host.verify(new FakeProbe()))).toBe(ALL_PASS);
  });

  it('a report from before a new graph or a new page is none, even at the same seq -1', async () => {
    const fresh: GraphPayload = { ...P, seq: -1 };
    const { host, page } = await showing(fresh);
    const rows: string[] = [];
    const steps = [
      () => host.onSnapshot(fresh, { seq: -1, cause: 'initial' }),
      async () => page.send(drew(2, -1, 4)),
      async () => page.send(READY),
    ];
    for (const step of steps) {
      await step(); // oxlint-disable-line no-await-in-loop -- one step at a time
      rows.push(row(await host.verify(new FakeProbe()), RENDER)); // oxlint-disable-line no-await-in-loop -- one step at a time
    }
    expect(rows).toEqual(['unavailable 0/0', 'pass 4/4', 'unavailable 0/0']);
  });
});

describe('I-22: every completed verify is pushed as a verification message', () => {
  it('each one, with the report the caller gets', async () => {
    const { host, page } = await showing();
    const first = await host.verify(new FakeProbe());
    const second = await host.verify(new FakeProbe({ ...DISK, 'a.ts': 'new' }));
    const common = { type: 'verification', protocol: 1, epoch: 1, seq: 4 };
    expect(page.posted.slice(2)).toStrictEqual([
      { ...common, report: first },
      { ...common, report: second },
    ]);
    expect([first.state, second.state]).toEqual(['unavailable', 'fail']);
  });

  it('never to a page that is not ready (I-2); a page ready when it completes gets it', async () => {
    const { host, page } = setUp();
    await host.onSnapshot(P, { seq: 4, cause: 'initial' });
    await host.verify(new FakeProbe());
    expect(page.posted).toEqual([]);
    const { fs, open } = gated();
    const pending = host.verify(fs);
    page.send(READY);
    open();
    expect(page.verifications).toEqual([]);
    const report = await pending;
    expect(page.verifications).toMatchObject([{ report }]);
  });

  it('a post that throws is a post-failed fault at the report seq, and verify still resolves', async () => {
    const { host, page } = await showing();
    const { fs, open } = gated();
    const pending = host.verify(fs);
    await host.onDelta(ADD_C, { seq: 5, cause: 'live' });
    page.onPost = () => {
      throw new Error('gone');
    };
    open();
    expect(await pending).toMatchObject({ seq: 4 });
    const error = { name: 'Error', message: 'gone' };
    expect(host.faults()).toStrictEqual([{ kind: 'post-failed', seq: 4, error }]);
  });

  it('a run that finishes after dispose posts nothing and still resolves (decision 36)', async () => {
    const { host, page } = await showing();
    await host.verify(new FakeProbe());
    const { fs, open } = gated();
    const pending = host.verify(fs);
    host.dispose();
    open();
    expect(await pending).toMatchObject({ epoch: 1, seq: 4 });
    expect(page.verifications).toHaveLength(1);
    expect(host.faults()).toEqual([]);
  });
});

describe('decision 36: what asks for a verify', () => {
  it('a merged snapshot or delta and an accepted render-report, once each, after the merge', async () => {
    const { host, page, changes } = setUp();
    await host.onSnapshot(P, { seq: 4, cause: 'initial' });
    await host.onDelta(delta(5), { seq: 5, cause: 'live' });
    page.send(READY);
    expect(changes).toEqual([4, 5]);
    page.send(drew(1, 5, 4));
    await host.onSnapshot({ ...P, seq: 8 }, { seq: 8, cause: 'catch-up' });
    expect(changes).toEqual([4, 5, 5, 8]);
  });

  it('nothing else: what was dropped, refused or only answered, and verify itself', async () => {
    const { host, page, changes } = await showing();
    expect(changes).toHaveLength(2);
    await host.onSnapshot(P, { seq: 4, cause: 'catch-up' });
    await host.onDelta(delta(4), { seq: 4, cause: 'live' });
    await host.onDelta(delta(9), { seq: 9, cause: 'live' });
    const bad = delta(5, { addedNodes: [{ id: 'file:a.ts', type: 'DIRECTORY' }] });
    expect(applyGraphDelta(P, bad).outcome).toBe('malformed');
    await expect(host.onDelta(bad, { seq: 5, cause: 'live' })).rejects.toThrow('malformed');
    page.send(drew(7, 4, 4));
    page.send({ type: 'resync', epoch: 1, seq: 4, reason: 'gap' });
    page.send({ type: 'reveal', nodeId: 'm' });
    page.send(READY);
    host.setTheme({ kind: 'light', nodeColors: {}, defaultNodeColor: 'y' });
    await host.reveal('m');
    await host.verify(new FakeProbe());
    host.dispose();
    expect(changes).toHaveLength(2);
  });
});

// The same workspace through the CLI's verify and the panel's: one verdict, two callers (decision 25).
describe("the engine's own payload, a real directory and a real sha256", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('gives the rows engine.verify gives: in step, after an edit (E4), after an add and a remove', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cpg-host-verify-'));
    roots.push(root);
    await mkdir(join(root, 'src', 'deep'), { recursive: true });
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(root, 'src', 'b.py'), 'b = 2\n');
    await writeFile(join(root, 'src', 'deep', 'notes.txt'), 'no grammar claims this\n');
    const consumers = { inspect: false, store: 'memory', vscode: true } as const;
    const engine = createEngine({ version: '0', consumers });
    const target = { host: 'localhost', port: 6382, graph: 'cpg' };
    const session = await engine.connect(target, { readOnly: false });
    const request = { config: { root }, session, resumeFrom: null };
    await engine.index(request, noop, new AbortController().signal);
    const { host } = await showing(await engine.inspect(session, { root }));
    const probe: FilesystemProbe = {
      listFiles: async () => {
        const walk = await walkWorkspace({ root, languageOf: noop });
        return walk.files.map((file) => file.path);
      },
      digest: async (at) =>
        createHash('sha256')
          .update(await readFile(join(root, at)))
          .digest('hex'),
    };
    /** The panel's report, once every row it shares with the engine's has been compared. */
    const agreed = async () => {
      const panel = await host.verify(probe);
      const cli = await engine.verify(session, { root }, null);
      const differ = IN_ORDER.filter((id) => id !== RENDER).filter(
        (id) => !isDeepStrictEqual(find(panel, id), find(cli, id)),
      );
      expect(differ).toEqual([]);
      return panel;
    };

    const inStep = await agreed();
    expect(states(inStep)).toBe(ALL_PASS);
    expect(row(inStep, FS)).toBe('pass 3/3');
    await writeFile(join(root, 'src', 'b.py'), 'b = 3\n');
    const edited = await agreed();
    expect(states(edited)).toBe(ONLY_REVISION_FAILS);
    expect(row(edited, REVISION)).toBe('fail 1/0 src/b.py');
    await rm(join(root, 'a.ts'));
    await writeFile(join(root, 'src', 'deep', 'new.py'), 'n = 1\n');
    expect(row(await agreed(), FS)).toBe('fail 3/3 . src/deep');
  });
});
