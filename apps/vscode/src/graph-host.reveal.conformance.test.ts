// C-EXT conformance, part 2: reveal (I-15, I-16, I-17; controller decision 37). Expected values come
// from 05-contracts.yaml C-EXT, its port source (21754b4:src/views/graphViewProvider.ts: selection
// `nameRange ?? range`, then the whole range framed) and the doc comments.

import {
  isWorkspacePath,
  makeNodeId,
  type GraphDelta,
  type GraphNode,
  type GraphPayload,
  type HostToWebview,
  type SourceRange,
  type WebviewToHost,
  type WorkspacePath,
} from '@cpg/model';
import { describe, expect, it } from 'vitest';
import type { RevealOutcome, SourceOpener, WebviewTransport } from './contract';
import { PanelGraphHost } from './graph-host';

type Request = Parameters<SourceOpener['open']>[0];

function path(value: string): WorkspacePath {
  if (!isWorkspacePath(value)) throw new Error(`not a workspace path: ${value}`);
  return value;
}
const noop = () => undefined;
const never = new Promise<void>(noop);
const allMicrotasks = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

const RANGE: SourceRange = { startRow: 3, startColumn: 0, endRow: 9, endColumn: 1 };
const NAME: SourceRange = { startRow: 3, startColumn: 9, endRow: 3, endColumn: 12 };
const ELSEWHERE: SourceRange = { startRow: 40, startColumn: 2, endRow: 41, endColumn: 0 };
const A = path('src/a.ts');
// Its id is escaped, so an implementation that cuts the path out of the id opens another file.
const ODD = path('src/odd:%name.ts');
const id = (value: WorkspacePath) => makeNodeId({ form: 'file', path: value });
const method = (nodeId: string, location: unknown): GraphNode => ({
  id: nodeId,
  type: 'METHOD',
  data: { file: 'src/a.ts', location },
});
const file = (nodeId: string, data: Record<string, unknown>): GraphNode => ({
  id: nodeId,
  type: 'FILE',
  data,
});

const NODES: readonly GraphNode[] = [
  { id: 'dir:src', type: 'DIRECTORY', data: { path: 'src', name: 'src', status: 'ready' } },
  file(id(A), { path: A }),
  // A FILE opens whole even when it has a location, and at its own path.
  file(id(ODD), { path: ODD, location: { filePath: A, range: RANGE, nameRange: NAME } }),
  method('named', { filePath: A, range: RANGE, nameRange: NAME }),
  method('anonymous', { filePath: A, range: RANGE }),
  method('bare', undefined),
  method('garbled', { filePath: A, range: { startRow: 9 } }),
  // Round two (review a5): a malformed location is one readNodeLocation refuses, whatever is wrong.
  method('outside', { filePath: '../secret.ts', range: RANGE, nameRange: NAME }),
  method('the root', { filePath: '.', range: RANGE }),
  method('misnamed', { filePath: A, range: RANGE, nameRange: { startRow: 1 } }),
  method('backwards', { filePath: A, range: { ...RANGE, endRow: 2 } }),
  file('file:pathless', {}),
  file('file:rooted', { path: '.' }),
  file('file:climbing', { path: '../secret.ts' }),
];
const P: GraphPayload = { seq: 4, nodes: NODES, edges: [] };

/** Opens at once, unless told otherwise; records what it was asked to open. */
class FakeOpener implements SourceOpener {
  readonly opened: Request[] = [];
  private readonly result: () => Promise<void>;

  constructor(result: () => Promise<void> = () => Promise.resolve()) {
    this.result = result;
  }
  open(request: Request): Promise<void> {
    this.opened.push(request);
    return this.result();
  }
}

class FakeTransport implements WebviewTransport {
  readonly cspSource = 'vscode-webview:';
  readonly posted: string[] = [];
  private handler: (message: unknown) => void = noop;

  post(message: HostToWebview): void {
    this.posted.push(message.type);
  }
  onMessage(handler: (message: unknown) => void) {
    this.handler = handler;
    return { dispose: noop };
  }
  send(message: WebviewToHost & Record<string, unknown>): void {
    this.handler(message);
  }
  reveal(nodeId: string, more: Record<string, unknown> = {}): void {
    this.send({ type: 'reveal', nodeId, ...more });
  }
}

