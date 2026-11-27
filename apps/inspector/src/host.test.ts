// The browser inspector's host (C-EXT GraphHost, reduced). It merges what stdin sends into one
// authoritative payload (I-8) and owns the epoch (I-13). It posts nothing before ready (I-2), and
// answers ready and resync with one full snapshot of merged state, never a replay (I-3). It delivers
// edge-only deltas (I-6), records a seq gap as a fault (I-12) and passes render-reports on. A graph
// message's seq is its payload's and a delta's is the delta's (controller decision 18). A fake
// transport records what would cross the WebSocket; fault lines are the stub's documented formats,
// and every merged payload is @cpg/model's applyGraphDelta (the one shared merge). Sprint 26
// (controller decision 84): only the first graph and one that says cause 'initial' bump the epoch;
// any other is a catch-up, taken when its seq is ahead (C-EXT I-12, I-13, the panel's rule).

import {
  applyGraphDelta,
  isWorkspacePath,
  type CheckResult,
  type GraphDelta,
  type GraphPayload,
  type HostToWebview,
  type VerifyCheckId,
  type WorkspacePath,
} from '@cpg/model';
import { describe, expect, it } from 'vitest';
import { InspectorHost, type RenderReportMessage, type WebviewTransport } from './host';

class FakeTransport implements WebviewTransport {
  readonly cspSource = "'self'";
  readonly posted: HostToWebview[] = [];
  disposed = false;
  private handler: ((message: unknown) => void) | undefined;

  post(message: HostToWebview): void {
    this.posted.push(message);
  }
  onMessage(handler: (message: unknown) => void) {
    this.handler = handler;
    return {
      dispose: () => {
        this.disposed = true;
        this.handler = undefined;
      },
    };
  }
  /** A message from the page; false when no live handler would hear it. */
  send(message: unknown): boolean {
    if (this.handler === undefined) return false;
    this.handler(message);
    return true;
  }
}

function workspacePath(value: string): WorkspacePath {
  if (!isWorkspacePath(value)) throw new Error(`not a workspace path: ${value}`);
  return value;
}

// seq 4, so a graph's seq can't be confused with its epoch (1) or a count.
const P: GraphPayload = {
  seq: 4,
  nodes: [
    { id: 'd', type: 'DIRECTORY' },
    { id: 'f', type: 'FILE' },
  ],
  edges: [{ source: 'd', target: 'f', type: 'HAS_ENTRY' }],
};
function delta(seq: number, parts: Partial<GraphDelta> = {}): GraphDelta {
  return {
    seq,
    file: workspacePath('g.ts'),
    revision_id: 'r1',
    producer: 'filesystem',
    addedNodes: [{ id: 'g', type: 'FILE' }],
    addedEdges: [{ source: 'd', target: 'g', type: 'HAS_ENTRY' }],
    removedNodeIds: [],
    ...parts,
  };
}
const edgeOnly = (seq: number): GraphDelta =>
  delta(seq, { addedNodes: [], addedEdges: [{ source: 'f', target: 'd', type: 'IMPORTS' }] });

/** applyGraphDelta's applied payload; a fixture that does not apply is a broken test. */
function merged(payload: GraphPayload, ...deltas: GraphDelta[]): GraphPayload {
  let current = payload;
  for (const next of deltas) {
    const result = applyGraphDelta(current, next);
    if (result.outcome !== 'applied') throw new Error(`fixture delta ${next.seq} must apply`);
    current = result.payload;
  }
  return current;
}

const IDS: readonly VerifyCheckId[] = [
  'filesystem-reconciliation',
  'identity-invariants',
  'id-uniqueness',
  'render-reconciliation',
  'revision-reconciliation',
  'resolution-health',
];
const CHECKS: readonly CheckResult[] = IDS.map((id) => ({
  id,
  state: 'pass',
  observed: 2,
  expected: 2,
  localisedTo: [],
  asOfSeq: 3,
}));
// seq 3: neither the payload's seq nor the epoch.
const VERIFY = { seq: 3, checks: CHECKS, state: 'pass' } as const;
const READY = { type: 'ready', protocol: 1 };

