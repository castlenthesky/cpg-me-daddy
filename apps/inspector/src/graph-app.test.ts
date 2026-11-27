// The page's entry logic (port of 21754b4:src/webview/graphApp.ts): it mounts the views, builds the
// visualizer, routes host messages, posts reveal with only the node id (C-EXT I-17), and posts ready
// last, once the handler is registered (the archive's "a message sent right after the html is set
// can otherwise arrive before the listener exists"). A fake channel stands in for the VS Code API or
// the WebSocket; a fake document and surface record what the browser and cosmos.gl would hold.
// Payload P1 is d (DIRECTORY) holding f and g (FILEs): the layout puts d at index 0, then f, then g.
// Part 3a: the messages are C-EXT's (protocol 1, epoch, seq; controller decision 13), the page posts
// a render-report after each drawn graph or delta (owner decision 12a), resyncs on a gap or a stale
// epoch, and writes the verify report into the #cpg-verification banner (BMO-35 line 5).

import {
  isWorkspacePath,
  type CheckResult,
  type GraphDelta,
  type GraphEdge,
  type GraphNode,
  type GraphPayload,
  type RenderReport,
  type VerificationReport,
  type WebviewToHost,
  type WorkspacePath,
} from '@cpg/model';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verificationText } from './banner';
import type { ViewDocument, ViewElement, ViewStyle } from './dom-views';
import { PAGE_SEED, startGraphApp, type PageChannel } from './graph-app';
import { layoutPayload } from './layout';
import { hexToRgba, REGISTRY_NODE_COLORS } from './node-types';
import { GraphVisualizer, type GraphSurface, type SurfaceEvents } from './visualizer';

class FakeElement implements ViewElement<FakeElement> {
  id = '';
  className = '';
  title = '';
  hidden = false;
  textContent: string | null = null;
  innerHTML = '';
  readonly style: ViewStyle = { left: '', top: '', background: '' };
  children: FakeElement[] = [];
  private readonly listeners: (() => void)[] = [];

  setAttribute(_name: string, _value: string): void {}
  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }
  replaceChildren(...children: FakeElement[]): void {
    this.children = [...children];
  }
  addEventListener(_type: 'click', listener: () => void): void {
    this.listeners.push(listener);
  }
  click(): void {
    for (const listener of this.listeners) listener();
  }
  find(id: string): FakeElement | undefined {
    for (const child of this.children) {
      const found = child.id === id ? child : child.find(id);
      if (found) return found;
    }
    return undefined;
  }
  labels(id: string): (string | null | undefined)[] {
    return (this.find(id)?.children ?? []).map((item) => item.children[1]?.textContent);
  }
}

const doc: ViewDocument<FakeElement> = { createElement: () => new FakeElement() };

class FakeSurface implements GraphSurface {
  positions: number[] | undefined;
  colors: number[] = [];
  fits = 0;
  setPointPositions(pointPositions: Float32Array): void {
    this.positions = Array.from(pointPositions);
  }
  setPointColors(pointColors: Float32Array): void {
    this.colors = Array.from(pointColors);
  }
  setPointSizes(): void {}
  setLinks(): void {}
  setLinkWidths(): void {}
  setPinnedPoints(): void {}
  render(): void {}
  start(): void {}
  unpause(): void {}
  fitView(): void {
    this.fits += 1;
  }
  fitViewByPointPositions(): void {}
  getPointPositions(): number[] {
    return [...(this.positions ?? [])];
  }
  spaceToScreenPosition(spacePosition: [number, number]): [number, number] {
    return [spacePosition[0], spacePosition[1]];
  }
  spaceToScreenRadius(spaceRadius: number): number {
    return spaceRadius;
  }
  getPointRadiusByIndex(): number | undefined {
    return 1;
  }
  destroy(): void {}
}

class FakeChannel implements PageChannel {
  readonly posted: WebviewToHost[] = [];
  /** Runs inside post, as a host answering synchronously would. */
  onPost: ((message: WebviewToHost) => void) | undefined;
  private handler: ((message: unknown) => void) | undefined;

  post(message: WebviewToHost): void {
    this.posted.push(message);
    this.onPost?.(message);
  }
  onMessage(handler: (message: unknown) => void): void {
    this.handler = handler;
  }
  deliver(message: unknown): void {
    if (this.handler === undefined) throw new Error('no message handler registered yet');
    this.handler(message);
  }
}

