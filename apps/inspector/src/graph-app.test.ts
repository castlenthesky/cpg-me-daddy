// The page's entry logic (port of 21754b4:src/webview/graphApp.ts): it mounts the views, builds the
// visualizer, routes host messages, posts reveal with only the node id (C-EXT I-17), and posts ready
// last, once the handler is registered (the archive's "a message sent right after the html is set
// can otherwise arrive before the listener exists"). A fake channel stands in for the VS Code API or
// the WebSocket; a fake document and surface record what the browser and cosmos.gl would hold.
// Payload P1 is d (DIRECTORY) holding f and g (FILEs): the layout puts d at index 0, then f, then g.

import {
  isWorkspacePath,
  type GraphDelta,
  type GraphEdge,
  type GraphNode,
  type GraphPayload,
  type WebviewToHost,
  type WorkspacePath,
} from '@cpg/model';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ViewDocument, ViewElement, ViewStyle } from './dom-views';
import { PAGE_SEED, startGraphApp, type PageChannel } from './graph-app';
import { layoutPayload } from './layout';
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
  fits = 0;
  setPointPositions(pointPositions: Float32Array): void {
    this.positions = Array.from(pointPositions);
  }
  setPointColors(): void {}
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
  readonly surface: FakeSurface;
  readonly channel: FakeChannel;
  readonly events: () => SurfaceEvents;
  readonly visualizer: GraphVisualizer;
}