/** A host at `payload` (null: no graph) with a ready page. */
async function showing(
  opener = new FakeOpener(),
  onReveal?: (outcome: RevealOutcome) => void,
  payload: GraphPayload | null = P,
) {
  const outcomes: RevealOutcome[] = [];
  const host = new PanelGraphHost({
    theme: { kind: 'dark', nodeColors: {}, defaultNodeColor: 'x' },
    // As the inspector's parseWebviewMessage does: the message itself, extra fields and all.
    parse: (message) => message as WebviewToHost, // oxlint-disable-line typescript/no-unsafe-type-assertion -- the fake page sends only WebviewToHost
    opener,
    onReveal: onReveal ?? ((outcome) => outcomes.push(outcome)),
    onChange: noop,
  });
  const page = new FakeTransport();
  host.attach(page);
  if (payload !== null) await host.onSnapshot(payload, { seq: payload.seq, cause: 'initial' });
  page.send({ type: 'ready', protocol: 1 });
  return { host, opener, page, outcomes };
}

/** Round two (review c1): concurrent reveals finish in no set order, so by reason, successes last. */
const byKind = (outcomes: readonly RevealOutcome[]) =>
  outcomes.toSorted(
    (a, b) => Number(reasonOf(a) > reasonOf(b)) - Number(reasonOf(a) < reasonOf(b)),
  );
const reasonOf = (outcome: RevealOutcome) => (outcome.ok ? '~' : outcome.reason);

const delta = (seq: number, parts: Partial<GraphDelta>): GraphDelta => ({
  seq,
  file: A,
  revision_id: 'r2',
  producer: 'code',
  addedNodes: [],
  addedEdges: [],
  removedNodeIds: [],
  ...parts,
});

describe('I-15: reveal resolves against the host payload', () => {
  it.each([
    ['nameRange wins over range, which is framed', 'named', A, 'nameRange', [NAME, RANGE]],
    ['no nameRange: selected and framed by its range', 'anonymous', A, 'range', [RANGE, RANGE]],
    ['a FILE opens whole: no selection, no frame', id(A), A, 'whole-file', undefined],
    ['a FILE opens at its own path, not its id', id(ODD), ODD, 'whole-file', undefined],
  ] as const)('%s', async (_what, nodeId, filePath, target, ranges) => {
    const { host, opener } = await showing();
    expect(await host.reveal(nodeId)).toStrictEqual({ ok: true, filePath, target });
    const where = ranges === undefined ? {} : { selection: ranges[0], frame: ranges[1] };
    expect(opener.opened).toStrictEqual([{ filePath, ...where }]);
  });

  it('reads the merged payload, not the snapshot: a moved node, a new one, a removed one', async () => {
    const { host, opener } = await showing();
    const moved = method('named', { filePath: ODD, range: ELSEWHERE });
    const fresh = method('fresh', { filePath: A, range: RANGE });
    const removedNodeIds = ['named', 'anonymous'];
    const change = delta(5, { removedNodeIds, addedNodes: [moved, fresh] });
    await host.onDelta(change, { seq: 5, cause: 'live' });
    expect(await host.reveal('named')).toMatchObject({ ok: true, filePath: ODD, target: 'range' });
    expect(await host.reveal('fresh')).toMatchObject({ ok: true, filePath: A });
    expect(await host.reveal('anonymous')).toMatchObject({ ok: false, reason: 'unknown-node' });
    expect(opener.opened).toStrictEqual([
      { filePath: ODD, selection: ELSEWHERE, frame: ELSEWHERE },
      { filePath: A, selection: RANGE, frame: RANGE },
    ]);
  });

  it('works with no page attached and at seq -1, where an indexed payload is until U4', async () => {
    const { host, opener } = await showing(undefined, undefined, { ...P, seq: -1 });
    host.detach();
    expect(await host.reveal('named')).toMatchObject({ ok: true });
    expect(opener.opened).toHaveLength(1);
  });
});

describe('I-16: every reveal returns a discriminated outcome; none throws or returns void', () => {
  it('unknown-node: no such id, and no graph at all', async () => {
    const { host, opener } = await showing(undefined, undefined, null);
    const missing = { ok: false, reason: 'unknown-node', nodeId: 'named' };
    expect(await host.reveal('named')).toStrictEqual(missing);
    await host.onSnapshot(P, { seq: 4, cause: 'initial' });
    expect(await host.reveal('nope')).toStrictEqual({ ...missing, nodeId: 'nope' });
    expect(opener.opened).toEqual([]);
  });

  it.each([
    'dir:src',
    'bare',
    'garbled',
    'outside',
    'the root',
    'misnamed',
    'backwards',
    'file:pathless',
    'file:rooted',
    'file:climbing',
  ])('no-location: %s, and nothing is opened', async (nodeId) => {
    const { host, opener } = await showing();
    const reason = 'no-location';
    expect(await host.reveal(nodeId)).toStrictEqual({ ok: false, reason, nodeId });
    expect(opener.opened).toEqual([]);
  });

  it.each([
    ['rejects', async () => Promise.reject(new RangeError('gone')), 'RangeError', 'gone'],
    ['throws', () => throwing(new TypeError('no editor')), 'TypeError', 'no editor'],
    ['throws a string', () => throwing('busy'), 'Error', 'busy'],
  ] as const)('open-failed: the opener %s', async (_how, result, name, message) => {
    const { host } = await showing(new FakeOpener(result));
    const failed = { ok: false, reason: 'open-failed', filePath: A, error: { name, message } };
    expect(await host.reveal('named')).toStrictEqual({ ...failed, nodeId: 'named' });
    expect(await host.reveal(id(A))).toStrictEqual({ ...failed, nodeId: id(A) });
    expect(host.faults()).toEqual([]);
  });
});