interface Page {
  readonly container: FakeElement;
  readonly banner: FakeElement;
  readonly surface: FakeSurface;
  readonly channel: FakeChannel;
  readonly events: () => SurfaceEvents;
  readonly visualizer: GraphVisualizer;
}

/** A clock that returns `times` in order and throws once they run out. */
function clock(...times: number[]): () => number {
  return () => {
    const next = times.shift();
    if (next === undefined) throw new Error('the page read its clock more often than expected');
    return next;
  };
}

function start(
  channel = new FakeChannel(),
  makeSurface?: (events: SurfaceEvents) => GraphSurface,
  /** The page clock; 'default' leaves it out, so the page falls back to performance.now(). */
  now: (() => number) | 'default' = () => 0,
  recolour?: () => void,
): Page {
  const container = new FakeElement();
  const banner = new FakeElement();
  const surface = new FakeSurface();
  const box: { events?: SurfaceEvents } = {};
  const visualizer = startGraphApp(
    {
      document: doc,
      container,
      banner,
      ...(now === 'default' ? {} : { now }),
      ...(recolour === undefined ? {} : { recolour }),
      makeSurface:
        makeSurface ??
        ((events) => {
          box.events = events;
          return surface;
        }),
    },
    channel,
  );
  const events = (): SurfaceEvents => {
    if (box.events === undefined) throw new Error('makeSurface was not called');
    return box.events;
  };
  return { container, banner, surface, channel, events, visualizer };
}

function workspacePath(value: string): WorkspacePath {
  if (!isWorkspacePath(value)) throw new Error(`not a workspace path: ${value}`);
  return value;
}

const node = (id: string, type: string, name?: string): GraphNode =>
  name === undefined ? { id, type } : { id, type, name };
const edge = (source: string, target: string, type: string): GraphEdge => ({
  source,
  target,
  type,
});

const P1: GraphPayload = {
  seq: 0,
  nodes: [node('d', 'DIRECTORY'), node('f', 'FILE', 'f.ts'), node('g', 'FILE', 'g.ts')],
  edges: [edge('d', 'f', 'HAS_ENTRY'), edge('d', 'g', 'HAS_ENTRY')],
};

function delta(
  parts: Partial<Pick<GraphDelta, 'seq' | 'addedNodes' | 'addedEdges' | 'removedNodeIds'>>,
): GraphDelta {
  return {
    seq: 1,
    file: workspacePath('src/h.ts'),
    revision_id: 'r1',
    producer: 'filesystem',
    addedNodes: [],
    addedEdges: [],
    removedNodeIds: [],
    ...parts,
  };
}

const READY: WebviewToHost = { type: 'ready', protocol: 1 };

const graphMessage = (payload: GraphPayload, epoch = 1): Record<string, unknown> => ({
  type: 'graph',
  protocol: 1,
  epoch,
  seq: payload.seq,
  payload,
});
const deltaMessage = (d: GraphDelta, epoch = 1): Record<string, unknown> => ({
  type: 'graph-delta',
  protocol: 1,
  epoch,
  seq: d.seq,
  delta: d,
});

function reported(epoch: number, seq: number, report: RenderReport): WebviewToHost {
  return { type: 'render-report', epoch, seq, report };
}