function makeHost(): { host: InspectorHost; reports: RenderReportMessage[]; faults: string[] } {
  const reports: RenderReportMessage[] = [];
  const faults: string[] = [];
  const host = new InspectorHost({
    onRenderReport: (message) => reports.push(message),
    onFault: (line) => faults.push(line),
  });
  return { host, reports, faults };
}

/** A host holding P with `t` attached and ready; `t` has heard graphOf(P). */
function readyHost(t = new FakeTransport()) {
  const made = makeHost();
  made.host.input({ type: 'graph', payload: P });
  made.host.attach(t);
  t.send(READY);
  return { ...made, t };
}

const graphOf = (payload: GraphPayload, epoch = 1): HostToWebview => ({
  type: 'graph',
  protocol: 1,
  epoch,
  seq: payload.seq,
  payload,
});
const verificationOf = (epoch: number, state: 'pass' | 'fail' = 'pass'): HostToWebview => ({
  type: 'verification',
  protocol: 1,
  epoch,
  seq: VERIFY.seq,
  report: { epoch, seq: VERIFY.seq, checks: CHECKS, state },
});

describe('InspectorHost: stdin and ready', () => {
  it('starts at epoch 0 with no payload', () => {
    const { host } = makeHost();
    expect(host.epoch()).toBe(0);
    expect(host.snapshot()).toBeUndefined();
  });

  it('posts nothing before ready, whatever arrives (I-2)', () => {
    const { host } = makeHost();
    const t = new FakeTransport();
    host.attach(t);
    host.input({ type: 'graph', payload: P });
    host.input({ type: 'graph-delta', delta: delta(5) });
    host.input({ type: 'verification', report: VERIFY });
    expect(t.posted).toEqual([]);
  });

  it('answers ready with one graph of the merged payload at its seq, never a replay (I-3, I-8)', () => {
    const { host } = makeHost();
    const t = new FakeTransport();
    host.input({ type: 'graph', payload: P });
    host.input({ type: 'graph-delta', delta: delta(5) });
    host.input({ type: 'graph-delta', delta: edgeOnly(6) });
    host.attach(t);
    t.send(READY);
    const expected = merged(P, delta(5), edgeOnly(6));
    expect(t.posted).toStrictEqual([graphOf(expected)]);
    expect(t.posted[0]).toMatchObject({ seq: 6 });
    expect(host.snapshot()).toStrictEqual(expected);
  });

  // U6a.3-3 (decision 102): the watch now sends code deltas; a save removes and re-adds the file's
  // MODULE in one delta (C-MODEL's home-tier rule), and the host holds one MODULE, in one epoch.
  it('merges producer code deltas: a MODULE added, then a save that removes and re-adds it', () => {
    const { host } = makeHost();
    const t = new FakeTransport();
    const m = {
      id: 'file:g.py:MODULE:$root',
      type: 'MODULE',
      data: { file: 'g.py', revision_id: 'r1' },
    };
    const source = { source: m.id, target: 'g', type: 'SOURCE_FILE' };
    const added = delta(6, { producer: 'code', addedNodes: [m], addedEdges: [source] });
    const saved = delta(7, {
      producer: 'code',
      revision_id: 'r2',
      addedNodes: [{ ...m, data: { file: 'g.py', revision_id: 'r2' } }],
      addedEdges: [source],
      removedNodeIds: [m.id],
    });
    host.input({ type: 'graph', payload: P });
    for (const next of [delta(5), added, saved]) host.input({ type: 'graph-delta', delta: next });
    host.attach(t);
    t.send(READY);
    const expected = merged(P, delta(5), added, saved);
    expect(t.posted).toStrictEqual([graphOf(expected)]);
    expect([host.epoch(), host.snapshot()?.seq]).toEqual([1, 7]);
    expect(host.snapshot()?.nodes.filter((n) => n.id === m.id)).toEqual([
      { ...m, data: { file: 'g.py', revision_id: 'r2' } },
    ]);
    expect(host.snapshot()?.edges.filter((e) => e.type === 'SOURCE_FILE')).toHaveLength(1);
  });

  it('follows the graph with the latest verification only, stamped with its epoch', () => {
    const { host } = makeHost();
    const t = new FakeTransport();
    host.input({ type: 'graph', payload: P });
    host.input({ type: 'verification', report: { ...VERIFY, state: 'fail' } });
    host.input({ type: 'verification', report: VERIFY });
    host.attach(t);
    t.send(READY);
    expect(t.posted).toStrictEqual([graphOf(P), verificationOf(1)]);
  });

  it('answers a ready before any graph with nothing, then posts the graph when it comes', () => {
    const { host } = makeHost();
    const t = new FakeTransport();
    host.attach(t);
    t.send(READY);
    expect(t.posted).toEqual([]);
    host.input({ type: 'graph', payload: P });
    expect(t.posted).toStrictEqual([graphOf(P)]);
  });

  it('answers a ready before any graph with a verification it holds, at epoch 0', () => {
    const { host } = makeHost();
    const t = new FakeTransport();
    host.input({ type: 'verification', report: VERIFY });
    host.attach(t);
    t.send(READY);
    expect(t.posted).toStrictEqual([verificationOf(0)]);
  });

  // Reworked in sprint 26: the cause, not every graph, bumps the epoch (decision 84).
  it("bumps the epoch on a graph that says cause 'initial', replaces the payload and posts the graph alone (I-13)", () => {
    const { host, t } = readyHost();
    host.input({ type: 'verification', report: VERIFY });
    const next: GraphPayload = { seq: 9, nodes: [{ id: 'x', type: 'FILE' }], edges: [] };
    host.input({ type: 'graph', payload: next, cause: 'initial' });
    expect(host.epoch()).toBe(2);
    expect(host.snapshot()).toBe(next);
    expect(t.posted).toStrictEqual([graphOf(P), verificationOf(1), graphOf(next, 2)]);
    // The verification keeps the epoch it arrived in; a resync now re-posts it as it was.
    t.send({ type: 'resync', epoch: 2, seq: 9, reason: 'gap' });
    expect(t.posted.slice(3)).toStrictEqual([graphOf(next, 2), verificationOf(1)]);
  });

  it.each([undefined, 'catch-up'] as const)(
    'a later graph with cause %s is a catch-up: ahead, it replaces the payload in the same epoch',
    (cause) => {
      const { host, t } = readyHost();
      const next: GraphPayload = { seq: 9, nodes: [{ id: 'x', type: 'FILE' }], edges: [] };
      host.input({ type: 'graph', payload: next, ...(cause !== undefined && { cause }) });
      host.input({ type: 'graph-delta', delta: delta(10) });
      expect([host.epoch(), host.snapshot()]).toStrictEqual([1, merged(next, delta(10))]);
      expect(t.posted).toStrictEqual([
        graphOf(P),
        graphOf(next),
        { type: 'graph-delta', protocol: 1, epoch: 1, seq: 10, delta: delta(10) },
      ]);
    },
  );

  // Round two (R10): with no cause too, a later graph is a catch-up.
  it.each([
    [4, 'catch-up'],
    [2, 'catch-up'],
    [4, undefined],
    [2, undefined],
  ] as const)(
    'a catch-up at seq %i (cause %s), not ahead of the payload held, changes nothing',
    (seq, cause) => {
      const { host, t } = readyHost();
      const behind: GraphPayload = { ...P, seq, nodes: [] };
      host.input({ type: 'graph', payload: behind, ...(cause !== undefined && { cause }) });
      expect([host.epoch(), host.snapshot(), t.posted]).toStrictEqual([1, P, [graphOf(P)]]);
    },
  );

  it("the first graph starts epoch 1 whatever its cause, and a later 'initial' starts the next, even behind", () => {
    const { host, faults } = makeHost();
    host.input({ type: 'graph', payload: P, cause: 'catch-up' });
    expect(host.epoch()).toBe(1);
    const behind: GraphPayload = { ...P, seq: 0 };
    host.input({ type: 'graph', payload: behind, cause: 'initial' });
    expect([host.epoch(), host.snapshot(), faults]).toStrictEqual([2, behind, []]);
  });

  it('posts a verification at once to a ready page, built from the four report fields only', () => {
    const { host, t } = readyHost();
    // A stdin report may carry more (the CLI's durationMs, a stale epoch); the host's stamp wins.
    const report = { ...VERIFY, epoch: 9, durationMs: 5 };
    host.input({ type: 'verification', report });
    expect(t.posted).toStrictEqual([graphOf(P), verificationOf(1)]);
  });
});

