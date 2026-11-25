// The C-EXT conformance suite for the VS Code panel's host (05-contracts.yaml, C-EXT), one block per
// invariant, written fresh from the contract: the archived reference suite it cites is in no
// reachable commit. Part 1's groups: I-2, I-3, I-4, I-6, I-8, I-11, I-12, I-13, the connection rules
// and the faults. A fake transport records what would cross to the page; every merged payload is
// @cpg/model's applyGraphDelta (the one shared merge). Fixtures are frozen, so a host that mutates
// what it is handed throws.

import {
  applyGraphDelta,
  isWorkspacePath,
  type GraphDelta,
  type GraphPayload,
  type HostToWebview,
  type ThemeSnapshot,
  type WebviewToHost,
  type WorkspacePath,
} from '@cpg/model';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FilesystemProbe, WebviewTransport } from './contract';
import { PanelGraphHost } from './graph-host';

type Fail = (message: HostToWebview) => unknown;

class FakeTransport implements WebviewTransport {
  readonly cspSource = 'vscode-webview:';
  readonly posted: HostToWebview[] = [];
  disposals = 0;
  private handler: ((message: unknown) => void) | undefined;
  private readonly onPost: Fail;

  constructor(onPost: Fail = () => undefined) {
    this.onPost = onPost;
  }
  post(message: HostToWebview): unknown {
    this.posted.push(message);
    return this.onPost(message);
  }
  onMessage(handler: (message: unknown) => void) {
    this.handler = handler;
    return {
      dispose: () => {
        this.disposals += 1;
        if (this.handler === handler) this.handler = undefined;
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

function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) frozen(inner);
  }
  return value;
}

// seq 4, so a graph's seq can't be confused with its epoch (1) or a count.
const P: GraphPayload = frozen({
  seq: 4,
  nodes: [
    { id: 'd', type: 'DIRECTORY' },
    { id: 'f', type: 'FILE' },
  ],
  edges: [{ source: 'd', target: 'f', type: 'HAS_ENTRY' }],
});
const Q: GraphPayload = frozen({ seq: 2, nodes: [{ id: 'x', type: 'FILE' }], edges: [] });
const EMPTY: GraphPayload = { seq: -1, nodes: [], edges: [] };

function delta(seq: number, parts: Partial<GraphDelta> = {}): GraphDelta {
  return frozen({
    seq,
    file: workspacePath('g.ts'),
    revision_id: 'r1',
    producer: 'filesystem' as const,
    addedNodes: [{ id: `g${seq}`, type: 'FILE' }],
    addedEdges: [{ source: 'd', target: `g${seq}`, type: 'HAS_ENTRY' }],
    removedNodeIds: [],
    ...parts,
  });
}
const edgeOnly = (seq: number): GraphDelta =>
  delta(seq, { addedNodes: [], addedEdges: [{ source: 'f', target: 'd', type: 'IMPORTS' }] });

const fileOf = (data: Record<string, unknown>) => ({ id: 'f', type: 'FILE', data });

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

const LIGHT: ThemeSnapshot = frozen({
  kind: 'light',
  nodeColors: { FILE: 'a' },
  defaultNodeColor: 'b',
});
const DARK: ThemeSnapshot = frozen({
  kind: 'dark',
  nodeColors: { FILE: 'c' },
  defaultNodeColor: 'd',
});

const themeOf = (epoch: number, theme = LIGHT): HostToWebview => ({
  type: 'theme',
  protocol: 1,
  epoch,
  theme,
});
const graphOf = (payload: GraphPayload, epoch = 1): HostToWebview => ({
  type: 'graph',
  protocol: 1,
  epoch,
  seq: payload.seq,
  payload,
});
const deltaOf = (sent: GraphDelta, epoch = 1): HostToWebview => ({
  type: 'graph-delta',
  protocol: 1,
  epoch,
  seq: sent.seq,
  delta: sent,
});

const initial = (payload: GraphPayload) => ({ seq: payload.seq, cause: 'initial' as const });
const catchUp = (payload: GraphPayload) => ({ seq: payload.seq, cause: 'catch-up' as const });
const live = (sent: GraphDelta) => ({ seq: sent.seq, cause: 'live' as const });

// parse stands in for the inspector's parseWebviewMessage (sprint 16): it accepts exactly the
// messages registered here, and may return a different message than it was handed.
const accepted = new Map<unknown, WebviewToHost>();
const known = (message: WebviewToHost, raw: unknown = message): unknown => {
  accepted.set(raw, message);
  return raw;
};
const READY = { type: 'ready', protocol: 1 } as const;
const resync = (epoch: number, seq: number, reason: 'gap' | 'stale-epoch' | 'render-error') =>
  known({ type: 'resync', epoch, seq, reason });
const report = (epoch: number, seq: number) =>
  ({
    type: 'render-report',
    epoch,
    seq,
    report: {
      payloadNodeCount: 2,
      renderedNodeCount: 2,
      renderedEdgeCount: 1,
      duplicateEdges: 0,
      droppedNodeIds: [],
      frameMs: 3,
    },
  }) as const;

beforeEach(() => {
  accepted.clear();
  known(READY);
});

const makeHost = () =>
  new PanelGraphHost({ theme: LIGHT, parse: (message) => accepted.get(message) });

/** A host holding P at epoch 1 with `t` ready; `t` has heard [theme, graph of P]. */
async function readyHost(t = new FakeTransport()) {
  const host = makeHost();
  await host.onSnapshot(P, initial(P));
  host.attach(t);
  t.send(READY);
  return { host, t, heard: () => t.posted.slice(2) };
}

/** Settles when every microtask has run: a promise still pending then is waiting on something else. */
const allMicrotasks = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

const typeOf = (message: HostToWebview | undefined) => message?.type;

describe('a host nothing has been delivered to', () => {
  it('holds the empty payload at seq -1 and epoch 0, with no faults', () => {
    const host = makeHost();
    expect(host.snapshot()).toStrictEqual(EMPTY);
    expect(host.seq()).toBe(-1);
    expect(host.epoch()).toBe(0);
    expect(host.faults()).toEqual([]);
    expect(host.renderReport()).toBeUndefined();
  });

  it('applies a first delta at seq 0 onto the empty payload, at epoch 0 (I-8)', async () => {
    const host = makeHost();
    await host.onDelta(delta(0), live(delta(0)));
    expect(host.snapshot()).toStrictEqual(merged(EMPTY, delta(0)));
    expect(host.seq()).toBe(0);
    expect(host.epoch()).toBe(0);
    expect(host.faults()).toEqual([]);
  });

  it('records a delta that is not the first one as a seq gap and holds nothing (I-12)', async () => {
    const host = makeHost();
    await host.onDelta(delta(5), live(delta(5)));
    expect(host.faults()).toStrictEqual([{ kind: 'seq-gap', expected: 0, received: 5 }]);
    expect(host.snapshot()).toStrictEqual(EMPTY);
  });
});

describe('I-2: nothing is posted before ready', () => {
  it('posts nothing whatever arrives, and still merges it', async () => {
    const host = makeHost();
    const t = new FakeTransport();
    host.attach(t);
    await host.onSnapshot(P, initial(P));
    await host.onDelta(delta(5), live(delta(5)));
    host.setTheme(DARK);
    expect(t.posted).toEqual([]);
    expect(host.snapshot()).toStrictEqual(merged(P, delta(5)));
  });

  it.each(['gap', 'stale-epoch', 'render-error'] as const)(
    'does not answer a resync (%s) from a page that has not sent ready',
    async (reason) => {
      const host = makeHost();
      const t = new FakeTransport();
      await host.onSnapshot(P, initial(P));
      host.attach(t);
      expect(t.send(resync(1, 4, reason))).toBe(true);
      expect(t.posted).toEqual([]);
      expect(host.faults()).toEqual([]);
    },
  );

  it('posts nothing when no page was ever attached', async () => {
    const host = makeHost();
    await host.onSnapshot(P, initial(P));
    await host.onDelta(delta(5), live(delta(5)));
    host.setTheme(DARK);
    expect(host.faults()).toEqual([]);
    expect(host.seq()).toBe(5);
  });
});

describe('I-3: ready is answered with exactly one full graph of merged state', () => {
  it('sends the merge of the snapshot and its deltas, never a replay', async () => {
    const host = makeHost();
    const t = new FakeTransport();
    await host.onSnapshot(P, initial(P));
    await host.onDelta(delta(5), live(delta(5)));
    await host.onDelta(edgeOnly(6), live(edgeOnly(6)));
    host.attach(t);
    t.send(READY);
    const expected = merged(P, delta(5), edgeOnly(6));
    expect(t.posted).toStrictEqual([themeOf(1), graphOf(expected)]);
    expect(t.posted[1]).toMatchObject({ seq: 6 });
  });

  it('sends the theme alone while there is no graph, then one graph when it arrives', async () => {
    const host = makeHost();
    const t = new FakeTransport();
    host.attach(t);
    t.send(READY);
    expect(t.posted).toStrictEqual([themeOf(0)]);
    await host.onSnapshot(P, initial(P));
    expect(t.posted).toStrictEqual([themeOf(0), graphOf(P)]);
  });

  it('pays a page that was ready first with the whole graph, not a first delta', async () => {
    const host = makeHost();
    const t = new FakeTransport();
    host.attach(t);
    t.send(READY);
    await host.onDelta(delta(0), live(delta(0)));
    await host.onDelta(delta(1), live(delta(1)));
    const first = merged(EMPTY, delta(0));
    expect(t.posted).toStrictEqual([themeOf(0), graphOf(first, 0), deltaOf(delta(1), 0)]);
  });

  it('answers a resync with one graph of merged state and no theme, whatever it carries', async () => {
    const { host, t, heard } = await readyHost();
    await host.onDelta(delta(5), live(delta(5)));
    t.send(resync(1, 4, 'gap'));
    t.send(resync(0, -1, 'stale-epoch'));
    t.send(resync(7, 99, 'render-error'));
    const now = graphOf(merged(P, delta(5)));
    expect(heard()).toStrictEqual([deltaOf(delta(5)), now, now, now]);
    expect(host.faults()).toEqual([]);
  });

  it('answers a resync with nothing while there is no graph', () => {
    const host = makeHost();
    const t = new FakeTransport();
    host.attach(t);
    t.send(READY);
    t.send(resync(0, -1, 'stale-epoch'));
    expect(t.posted).toStrictEqual([themeOf(0)]);
    expect(host.faults()).toEqual([]);
  });
});

describe('I-4: theme precedes the first graph, and a theme change is the theme alone', () => {
  it('posts the theme first on every connection, the latest one', async () => {
    const { host, t } = await readyHost();
    expect(t.posted).toStrictEqual([themeOf(1), graphOf(P)]);
    host.setTheme(DARK);
    const second = new FakeTransport();
    host.attach(second);
    second.send(READY);
    expect(second.posted).toStrictEqual([themeOf(1, DARK), graphOf(P)]);
  });

  it('re-posts the theme alone, at the current epoch, to a ready page', async () => {
    const { host, heard } = await readyHost();
    await host.onSnapshot(Q, initial(Q));
    host.setTheme(DARK);
    expect(heard()).toStrictEqual([graphOf(Q, 2), themeOf(2, DARK)]);
  });

  // Post-implementation: closes sabotage survivor "setTheme needs a graph".
  it('re-posts the theme to a page that is ready before any graph', () => {
    const host = makeHost();
    const t = new FakeTransport();
    host.attach(t);
    t.send(READY);
    host.setTheme(DARK);
    expect(t.posted).toStrictEqual([themeOf(0), themeOf(0, DARK)]);
  });
});

describe('I-6: an edge-only delta is delivered', () => {
  it('posts it as itself at its seq and keeps the merge', async () => {
    const { host, heard } = await readyHost();
    await host.onDelta(edgeOnly(5), live(edgeOnly(5)));
    expect(heard()).toStrictEqual([deltaOf(edgeOnly(5))]);
    expect(host.snapshot()).toStrictEqual(merged(P, edgeOnly(5)));
  });

  it.each(['live', 'cascade', 'bulk'] as const)('whatever its cause (%s)', async (cause) => {
    const { host, heard } = await readyHost();
    await host.onDelta(edgeOnly(5), { seq: 5, cause });
    expect(heard()).toStrictEqual([deltaOf(edgeOnly(5))]);
  });
});

describe('I-8: the merged payload is applyGraphDelta(payload, delta)', () => {
  it('holds and re-sends exactly what the shared merge makes of removals and re-adds', async () => {
    const { host, t, heard } = await readyHost();
    const remove = delta(5, { addedNodes: [], addedEdges: [], removedNodeIds: ['f'] });
    const readd = delta(6, {
      removedNodeIds: ['d'],
      addedNodes: [{ id: 'd', type: 'DIRECTORY', name: 'again' }],
      addedEdges: [],
    });
    const rename = delta(7, { addedNodes: [{ id: 'd', type: 'DIRECTORY', name: 'renamed' }] });
    for (const next of [remove, readd, rename]) await host.onDelta(next, live(next));
    const expected = merged(P, remove, readd, rename);
    expect(host.snapshot()).toStrictEqual(expected);
    expect(expected.nodes.map((node) => node.id)).toEqual(['d']);
    t.send(resync(1, 7, 'gap'));
    expect(heard()).toStrictEqual([
      deltaOf(remove),
      deltaOf(readd),
      deltaOf(rename),
      graphOf(expected),
    ]);
  });
});

describe('I-8, round two (review a1): the merge is by owner, not a whole-node replace', () => {
  it("keeps the code tier's key when the filesystem tier re-adds a FILE, and the reverse", async () => {
    const { host, heard } = await readyHost();
    const code = delta(5, {
      producer: 'code',
      addedNodes: [fileOf({ interface_hash: 'i1' })],
      addedEdges: [],
    });
    const disk = delta(6, { addedNodes: [fileOf({ content_hash: 'c2' })], addedEdges: [] });
    const again = delta(7, {
      producer: 'code',
      addedNodes: [fileOf({ interface_hash: 'i3' })],
      addedEdges: [],
    });
    for (const next of [code, disk, again]) await host.onDelta(next, live(next));
    const file = host.snapshot().nodes.find((node) => node.id === 'f');
    expect(file?.data).toStrictEqual({ content_hash: 'c2', interface_hash: 'i3' });
    expect(host.snapshot()).toStrictEqual(merged(P, code, disk, again));
    expect(heard()).toStrictEqual([deltaOf(code), deltaOf(disk), deltaOf(again)]);
  });

  it('rejects a same-tier re-add of a METHOD without its removal', async () => {
    const { host, heard } = await readyHost();
    const method = { id: 'm', type: 'METHOD' };
    const first = delta(5, { producer: 'code', addedNodes: [method], addedEdges: [] });
    const twice = delta(6, { producer: 'code', addedNodes: [method], addedEdges: [] });
    await host.onDelta(first, live(first));
    await expect(host.onDelta(twice, live(twice))).rejects.toThrow(
      'malformed delta at seq 6: readd-without-removal m',
    );
    expect(heard()).toStrictEqual([deltaOf(first)]);
    expect(host.snapshot()).toStrictEqual(merged(P, first));
  });
});

describe('I-11: onDelta resolves on merge and never awaits the webview', () => {
  it('resolves with the payload updated while a post never settles', async () => {
    const stuck: unknown = new Promise(() => undefined);
    const { host } = await readyHost(new FakeTransport(() => stuck));
    let resolved = false;
    void host.onDelta(delta(5), live(delta(5))).then(() => {
      resolved = true;
    });
    await allMicrotasks();
    expect(resolved).toBe(true);
    expect(host.seq()).toBe(5);
    let snapped = false;
    void host.onSnapshot(Q, initial(Q)).then(() => {
      snapped = true;
    });
    await allMicrotasks();
    expect(snapped).toBe(true);
    expect(host.snapshot()).toStrictEqual(Q);
  });
});

describe('I-12: seq strictly increases per epoch, and a gap is a recorded fault', () => {
  it('records a gap with both numbers, posts nothing, keeps the payload, and resolves', async () => {
    const { host, heard } = await readyHost();
    await host.onDelta(delta(7), live(delta(7)));
    expect(host.faults()).toStrictEqual([{ kind: 'seq-gap', expected: 5, received: 7 }]);
    expect(heard()).toEqual([]);
    expect(host.snapshot()).toBe(P);
  });

  it('takes the missing delta after a gap', async () => {
    const { host, heard } = await readyHost();
    await host.onDelta(delta(6), live(delta(6)));
    await host.onDelta(delta(5), live(delta(5)));
    await host.onDelta(delta(6), live(delta(6)));
    expect(heard()).toStrictEqual([deltaOf(delta(5)), deltaOf(delta(6))]);
    expect(host.seq()).toBe(6);
    expect(host.faults()).toHaveLength(1);
  });

  it.each([4, 2])('drops a redelivered delta at seq %i silently', async (seq) => {
    const { host, heard } = await readyHost();
    await host.onDelta(delta(seq), live(delta(seq)));
    expect(heard()).toEqual([]);
    expect(host.faults()).toEqual([]);
    expect(host.snapshot()).toBe(P);
  });

  it('posts every applied delta once, in order, at its own seq', async () => {
    const { host, heard } = await readyHost();
    for (const next of [delta(5), delta(5), edgeOnly(6)]) await host.onDelta(next, live(next));
    expect(heard()).toStrictEqual([deltaOf(delta(5)), deltaOf(edgeOnly(6))]);
  });

  it('restarts the seq at a new epoch and gates on the new payload', async () => {
    const { host, heard } = await readyHost();
    await host.onSnapshot(Q, initial(Q));
    await host.onDelta(delta(3), live(delta(3)));
    await host.onDelta(delta(5), live(delta(5)));
    expect(heard()).toStrictEqual([graphOf(Q, 2), deltaOf(delta(3), 2)]);
    expect(host.faults()).toStrictEqual([{ kind: 'seq-gap', expected: 4, received: 5 }]);
  });

  it('rejects a malformed delta, naming it, and keeps the payload', async () => {
    const { host, heard } = await readyHost();
    const bad = delta(5, {
      addedNodes: [
        { id: 'f', type: 'DIRECTORY' },
        { id: 'd', type: 'FILE' },
      ],
      addedEdges: [],
    });
    const result = applyGraphDelta(P, bad);
    if (result.outcome !== 'malformed') throw new Error('fixture delta must be malformed');
    await expect(host.onDelta(bad, live(bad))).rejects.toThrow(
      'malformed delta at seq 5: type-conflict f, type-conflict d',
    );
    expect(heard()).toEqual([]);
    expect(host.snapshot()).toBe(P);
    expect(host.seq()).toBe(4);
    expect(host.faults()).toEqual([]);
  });
});

describe('I-13: cause initial replaces the payload and bumps the epoch; catch-up does not bump', () => {
  it('bumps the epoch on every initial snapshot and holds its payload', async () => {
    const { host, heard } = await readyHost();
    expect(host.epoch()).toBe(1);
    await host.onSnapshot(Q, initial(Q));
    expect(host.epoch()).toBe(2);
    expect(host.snapshot()).toBe(Q);
    expect(host.seq()).toBe(2);
    await host.onSnapshot(Q, initial(Q));
    expect(host.epoch()).toBe(3);
    expect(heard()).toStrictEqual([graphOf(Q, 2), graphOf(Q, 3)]);
  });

  it('takes a catch-up ahead of the payload held at the same epoch, and that is no gap', async () => {
    const { host, heard } = await readyHost();
    const ahead: GraphPayload = { ...Q, seq: 9 };
    await host.onSnapshot(ahead, catchUp(ahead));
    await host.onDelta(delta(10), live(delta(10)));
    expect(host.epoch()).toBe(1);
    expect(heard()).toStrictEqual([graphOf(ahead), deltaOf(delta(10))]);
    expect(host.faults()).toEqual([]);
  });

  it.each([4, 3])('changes nothing for a catch-up at seq %i, not ahead of seq 4', async (seq) => {
    const { host, heard } = await readyHost();
    const behind: GraphPayload = { ...Q, seq };
    await host.onSnapshot(behind, catchUp(behind));
    expect(host.epoch()).toBe(1);
    expect(host.snapshot()).toBe(P);
    expect(heard()).toEqual([]);
    expect(host.faults()).toEqual([]);
  });

  it('takes a first snapshot that is a catch-up, at epoch 0, whatever its seq', async () => {
    const host = makeHost();
    const t = new FakeTransport();
    host.attach(t);
    t.send(READY);
    const fresh: GraphPayload = { ...Q, seq: -1 };
    await host.onSnapshot(fresh, catchUp(fresh));
    expect(host.epoch()).toBe(0);
    expect(host.snapshot()).toBe(fresh);
    expect(t.posted).toStrictEqual([themeOf(0), graphOf(fresh, 0)]);
  });

  // Round two (review a2): an indexed payload is at seq -1 until deltas exist, the same seq as a
  // host that holds nothing, so "is there a graph" is not a question about seq.
  it.each([
    ['initial' as const, 1],
    ['catch-up' as const, 0],
  ])('a first %s snapshot at seq -1 is a graph like any other', async (cause, epoch) => {
    const host = makeHost();
    const fresh: GraphPayload = { ...Q, seq: -1 };
    const stale: GraphPayload = { ...P, seq: -1 };
    await host.onSnapshot(fresh, { seq: -1, cause });
    const t = new FakeTransport();
    host.attach(t);
    t.send(READY);
    t.send(resync(epoch, -1, 'render-error'));
    await host.onSnapshot(stale, catchUp(stale));
    await host.onDelta(delta(0), live(delta(0)));
    expect(t.posted).toStrictEqual([
      themeOf(epoch),
      graphOf(fresh, epoch),
      graphOf(fresh, epoch),
      deltaOf(delta(0), epoch),
    ]);
    expect(host.snapshot()).toStrictEqual(merged(fresh, delta(0)));
  });

  // Round two (review b2).
  it('a first delta before any page is a graph too: ready, resync and catch-up see it', async () => {
    const host = makeHost();
    await host.onDelta(delta(0), live(delta(0)));
    const t = new FakeTransport();
    host.attach(t);
    t.send(READY);
    t.send(resync(0, 0, 'gap'));
    const level: GraphPayload = { ...Q, seq: 0 };
    await host.onSnapshot(level, catchUp(level));
    const first = graphOf(merged(EMPTY, delta(0)), 0);
    expect(t.posted).toStrictEqual([themeOf(0), first, first]);
    expect(host.snapshot()).toStrictEqual(merged(EMPTY, delta(0)));
  });
});

describe('one page at a time; a reconnect is always a full snapshot', () => {
  it('attach replaces: the old page is unsubscribed, the new one waits for ready', async () => {
    const { host, t: first, heard } = await readyHost();
    const second = new FakeTransport();
    host.attach(second);
    expect(first.disposals).toBe(1);
    expect(first.send(READY)).toBe(false);
    await host.onDelta(delta(5), live(delta(5)));
    expect(heard()).toEqual([]);
    expect(second.posted).toEqual([]);
    second.send(READY);
    expect(second.posted).toStrictEqual([themeOf(1), graphOf(merged(P, delta(5)))]);
  });

  it('detach unsubscribes and posts nothing more, while the graph keeps merging', async () => {
    const { host, t, heard } = await readyHost();
    host.detach();
    expect(t.disposals).toBe(1);
    await host.onDelta(delta(5), live(delta(5)));
    host.setTheme(DARK);
    expect(heard()).toEqual([]);
    const next = new FakeTransport();
    host.attach(next);
    next.send(READY);
    expect(next.posted).toStrictEqual([themeOf(1, DARK), graphOf(merged(P, delta(5)))]);
  });

  it('a second ready on one connection is a reloaded page: theme and one graph again', async () => {
    const { host, t, heard } = await readyHost();
    await host.onDelta(delta(5), live(delta(5)));
    t.send(READY);
    expect(heard()).toStrictEqual([deltaOf(delta(5)), themeOf(1), graphOf(merged(P, delta(5)))]);
  });

  it('dispose unsubscribes, posts nothing more and can be called again', async () => {
    const { host, t, heard } = await readyHost();
    host.dispose();
    host.dispose();
    expect(t.disposals).toBe(1);
    await host.onDelta(delta(5), live(delta(5)));
    expect(heard()).toEqual([]);
  });
});

describe('messages from the page', () => {
  it('keeps the latest render-report at its epoch and posts nothing for it', async () => {
    const { host, t, heard } = await readyHost();
    t.send(known(report(1, 4)));
    expect(host.renderReport()).toStrictEqual(report(1, 4));
    await host.onDelta(delta(5), live(delta(5)));
    expect(host.renderReport()).toStrictEqual(report(1, 4));
    t.send(known(report(1, 5)));
    expect(host.renderReport()).toStrictEqual(report(1, 5));
    expect(heard()).toStrictEqual([deltaOf(delta(5))]);
    expect(host.faults()).toEqual([]);
  });

  it.each([0, 2])(
    'records a render-report at epoch %i as bad-epoch and drops it',
    async (epoch) => {
      const { host, t } = await readyHost();
      t.send(known(report(1, 4)));
      t.send(known(report(epoch, 4)));
      expect(host.faults()).toStrictEqual([{ kind: 'bad-epoch', expected: 1, received: epoch }]);
      expect(host.renderReport()).toStrictEqual(report(1, 4));
    },
  );

  it('forgets the render-report when the page or the graph it described is gone', async () => {
    const { host, t } = await readyHost();
    const held: boolean[] = [];
    const check = async (act: () => unknown) => {
      t.send(READY);
      t.send(known(report(host.epoch(), 4)));
      held.push(host.renderReport() !== undefined);
      await act();
      held.push(host.renderReport() !== undefined);
    };
    await check(() => t.send(READY));
    await check(() => host.onSnapshot(P, initial(P)));
    await check(() => host.attach(t));
    await check(() => host.detach());
    host.attach(t);
    await check(() => host.dispose());
    const pairs = Array.from({ length: held.length / 2 }, (_, i) => held.slice(2 * i, 2 * i + 2));
    expect(pairs).toEqual([
      [true, false],
      [true, false],
      [true, false],
      [true, false],
      [true, false],
    ]);
  });

  // Round two (review b1): a catch-up, taken or not, leaves the page where it was; its report then
  // lags, which is verify's to judge (I-19), not the host's to drop.
  it.each([9, 4, 3])('keeps the render-report across a catch-up at seq %i', async (seq) => {
    const { host, t } = await readyHost();
    t.send(known(report(1, 4)));
    const next: GraphPayload = { ...Q, seq };
    await host.onSnapshot(next, catchUp(next));
    expect(host.renderReport()).toStrictEqual(report(1, 4));
  });

  it('acts on what parse returns, never on the raw message', async () => {
    const host = makeHost();
    const t = new FakeTransport();
    await host.onSnapshot(P, initial(P));
    host.attach(t);
    const lookalike = { type: 'ready', protocol: 1, extra: true };
    t.send(lookalike);
    expect(t.posted).toEqual([]);
    expect(host.faults()).toStrictEqual([{ kind: 'unknown-message', received: lookalike }]);
    t.send(known(READY, 'the page is up'));
    expect(t.posted).toStrictEqual([themeOf(1), graphOf(P)]);
    t.send(known(report(1, 4), 'a report'));
    expect(host.renderReport()).toStrictEqual(report(1, 4));
  });

  it.each([{ type: 'nope' }, 'ready', undefined])(
    'records %j, which parse refuses, as an unknown-message fault',
    async (message) => {
      const { host, t, heard } = await readyHost();
      t.send(message);
      expect(host.faults()).toStrictEqual([{ kind: 'unknown-message', received: message }]);
      expect(heard()).toEqual([]);
    },
  );

  it('records a ready at another protocol as an unknown-message fault and stays not ready', async () => {
    const host = makeHost();
    const t = new FakeTransport();
    await host.onSnapshot(P, initial(P));
    host.attach(t);
    // Round two (review a3): `received` is the message as received, not what parse made of it.
    t.send(known({ type: 'ready', protocol: 2 }, 'a newer page'));
    await host.onDelta(delta(5), live(delta(5)));
    expect(t.posted).toEqual([]);
    expect(host.faults()).toStrictEqual([{ kind: 'unknown-message', received: 'a newer page' }]);
  });

  it('does nothing with a reveal yet (SEAT until part 2)', async () => {
    const { host, t, heard } = await readyHost();
    t.send(known({ type: 'reveal', nodeId: 'f' }));
    expect(heard()).toEqual([]);
    expect(host.faults()).toEqual([]);
  });
});

describe('post-failed: a post that throws is recorded and stops nothing', () => {
  const broken = new TypeError('webview gone');
  const gone = { name: 'TypeError', message: 'webview gone' };

  it('records it with the message seq (a theme: the host seq) and goes on posting', async () => {
    const throwing = new FakeTransport(() => {
      throw broken;
    });
    const { host, t } = await readyHost(throwing);
    expect(t.posted.map(typeOf)).toEqual(['theme', 'graph']);
    await host.onDelta(delta(5), live(delta(5)));
    const later: GraphPayload = { ...Q, seq: 8 };
    await host.onSnapshot(later, initial(later));
    host.setTheme(DARK);
    expect(host.faults()).toStrictEqual([
      { kind: 'post-failed', seq: 4, error: gone },
      { kind: 'post-failed', seq: 4, error: gone },
      { kind: 'post-failed', seq: 5, error: gone },
      { kind: 'post-failed', seq: 8, error: gone },
      { kind: 'post-failed', seq: 8, error: gone },
    ]);
    expect(host.snapshot()).toBe(later);
  });

  it('records a thrown non-Error as its string', async () => {
    const throwing = new FakeTransport((message) => {
      if (message.type === 'graph-delta') throw 'no listener';
      return undefined;
    });
    const { host } = await readyHost(throwing);
    await host.onDelta(delta(5), live(delta(5)));
    expect(host.faults()).toStrictEqual([
      { kind: 'post-failed', seq: 5, error: { name: 'Error', message: 'no listener' } },
    ]);
  });

  it('lists the faults of every kind, oldest first', async () => {
    const throwing = new FakeTransport((message) => {
      if (message.type === 'graph-delta') throw broken;
      return undefined;
    });
    const { host, t } = await readyHost(throwing);
    t.send(known(report(9, 4)));
    await host.onDelta(delta(8), live(delta(8)));
    t.send('noise');
    await host.onDelta(delta(5), live(delta(5)));
    expect(host.faults().map((fault) => fault.kind)).toEqual([
      'bad-epoch',
      'seq-gap',
      'unknown-message',
      'post-failed',
    ]);
  });
});

describe('SEAT until part 2', () => {
  const probe: FilesystemProbe = {
    listFiles: () => Promise.resolve([]),
    digest: () => Promise.resolve(undefined),
  };

  it('reveal and verify reject, naming themselves SEAT', async () => {
    const { host } = await readyHost();
    await expect(host.reveal('f')).rejects.toThrow(/^SEAT: PanelGraphHost\.reveal/);
    await expect(host.verify(probe)).rejects.toThrow(/^SEAT: PanelGraphHost\.verify/);
  });
});