function start(
  channel = new FakeChannel(),
  makeSurface?: (events: SurfaceEvents) => GraphSurface,
): Page {
  const container = new FakeElement();
  const surface = new FakeSurface();
  const box: { events?: SurfaceEvents } = {};
  const visualizer = startGraphApp(
    {
      document: doc,
      container,
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
  return { container, surface, channel, events, visualizer };
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

function delta(parts: Partial<Pick<GraphDelta, 'addedNodes' | 'addedEdges'>>): GraphDelta {
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startGraphApp', () => {
  it('returns the visualizer and posts ready, once', () => {
    const page = start();
    expect(page.visualizer).toBeInstanceOf(GraphVisualizer);
    expect(page.channel.posted).toStrictEqual([{ type: 'ready' }]);
  });

  it('posts ready only once the handler is registered, so an immediate answer is drawn', () => {
    const channel = new FakeChannel();
    channel.onPost = (message) => {
      if (message.type === 'ready') channel.deliver({ type: 'graph', payload: P1 });
    };
    const page = start(channel);
    expect(page.surface.positions).toHaveLength(6);
    expect(page.container.labels('legend')).toEqual(['Directories (1)', 'Files (2)']);
  });

  it('renders a graph message into the mounted views', () => {
    const page = start();
    page.channel.deliver({ type: 'graph', payload: P1 });
    expect(page.surface.positions).toHaveLength(6);
    expect(page.container.labels('legend')).toEqual(['Directories (1)', 'Files (2)']);
    expect(page.container.labels('relationship-legend')).toEqual(['Has entry (2)']);
  });

  it('seeds every load alike: the same payload draws the same positions (PAGE_SEED)', () => {
    const first = start();
    const second = start();
    first.channel.deliver({ type: 'graph', payload: P1 });
    second.channel.deliver({ type: 'graph', payload: P1 });
    expect(first.surface.positions).toEqual(second.surface.positions);
    expect(first.surface.positions).toEqual(
      Array.from(layoutPayload(P1, { seed: PAGE_SEED }).positions),
    );
  });

  it('applies a graph-delta message', () => {
    const page = start();
    page.channel.deliver({ type: 'graph', payload: P1 });
    page.channel.deliver({
      type: 'graph-delta',
      delta: delta({
        addedNodes: [node('h', 'FILE', 'h.ts')],
        addedEdges: [edge('f', 'h', 'HAS_ENTRY')],
      }),
    });
    expect(page.surface.positions).toHaveLength(8);
    expect(page.container.labels('legend')).toEqual(['Directories (1)', 'Files (3)']);
  });

  it('applies an edge-only delta (C-EXT I-6)', () => {
    const page = start();
    page.channel.deliver({ type: 'graph', payload: P1 });
    page.channel.deliver({
      type: 'graph-delta',
      delta: delta({ addedEdges: [edge('f', 'g', 'IMPORTS')] }),
    });
    expect(page.container.labels('relationship-legend')).toEqual(['Has entry (2)', 'Imports (1)']);
  });

  it.each([
    null,
    undefined,
    'graph',
    42,
    {},
    { type: 'theme', theme: {} },
    { type: 'verification', report: {} },
    { type: 'ready' },
    { type: 'reveal', nodeId: 'd' },
    { type: 'graph' },
    { type: 'graph', payload: null },
    { type: 'graph', payload: { edges: [] } },
    { type: 'graph', payload: { nodes: [], edges: 'none' } },
    { type: 'graph', delta: { addedNodes: [], addedEdges: [], removedNodeIds: [] } },
    { type: 'graph-delta' },
    { type: 'graph-delta', delta: null },
    { type: 'graph-delta', delta: { addedNodes: [], addedEdges: [] } },
    { type: 'graph-delta', delta: { addedNodes: [], addedEdges: {}, removedNodeIds: [] } },
    { type: 'graph-delta', payload: P1 },
    // Round two (review a8): truthy primitives where an object belongs.
    { type: 'graph', payload: 'x' },
    { type: 'graph-delta', delta: 1 },
    // Round two (review a7): iterable non-arrays, which the visualizer would iterate.
    { type: 'graph', payload: { nodes: 'ab', edges: [] } },
    { type: 'graph', payload: { nodes: [], edges: 'x' } },
    { type: 'graph-delta', delta: { addedNodes: 'h', addedEdges: [], removedNodeIds: [] } },
    { type: 'graph-delta', delta: { addedNodes: [], addedEdges: 'x', removedNodeIds: [] } },
    { type: 'graph-delta', delta: { addedNodes: [], addedEdges: [], removedNodeIds: 'd' } },
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
    expect(page.channel.posted).toStrictEqual([{ type: 'ready' }]);
  });

  it('hands a well-formed message to the visualizer exactly once', () => {
    const page = start();
    const render = vi.spyOn(page.visualizer, 'render');
    const applyDelta = vi.spyOn(page.visualizer, 'applyDelta');
    page.channel.deliver({ type: 'graph', payload: P1 });
    const added = delta({ addedEdges: [edge('f', 'g', 'IMPORTS')] });
    page.channel.deliver({ type: 'graph-delta', delta: added });
    expect(render.mock.calls).toEqual([[P1]]);
    expect(applyDelta.mock.calls).toEqual([[added]]);
  });

  it('ignores a malformed delta after a render, keeping the picture', () => {
    const page = start();
    page.channel.deliver({ type: 'graph', payload: P1 });
    const before = page.surface.positions;
    page.channel.deliver({
      type: 'graph-delta',
      delta: { addedNodes: 'h', addedEdges: [], removedNodeIds: [] },
    });
    expect(page.surface.positions).toBe(before);
  });

  it('posts reveal with only the clicked node id (C-EXT I-17)', () => {
    const page = start();
    page.channel.deliver({ type: 'graph', payload: P1 });
    page.events().onPointClick(1);
    expect(page.channel.posted).toStrictEqual([{ type: 'ready' }, { type: 'reveal', nodeId: 'f' }]);
  });

  it('shows the hover tooltip in the mounted #node-tooltip', () => {
    const page = start();
    page.channel.deliver({ type: 'graph', payload: P1 });
    page.events().onPointMouseOver(2, [10, 20]);
    const tooltip = page.container.find('node-tooltip');
    expect(tooltip?.hidden).toBe(false);
    expect(tooltip?.textContent).toBe('FILE: g.ts');
  });

  it('reframes on a fit-view click', () => {
    const page = start();
    page.channel.deliver({ type: 'graph', payload: P1 });
    expect(page.surface.fits).toBe(0);
    page.container.find('fit-view-button')?.click();
    expect(page.surface.fits).toBe(1);
  });

  it('still mounts the views and posts ready when the surface fails to build, and survives a later graph', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const page = start(new FakeChannel(), () => {
      throw new Error('no WebGL');
    });
    expect(page.container.find('legend-container')).toBeDefined();
    expect(page.channel.posted).toStrictEqual([{ type: 'ready' }]);
    expect(() => page.channel.deliver({ type: 'graph', payload: P1 })).not.toThrow();
    expect(page.channel.posted).toStrictEqual([{ type: 'ready' }]);
    expect(errors).toHaveBeenCalled();
  });
});