function throwing(thrown: unknown): never {
  throw thrown;
}

describe('I-17: an inbound reveal is its id and nothing else', () => {
  it('ignores every location-shaped field; the payload is the only source of where', async () => {
    const { page, opener, outcomes, host } = await showing();
    const location = { filePath: 'src/evil.ts', range: ELSEWHERE, nameRange: ELSEWHERE };
    const flat = { path: 'src/evil.ts', selection: ELSEWHERE, frame: ELSEWHERE, ...location };
    page.reveal('named', { location, ...flat });
    page.reveal('bare', { location, ...flat });
    await allMicrotasks();
    expect(opener.opened).toStrictEqual([{ filePath: A, selection: NAME, frame: RANGE }]);
    expect(byKind(outcomes)).toStrictEqual([
      { ok: false, reason: 'no-location', nodeId: 'bare' },
      { ok: true, filePath: A, target: 'nameRange' },
    ]);
    expect(page.posted).toEqual(['theme', 'graph']);
    expect(host.faults()).toEqual([]);
  });
});

describe('decision 37: what becomes of an inbound reveal', () => {
  it('each outcome reaches the callback once; a direct reveal only returns its own', async () => {
    const { page, outcomes, host } = await showing();
    for (const nodeId of [id(A), 'nope', 'bare']) page.reveal(nodeId);
    await host.reveal('named');
    await allMicrotasks();
    expect(byKind(outcomes)).toStrictEqual([
      { ok: false, reason: 'no-location', nodeId: 'bare' },
      { ok: false, reason: 'unknown-node', nodeId: 'nope' },
      { ok: true, filePath: A, target: 'whole-file' },
    ]);
  });

  it('a failed open reaches it too, and one that fails after dispose is not dropped', async () => {
    let fail: (error: Error) => void = noop;
    const pending = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    const { page, outcomes, host } = await showing(new FakeOpener(() => pending));
    page.reveal('named');
    await allMicrotasks();
    expect(outcomes).toEqual([]);
    host.dispose();
    fail(new Error('closed'));
    await allMicrotasks();
    expect(outcomes).toMatchObject([{ ok: false, reason: 'open-failed', filePath: A }]);
  });

  it('an open that never settles holds nothing up', async () => {
    const { page, host, opener } = await showing(new FakeOpener(() => never));
    page.reveal('named');
    await host.onDelta(delta(5, {}), { seq: 5, cause: 'live' });
    expect(opener.opened).toHaveLength(1);
    expect(page.posted).toEqual(['theme', 'graph', 'graph-delta']);
    // Round two (review a6): nor a later reveal.
    page.reveal(id(ODD));
    await allMicrotasks();
    expect(opener.opened).toHaveLength(2);
  });

  const failingCallbacks: readonly (readonly [string, () => unknown])[] = [
    ['throws', () => throwing(new Error('toast failed'))],
    // An async callback is assignable to a void one; its rejection must not go unhandled either.
    ['rejects', async () => Promise.reject(new Error('toast failed'))],
  ];
  it.each(failingCallbacks)(
    'a callback that %s changes nothing in the host',
    async (_how, fail) => {
      let calls = 0;
      const { page, host, opener } = await showing(new FakeOpener(), () => {
        calls += 1;
        return fail();
      });
      page.reveal('named');
      page.reveal(id(A));
      await allMicrotasks();
      expect([calls, opener.opened.length]).toEqual([2, 2]);
      expect(host.faults()).toEqual([]);
      expect(host.snapshot()).toBe(P);
      page.send({ type: 'ready', protocol: 1 });
      expect(page.posted).toEqual(['theme', 'graph', 'theme', 'graph']);
    },
  );
});