describe('InspectorHost: deltas', () => {
  it('posts an applied edge-only delta as itself, at its seq, and keeps the merge (I-6, I-8)', () => {
    const { host, t } = readyHost();
    host.input({ type: 'graph-delta', delta: edgeOnly(5) });
    expect(t.posted).toStrictEqual([
      graphOf(P),
      { type: 'graph-delta', protocol: 1, epoch: 1, seq: 5, delta: edgeOnly(5) },
    ]);
    expect(host.snapshot()).toStrictEqual(merged(P, edgeOnly(5)));
  });

  it('merges deltas that arrive before ready into the answer, and posts later ones', () => {
    const { host } = makeHost();
    const t = new FakeTransport();
    host.input({ type: 'graph', payload: P });
    host.attach(t);
    host.input({ type: 'graph-delta', delta: delta(5) });
    t.send(READY);
    host.input({ type: 'graph-delta', delta: edgeOnly(6) });
    expect(t.posted).toStrictEqual([
      graphOf(merged(P, delta(5))),
      { type: 'graph-delta', protocol: 1, epoch: 1, seq: 6, delta: edgeOnly(6) },
    ]);
  });

  // Round two (review a6): a removal drops the node and its edges, and a remove-then-add replaces
  // it, only as the shared merge does it (a private concat keeps both copies).
  it('holds exactly what applyGraphDelta makes of removals and re-adds (I-8)', () => {
    const { host, t } = readyHost();
    const remove = delta(5, { addedNodes: [], addedEdges: [], removedNodeIds: ['f'] });
    const readd = delta(6, {
      removedNodeIds: ['d'],
      addedNodes: [{ id: 'd', type: 'DIRECTORY', name: 'again' }],
      addedEdges: [],
    });
    host.input({ type: 'graph-delta', delta: remove });
    host.input({ type: 'graph-delta', delta: readd });
    const expected = merged(P, remove, readd);
    expect(host.snapshot()).toStrictEqual(expected);
    expect(expected.nodes.map((node) => node.id)).toEqual(['d']);
    t.send({ type: 'resync', epoch: 1, seq: 6, reason: 'render-error' });
    expect(t.posted.at(-1)).toStrictEqual(graphOf(expected));
  });

  it.each([4, 2])('drops an already-applied delta at seq %i silently (at-least-once)', (seq) => {
    const { host, t, faults } = readyHost();
    host.input({ type: 'graph-delta', delta: delta(seq) });
    expect(t.posted).toStrictEqual([graphOf(P)]);
    expect(faults).toEqual([]);
    expect(host.snapshot()).toBe(P);
  });

  it('records a seq gap with both numbers and posts nothing (I-12, C-MODEL I-10)', () => {
    const { host, t, faults } = readyHost();
    host.input({ type: 'graph-delta', delta: delta(7) });
    expect(faults).toEqual(['seq-gap: expected seq 5, got 7']);
    expect(t.posted).toStrictEqual([graphOf(P)]);
    expect(host.snapshot()).toBe(P);
  });

  it('records a malformed delta with its defects and keeps the payload', () => {
    const { host, t, faults } = readyHost();
    const bad = delta(5, { addedNodes: [{ id: 'f', type: 'DIRECTORY' }], addedEdges: [] });
    const result = applyGraphDelta(P, bad);
    if (result.outcome !== 'malformed') throw new Error('fixture delta must be malformed');
    host.input({ type: 'graph-delta', delta: bad });
    expect(faults).toEqual([`malformed delta at seq 5: ${JSON.stringify(result.defects)}`]);
    expect(t.posted).toStrictEqual([graphOf(P)]);
    expect(host.snapshot()).toBe(P);
  });

  it('records a delta before any graph, posts nothing to a ready page, and holds nothing', () => {
    const { host, faults } = makeHost();
    // Round two (review a8): a ready page, so a delta posted anyway would show.
    const t = new FakeTransport();
    host.attach(t);
    t.send(READY);
    host.input({ type: 'graph-delta', delta: delta(5) });
    expect(faults).toEqual(['delta before any graph at seq 5']);
    expect(t.posted).toEqual([]);
    expect(host.snapshot()).toBeUndefined();
    expect(host.epoch()).toBe(0);
  });
});