/** The render-reports the page posted, in order. */
function reports(page: Page): RenderReport[] {
  return page.channel.posted.flatMap((m) => (m.type === 'render-report' ? [m.report] : []));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startGraphApp', () => {
  it('returns the visualizer and posts ready, once', () => {
    const page = start();
    expect(page.visualizer).toBeInstanceOf(GraphVisualizer);
    expect(page.channel.posted).toStrictEqual([READY]);
  });

  it('posts ready only once the handler is registered, so an immediate answer is drawn', () => {
    const channel = new FakeChannel();
    channel.onPost = (message) => {
      if (message.type === 'ready') channel.deliver(graphMessage(P1));
    };
    const page = start(channel);
    expect(page.surface.positions).toHaveLength(6);
    expect(page.container.labels('legend')).toEqual(['Directories (1)', 'Files (2)']);
  });

  it('renders a graph message into the mounted views', () => {
    const page = start();
    page.channel.deliver(graphMessage(P1));
    expect(page.surface.positions).toHaveLength(6);
    expect(page.container.labels('legend')).toEqual(['Directories (1)', 'Files (2)']);
    expect(page.container.labels('relationship-legend')).toEqual(['Has entry (2)']);
  });

  it('seeds every load alike: the same payload draws the same positions (PAGE_SEED)', () => {
    const first = start();
    const second = start();
    first.channel.deliver(graphMessage(P1));
    second.channel.deliver(graphMessage(P1));
    expect(first.surface.positions).toEqual(second.surface.positions);
    expect(first.surface.positions).toEqual(
      Array.from(layoutPayload(P1, { seed: PAGE_SEED }).positions),
    );
  });

  it('applies a graph-delta message', () => {
    const page = start();
    page.channel.deliver(graphMessage(P1));
    page.channel.deliver(
      deltaMessage(
        delta({
          addedNodes: [node('h', 'FILE', 'h.ts')],
          addedEdges: [edge('f', 'h', 'HAS_ENTRY')],
        }),
      ),
    );
    expect(page.surface.positions).toHaveLength(8);
    expect(page.container.labels('legend')).toEqual(['Directories (1)', 'Files (3)']);
  });

  it('applies an edge-only delta (C-EXT I-6)', () => {
    const page = start();
    page.channel.deliver(graphMessage(P1));
    page.channel.deliver(deltaMessage(delta({ addedEdges: [edge('f', 'g', 'IMPORTS')] })));
    expect(page.container.labels('relationship-legend')).toEqual(['Has entry (2)', 'Imports (1)']);
  });

  const G = graphMessage(P1);
  it.each([
    null,
    undefined,
    'graph',
    42,
    {},
    // The archive's protocol-less shapes (part 2b's messages) are ignored now.
    { type: 'graph', payload: P1 },
    { type: 'graph-delta', delta: delta({}) },
    { ...G, protocol: 2 },
    { ...G, protocol: '1' },
    { ...G, epoch: '1' },
    { ...G, seq: undefined },
    { type: 'verification', protocol: 1, epoch: 1, seq: 0, report: {} },
    { type: 'ready', protocol: 1 },
    { type: 'reveal', nodeId: 'd' },
    { type: 'graph', protocol: 1, epoch: 1, seq: 0 },
    { type: 'graph', protocol: 1, epoch: 1, seq: 0, payload: null },
    { type: 'graph', protocol: 1, epoch: 1, seq: 0, payload: { seq: 0, edges: [] } },
    { type: 'graph', protocol: 1, epoch: 1, seq: 0, payload: { seq: 0, nodes: [], edges: 'none' } },
    { type: 'graph', protocol: 1, epoch: 1, seq: 0, payload: 'x' },
    { type: 'graph', protocol: 1, epoch: 1, seq: 0, payload: { seq: 0, nodes: 'ab', edges: [] } },
    { type: 'graph-delta', protocol: 1, epoch: 1, seq: 1 },
    { type: 'graph-delta', protocol: 1, epoch: 1, seq: 1, delta: 1 },
    {
      type: 'graph-delta',
      protocol: 1,
      epoch: 1,
      seq: 1,
      delta: { ...delta({}), addedNodes: 'h' },
    },
    {
      type: 'graph-delta',
      protocol: 1,
      epoch: 1,
      seq: 1,
      delta: { ...delta({}), removedNodeIds: 'd' },
    },
    { type: 'graph-delta', protocol: 1, epoch: 1, seq: 1, payload: P1 },
  ])('ignores %j: never reaches the visualizer, draws nothing, posts nothing', (message) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const page = start();
    const render = vi.spyOn(page.visualizer, 'render');
    const applyDelta = vi.spyOn(page.visualizer, 'applyDelta');
    page.channel.deliver(message);
    expect(render).not.toHaveBeenCalled();
    expect(applyDelta).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(page.surface.positions).toBeUndefined();
    expect(page.channel.posted).toStrictEqual([READY]);
    expect(page.banner.textContent).toBeNull();
  });

  it('hands a well-formed message to the visualizer exactly once', () => {
    const page = start();
    const render = vi.spyOn(page.visualizer, 'render');
    const applyDelta = vi.spyOn(page.visualizer, 'applyDelta');
    page.channel.deliver(graphMessage(P1));
    const added = delta({ addedEdges: [edge('f', 'g', 'IMPORTS')] });
    page.channel.deliver(deltaMessage(added));
    expect(render.mock.calls).toEqual([[P1]]);
    expect(applyDelta.mock.calls).toEqual([[added]]);
  });

  it('ignores a malformed delta after a render, keeping the picture', () => {
    const page = start();
    page.channel.deliver(graphMessage(P1));
    const before = page.surface.positions;
    page.channel.deliver({ ...deltaMessage(delta({})), delta: { ...delta({}), addedNodes: 'h' } });
    expect(page.surface.positions).toBe(before);
  });

  it('posts reveal with only the clicked node id (C-EXT I-17)', () => {
    const page = start();
    page.channel.deliver(graphMessage(P1));
    page.events().onPointClick(1);
    expect(page.channel.posted.filter((m) => m.type !== 'render-report')).toStrictEqual([
      READY,
      { type: 'reveal', nodeId: 'f' },
    ]);
  });

  it('shows the hover tooltip in the mounted #node-tooltip', () => {
    const page = start();
    page.channel.deliver(graphMessage(P1));
    page.events().onPointMouseOver(2, [10, 20]);
    const tooltip = page.container.find('node-tooltip');
    expect(tooltip?.hidden).toBe(false);
    expect(tooltip?.textContent).toBe('FILE: g.ts');
  });

  it('reframes on a fit-view click', () => {
    const page = start();
    page.channel.deliver(graphMessage(P1));
    expect(page.surface.fits).toBe(0);
    page.container.find('fit-view-button')?.click();
    expect(page.surface.fits).toBe(1);
  });

  it('still mounts the views and posts ready when the surface fails to build, and reports nothing drawn', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const page = start(
      new FakeChannel(),
      () => {
        throw new Error('no WebGL');
      },
      clock(5, 6),
    );
    expect(page.container.find('legend-container')).toBeDefined();
    expect(page.channel.posted).toStrictEqual([READY]);
    expect(() => page.channel.deliver(graphMessage(P1))).not.toThrow();
    // Never healthy when nothing was drawn (C-EXT may_not "treat no render-report as healthy").
    expect(page.channel.posted).toStrictEqual([
      READY,
      reported(1, 0, {
        payloadNodeCount: 3,
        renderedNodeCount: 0,
        renderedEdgeCount: 0,
        duplicateEdges: 0,
        droppedNodeIds: ['d', 'f', 'g'],
        frameMs: 1,
      }),
    ]);
    expect(errors).toHaveBeenCalled();
  });
});