describe('InspectorHost: messages from the page', () => {
  it.each(['gap', 'stale-epoch', 'render-error'] as const)(
    'answers resync (%s) with a fresh snapshot of merged state, then the verification',
    (reason) => {
      const { host, t } = readyHost();
      host.input({ type: 'graph-delta', delta: delta(5) });
      host.input({ type: 'verification', report: VERIFY });
      const before = t.posted.length;
      t.send({ type: 'resync', epoch: 1, seq: 4, reason });
      expect(t.posted.slice(before)).toStrictEqual([
        graphOf(merged(P, delta(5))),
        verificationOf(1),
      ]);
    },
  );

  // Round two (review a7): the page resyncs with its own epoch and seq (graph-app.ts), which lag the
  // host's after a new graph or before its first; the answer is the same full snapshot.
  it('answers a resync whatever epoch and seq it carries', () => {
    const { host, t } = readyHost();
    const next: GraphPayload = { seq: 9, nodes: [{ id: 'x', type: 'FILE' }], edges: [] };
    // Round two (R2): a new epoch is a graph that says so (decision 84).
    host.input({ type: 'graph', payload: next, cause: 'initial' });
    t.send({ type: 'resync', epoch: 0, seq: -1, reason: 'stale-epoch' });
    t.send({ type: 'resync', epoch: 7, seq: 99, reason: 'gap' });
    expect(t.posted.slice(2)).toStrictEqual([graphOf(next, 2), graphOf(next, 2)]);
  });

  it('does not answer a resync from a page that has not sent ready (I-2)', () => {
    const { host, faults } = makeHost();
    const t = new FakeTransport();
    host.input({ type: 'graph', payload: P });
    host.attach(t);
    t.send({ type: 'resync', epoch: 0, seq: -1, reason: 'stale-epoch' });
    expect(t.posted).toEqual([]);
    expect(faults).toEqual([]);
  });

  it('hands a render-report, whatever its epoch, to onRenderReport and posts nothing', () => {
    const { t, reports, faults } = readyHost();
    const message = {
      type: 'render-report',
      epoch: 7,
      seq: 4,
      report: {
        payloadNodeCount: 2,
        renderedNodeCount: 2,
        renderedEdgeCount: 1,
        duplicateEdges: 0,
        droppedNodeIds: [],
        frameMs: 4,
      },
    };
    t.send(message);
    expect(reports).toStrictEqual([message]);
    expect(faults).toEqual([]);
    expect(t.posted).toStrictEqual([graphOf(P)]);
  });

  it('ignores reveal: the browser has no source to open', () => {
    const { t, reports, faults } = readyHost();
    t.send({ type: 'reveal', nodeId: 'f' });
    expect(t.posted).toStrictEqual([graphOf(P)]);
    expect(reports).toEqual([]);
    expect(faults).toEqual([]);
  });

  it.each([
    { type: 'nope' },
    'ready',
    { type: 'ready' },
    { type: 'ready', protocol: 2 },
    { type: 'render-report', epoch: 1, seq: 4, report: { payloadNodeCount: 'all' } },
  ])('records %j as an unknown-message fault and stays not ready', (message) => {
    const { host, reports, faults } = makeHost();
    const t = new FakeTransport();
    host.input({ type: 'graph', payload: P });
    host.attach(t);
    t.send(message);
    host.input({ type: 'graph-delta', delta: delta(5) });
    expect(faults).toEqual([`unknown-message: ${JSON.stringify(message)}`]);
    expect(t.posted).toEqual([]);
    expect(reports).toEqual([]);
  });

  it('replaces the transport on attach: the old one is disposed, the new one waits for ready', () => {
    const { host, t: first } = readyHost();
    const second = new FakeTransport();
    host.attach(second);
    expect(first.disposed).toBe(true);
    expect(first.send(READY)).toBe(false);
    host.input({ type: 'graph-delta', delta: delta(5) });
    expect(first.posted).toStrictEqual([graphOf(P)]);
    expect(second.posted).toEqual([]);
    second.send(READY);
    expect(second.posted).toStrictEqual([graphOf(merged(P, delta(5)))]);
  });
});