// Q: r (DIRECTORY) holds a; b and c hold each other (a parent-cycle no root reaches, so the layout
// never places them, stop-list 46); a is listed twice; r→a is sent twice; a→ghost dangles (C-MODEL
// I-9: kept as data, skipped at draw time).
const Q: GraphPayload = {
  seq: 0,
  nodes: [
    node('r', 'DIRECTORY'),
    node('a', 'FILE'),
    node('b', 'FILE'),
    node('c', 'FILE'),
    node('a', 'FILE'),
  ],
  edges: [
    edge('r', 'a', 'HAS_ENTRY'),
    edge('r', 'a', 'HAS_ENTRY'),
    edge('b', 'c', 'HAS_ENTRY'),
    edge('c', 'b', 'HAS_ENTRY'),
    edge('a', 'ghost', 'IMPORTS'),
  ],
};

describe('startGraphApp: render-report (owner decision 12a, C-EXT I-10)', () => {
  it('posts one render-report for a drawn graph, at its epoch and seq, timed on the page clock', () => {
    const page = start(new FakeChannel(), undefined, clock(10, 12.5));
    page.channel.deliver(graphMessage({ ...P1, seq: 4 }, 3));
    expect(page.channel.posted).toStrictEqual([
      READY,
      reported(3, 4, {
        payloadNodeCount: 3,
        renderedNodeCount: 3,
        renderedEdgeCount: 2,
        duplicateEdges: 0,
        droppedNodeIds: [],
        frameMs: 2.5,
      }),
    ]);
  });

  it('counts from the payload, not the layout: unplaced, duplicate and dangling all show', () => {
    const page = start();
    page.channel.deliver(graphMessage(Q));
    expect(reports(page)).toStrictEqual([
      {
        payloadNodeCount: 5,
        renderedNodeCount: 2,
        renderedEdgeCount: 1,
        duplicateEdges: 1,
        droppedNodeIds: ['b', 'c', 'a'],
        frameMs: 0,
      },
    ]);
  });

  it('never counts the synthetic root a multi-root payload adds', () => {
    const page = start();
    page.channel.deliver(
      graphMessage({ seq: 0, nodes: [node('x', 'FILE'), node('y', 'FILE')], edges: [] }),
    );
    expect(
      reports(page).map((r) => [r.payloadNodeCount, r.renderedNodeCount, r.droppedNodeIds]),
    ).toEqual([[2, 2, []]]);
  });

  it('reports the merged payload after a delta, at the delta seq', () => {
    const page = start(new FakeChannel(), undefined, clock(0, 1, 40, 47));
    page.channel.deliver(graphMessage(P1));
    page.channel.deliver(
      deltaMessage(
        delta({ addedNodes: [node('h', 'FILE')], addedEdges: [edge('f', 'h', 'HAS_ENTRY')] }),
      ),
    );
    expect(page.channel.posted.at(-1)).toStrictEqual(
      reported(1, 1, {
        payloadNodeCount: 4,
        renderedNodeCount: 4,
        renderedEdgeCount: 3,
        duplicateEdges: 0,
        droppedNodeIds: [],
        frameMs: 7,
      }),
    );
  });

  it('reports an edge-only delta (C-EXT I-6)', () => {
    const page = start();
    page.channel.deliver(graphMessage(P1));
    page.channel.deliver(deltaMessage(delta({ addedEdges: [edge('f', 'g', 'IMPORTS')] })));
    expect(reports(page).map((r) => r.renderedEdgeCount)).toEqual([2, 3]);
  });

  it('drops a removed node and its edges from both sides of the count', () => {
    const page = start();
    page.channel.deliver(graphMessage(P1));
    page.channel.deliver(deltaMessage(delta({ removedNodeIds: ['g'] })));
    expect(reports(page).at(-1)).toMatchObject({
      payloadNodeCount: 2,
      renderedNodeCount: 2,
      renderedEdgeCount: 1,
      droppedNodeIds: [],
    });
    // Round two (review b2): the tombstone is not drawn; its live neighbours are.
    expect(['d', 'f', 'g'].map((id) => page.visualizer.drawn().isDrawn(id))).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('shows a re-sent edge as a duplicate drawn once (applyGraphDelta keeps it; 12a)', () => {
    const page = start();
    page.channel.deliver(graphMessage(P1));
    page.channel.deliver(deltaMessage(delta({ addedEdges: [edge('d', 'f', 'HAS_ENTRY')] })));
    expect(reports(page).at(-1)).toMatchObject({ renderedEdgeCount: 2, duplicateEdges: 1 });
  });

  it('counts a point the legend hides as drawn: a toggle hides, it does not drop, and posts nothing', () => {
    const page = start();
    page.channel.deliver(graphMessage(P1));
    page.container.find('legend')?.children[1]?.click();
    expect(reports(page)).toHaveLength(1);
    page.channel.deliver(deltaMessage(delta({ addedNodes: [node('h', 'FILE')] })));
    expect(reports(page).at(-1)).toMatchObject({ payloadNodeCount: 4, renderedNodeCount: 4 });
  });

  // Round two (review a3): hidden relationship types still count as drawn edges.
  it('counts an edge the relationship legend hides as drawn, and posts nothing on the toggle', () => {
    const page = start();
    page.channel.deliver(graphMessage(P1));
    page.container.find('relationship-legend')?.children[0]?.click();
    expect(reports(page)).toHaveLength(1);
    page.channel.deliver(
      deltaMessage(
        delta({ addedNodes: [node('h', 'FILE')], addedEdges: [edge('f', 'h', 'HAS_ENTRY')] }),
      ),
    );
    expect(reports(page).at(-1)).toMatchObject({ renderedEdgeCount: 3 });
    expect(page.visualizer.drawn().edgeCount).toBe(3);
  });

  it('measures frameMs on performance.now() when the page gives no clock', () => {
    const page = start(new FakeChannel(), undefined, 'default');
    const now = vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(108);
    page.channel.deliver(graphMessage(P1));
    expect(now).toHaveBeenCalled();
    expect(reports(page).map((r) => r.frameMs)).toEqual([8]);
  });
});

describe('startGraphApp: epoch, seq and resync (C-EXT I-12, I-13)', () => {
  // Round two (review a11): a delta below the payload's seq is already-applied too.
  it.each([3, 1])(
    'ignores an already-applied delta at seq %i on seq 3: no draw, no post',
    (seq) => {
      const page = start();
      page.channel.deliver(graphMessage({ ...P1, seq: 3 }));
      const applyDelta = vi.spyOn(page.visualizer, 'applyDelta');
      page.channel.deliver(deltaMessage(delta({ seq, addedNodes: [node('h', 'FILE')] })));
      expect(applyDelta).not.toHaveBeenCalled();
      expect(page.channel.posted).toHaveLength(2);
    },
  );

  it('asks for a resync on a seq gap, at its own epoch and seq, without drawing', () => {
    const page = start();
    page.channel.deliver(graphMessage({ ...P1, seq: 3 }, 2));
    const applyDelta = vi.spyOn(page.visualizer, 'applyDelta');
    page.channel.deliver(deltaMessage(delta({ seq: 5 }), 2));
    expect(applyDelta).not.toHaveBeenCalled();
    expect(page.channel.posted.at(-1)).toStrictEqual({
      type: 'resync',
      epoch: 2,
      seq: 3,
      reason: 'gap',
    });
  });

  it('asks for a resync on a delta from another epoch, without drawing it', () => {
    const page = start();
    page.channel.deliver(graphMessage(P1, 1));
    const applyDelta = vi.spyOn(page.visualizer, 'applyDelta');
    page.channel.deliver(deltaMessage(delta({}), 2));
    expect(applyDelta).not.toHaveBeenCalled();
    expect(page.channel.posted.slice(2)).toStrictEqual([
      { type: 'resync', epoch: 1, seq: 0, reason: 'stale-epoch' },
    ]);
  });

  // Round two (review a10): an older epoch is stale too, not only a newer one.
  it('asks for a resync on a delta from an older epoch', () => {
    const page = start();
    page.channel.deliver(graphMessage(P1, 1));
    page.channel.deliver(graphMessage({ ...P1, seq: 7 }, 2));
    const applyDelta = vi.spyOn(page.visualizer, 'applyDelta');
    page.channel.deliver(deltaMessage(delta({ seq: 8 }), 1));
    expect(applyDelta).not.toHaveBeenCalled();
    expect(page.channel.posted.at(-1)).toStrictEqual({
      type: 'resync',
      epoch: 2,
      seq: 7,
      reason: 'stale-epoch',
    });
  });

  it.each([1, 0])(
    'asks for a resync on a delta at epoch %i before any graph, as epoch 0 seq -1',
    (epoch) => {
      const page = start();
      const applyDelta = vi.spyOn(page.visualizer, 'applyDelta');
      page.channel.deliver(deltaMessage(delta({ seq: 0 }), epoch));
      expect(applyDelta).not.toHaveBeenCalled();
      expect(page.channel.posted).toStrictEqual([
        READY,
        { type: 'resync', epoch: 0, seq: -1, reason: 'stale-epoch' },
      ]);
    },
  );

  it("asks for a resync with 'render-error' on a delta its payload cannot take (a type conflict)", () => {
    const page = start();
    page.channel.deliver(graphMessage(P1));
    const applyDelta = vi.spyOn(page.visualizer, 'applyDelta');
    page.channel.deliver(deltaMessage(delta({ addedNodes: [node('f', 'DIRECTORY')] })));
    expect(applyDelta).not.toHaveBeenCalled();
    expect(page.channel.posted.at(-1)).toStrictEqual({
      type: 'resync',
      epoch: 1,
      seq: 0,
      reason: 'render-error',
    });
  });

  it('takes the answering snapshot whole, so later deltas apply on it', () => {
    const page = start();
    page.channel.deliver(graphMessage(P1));
    page.channel.deliver(deltaMessage(delta({ seq: 2 })));
    const caughtUp: GraphPayload = { ...P1, seq: 1, nodes: [...P1.nodes, node('h', 'FILE')] };
    page.channel.deliver(graphMessage(caughtUp));
    page.channel.deliver(deltaMessage(delta({ seq: 2, addedNodes: [node('k', 'FILE')] })));
    expect(page.channel.posted.at(-1)).toMatchObject({ type: 'render-report', epoch: 1, seq: 2 });
    expect(reports(page).at(-1)).toMatchObject({ payloadNodeCount: 5, renderedNodeCount: 5 });
  });

  it('replaces the payload and epoch on a new graph, and applies deltas at the new epoch only', () => {
    const page = start();
    page.channel.deliver(graphMessage(P1, 1));
    page.channel.deliver(graphMessage({ seq: 7, nodes: [node('x', 'FILE')], edges: [] }, 2));
    page.channel.deliver(deltaMessage(delta({ seq: 8, addedNodes: [node('y', 'FILE')] }), 2));
    expect(page.channel.posted.at(-1)).toMatchObject({ type: 'render-report', epoch: 2, seq: 8 });
    expect(reports(page).at(-1)).toMatchObject({ payloadNodeCount: 2, renderedNodeCount: 2 });
  });
});

const CHECKS: readonly CheckResult[] = (
  [
    'filesystem-reconciliation',
    'identity-invariants',
    'id-uniqueness',
    'render-reconciliation',
    'revision-reconciliation',
    'resolution-health',
  ] as const
).map((id) => ({ id, state: 'pass', observed: 0, expected: 0, localisedTo: [], asOfSeq: 0 }));

const verification = (r: VerificationReport): unknown => ({
  type: 'verification',
  protocol: 1,
  epoch: r.epoch,
  seq: r.seq,
  report: r,
});

describe('startGraphApp: the #cpg-verification banner (BMO-35 line 5)', () => {
  const report: VerificationReport = { epoch: 1, seq: 0, checks: CHECKS, state: 'pass' };

  it('writes the latest verify report into the banner and posts nothing', () => {
    const page = start();
    page.channel.deliver(graphMessage(P1));
    page.channel.deliver(verification(report));
    expect(page.banner.textContent).toBe(verificationText(report));
    expect(page.banner.textContent).toContain('Liveness check, not verification');
    expect(page.channel.posted.map((m) => m.type)).toEqual(['ready', 'render-report']);
  });

  // U4.2.2 (controller decision 73): before any graph the page's epoch is 0, the browser host's stamp then.
  it('shows a report at epoch 0 that arrives before any graph, and the newer of two', () => {
    const page = start();
    const before: VerificationReport = { ...report, epoch: 0 };
    page.channel.deliver(verification(before));
    expect(page.banner.textContent).toBe(verificationText(before));
    const later: VerificationReport = { ...before, seq: 4, state: 'fail' };
    page.channel.deliver(verification(later));
    expect(page.banner.textContent).toBe(verificationText(later));
  });

  // U4.2.2 (controller decision 73, BMO-85): a verdict on another graph is not this one's.
  it("ignores a verification whose epoch is not the page's, before and after a graph", () => {
    const page = start();
    page.channel.deliver(verification(report));
    expect(page.banner.textContent).toBeNull();
    page.channel.deliver(graphMessage(P1, 2));
    for (const epoch of [1, 3]) {
      page.channel.deliver(verification({ ...report, epoch, state: 'fail' }));
    }
    expect(page.banner.textContent).toBeNull();
    const current: VerificationReport = { ...report, epoch: 2, seq: 7 };
    page.channel.deliver(verification(current));
    expect(page.banner.textContent).toBe(verificationText(current));
    page.channel.deliver(verification({ ...report, epoch: 1, state: 'fail' }));
    expect(page.banner.textContent).toBe(verificationText(current));
    expect(page.channel.posted.map((m) => m.type)).toEqual(['ready', 'render-report']);
  });

  it('leaves the picture alone', () => {
    const page = start();
    page.channel.deliver(graphMessage(P1));
    const before = page.surface.positions;
    page.channel.deliver(verification(report));
    expect(page.surface.positions).toBe(before);
  });
});

// U3.1.1 part 3 (controller decision 32): on `theme` the page re-reads its computed colours and applies
// the node colours. A theme belongs to no graph, so the page keeps its epoch, payload and picture.
const colours = (...hex: string[]): number[] =>
  Array.from(Float32Array.from(hex.flatMap((value) => [...hexToRgba(value)])));
const themePage = () => {
  const calls = { recolour: 0 };
  const page = start(new FakeChannel(), undefined, undefined, () => {
    calls.recolour += 1;
  });
  return { page, calls };
};

describe('startGraphApp: theme (C-EXT I-4)', () => {
  const THEME = { kind: 'dark', nodeColors: { FILE: '#336699' }, defaultNodeColor: '#ff0000' };
  const themed = (epoch: number, theme: unknown = THEME) => ({
    type: 'theme',
    protocol: 1,
    epoch,
    theme,
  });

  it('before the first graph: re-reads the page colours, draws and posts nothing, then draws in them', () => {
    const { page, calls } = themePage();
    page.channel.deliver(themed(1));
    expect(calls.recolour).toBe(1);
    expect(page.surface.positions).toBeUndefined();
    expect(page.channel.posted).toStrictEqual([READY]);
    expect(page.banner.textContent).toBeNull();
    page.channel.deliver(graphMessage(P1));
    expect(page.surface.colors).toEqual(colours('#ff0000', '#336699', '#336699'));
    expect(calls.recolour).toBe(1);
  });

  it('after a graph: recolours the points and the legend where they are, and posts nothing', () => {
    const { page, calls } = themePage();
    page.channel.deliver(graphMessage(P1));
    const before = page.surface.positions;
    const posted = page.channel.posted.length;
    page.channel.deliver(themed(1));
    page.channel.deliver(themed(1, { ...THEME, nodeColors: { DIRECTORY: '#010203' } }));
    expect(calls.recolour).toBe(2);
    expect(page.surface.colors).toEqual(colours('#010203', '#ff0000', '#ff0000'));
    const swatches = page.container.find('legend')?.children.map((item) => item.children[0]?.style);
    expect(swatches?.map((style) => style?.background)).toEqual(['#010203', '#ff0000']);
    expect(page.surface.positions).toBe(before);
    expect(page.channel.posted).toHaveLength(posted);
  });

  it("the registry's own colours draw the picture a page with no theme draws", () => {
    const { page, calls } = themePage();
    const browser = start();
    page.channel.deliver(themed(1, { ...THEME, ...REGISTRY_NODE_COLORS }));
    expect(calls.recolour).toBe(1);
    for (const each of [page, browser]) each.channel.deliver(graphMessage(P1));
    expect(page.surface.colors).toEqual(browser.surface.colors);
    expect(page.surface.colors).toEqual(Array.from(layoutPayload(P1, { seed: PAGE_SEED }).colors));
  });

  it("keeps the page's own epoch: a delta at the theme's epoch is stale, one at the page's applies", () => {
    const { page } = themePage();
    page.channel.deliver(graphMessage(P1));
    page.channel.deliver(themed(2));
    const added = delta({
      addedNodes: [node('h', 'FILE')],
      addedEdges: [edge('d', 'h', 'HAS_ENTRY')],
    });
    page.channel.deliver(deltaMessage(added, 2));
    expect(page.channel.posted.at(-1)).toStrictEqual({
      type: 'resync',
      epoch: 1,
      seq: 0,
      reason: 'stale-epoch',
    });
    page.channel.deliver(deltaMessage(added, 1));
    expect(page.surface.colors).toEqual(colours('#ff0000', '#336699', '#336699', '#336699'));
  });

  it('a page with no recolour still takes the node colours', () => {
    const page = start();
    page.channel.deliver(themed(1));
    page.channel.deliver(graphMessage(P1));
    expect(page.surface.colors).toEqual(colours('#ff0000', '#336699', '#336699'));
  });

  it('ignores a malformed theme, and takes the next one', () => {
    const { page, calls } = themePage();
    page.channel.deliver(themed(1, { ...THEME, nodeColors: null }));
    page.channel.deliver(graphMessage(P1));
    expect(calls.recolour).toBe(0);
    expect(page.surface.colors).toEqual(Array.from(layoutPayload(P1, { seed: PAGE_SEED }).colors));
    page.channel.deliver(themed(1));
    expect(calls.recolour).toBe(1);
    expect(page.surface.colors).toEqual(colours('#ff0000', '#336699', '#336699'));
  });
});
