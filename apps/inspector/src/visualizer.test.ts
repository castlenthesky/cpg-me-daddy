// The visualizer (BMO-35 line 2: the split of 21754b4:packages/graph-visualizer/src/visualizer.ts,
// with the edge-only early return at :290 removed). A fake surface records what cosmos.gl would be
// handed; its getPointPositions reads back the last positions pushed, which a test may move to
// stand in for the simulation. Payload P1 is d (DIRECTORY) holding f and g (FILEs): the layout puts
// d at index 0, then f, then g, with sizes 20, 17.6, 17.6, so each HAS_ENTRY link is
// (20 + 17.6) / 2 * 0.2 = 3.76 wide. The fake maps space (x, y) to screen (2x, 3y), radius r to 10r,
// and every point radius is 1.5. Sprint 26 (controller decision 85): a delta never moves the camera,
// never re-runs the layout and never restarts the simulation at full energy; a removed point goes to
// NaN, which cosmos.gl 3.6 fades out in place on render() unless start() or unpause() ends the
// transition (their doc comments), so the gentle restart waits for onTransitionEnd(false).

import {
  isWorkspacePath,
  type GraphDelta,
  type GraphEdge,
  type GraphNode,
  type GraphPayload,
  type WorkspacePath,
} from '@cpg/model';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { layoutPayload } from './layout';
import type { LegendRow } from './legend';
import { hexToRgba, REGISTRY_NODE_COLORS } from './node-types';
import {
  GraphVisualizer,
  type GraphSurface,
  type GraphVisualizerOptions,
  type LegendView,
  type SurfaceEvents,
  type TooltipView,
} from './visualizer';

class FakeSurface implements GraphSurface {
  readonly log: string[] = [];
  failOn: string | undefined;
  live: number[] = [];
  positions: number[] = [];
  colors: number[] = [];
  sizes: number[] = [];
  links: number[] = [];
  linkWidths: number[] = [];
  pinned: number[] | null = null;
  readonly starts: (number | undefined)[] = [];
  /** The arguments of each render() call. */
  readonly renders: unknown[][] = [];
  readonly fits: (number | undefined)[] = [];
  readonly framed: { positions: number[]; duration: number | undefined }[] = [];
  destroyed = false;

  private record(name: string): void {
    this.log.push(name);
    if (name === this.failOn) throw new Error(`fake ${name} failed`);
  }
  setPointPositions(pointPositions: Float32Array): void {
    this.record('setPointPositions');
    this.positions = Array.from(pointPositions);
    this.live = Array.from(pointPositions);
  }
  setPointColors(pointColors: Float32Array): void {
    this.record('setPointColors');
    this.colors = Array.from(pointColors);
  }
  setPointSizes(pointSizes: Float32Array): void {
    this.record('setPointSizes');
    this.sizes = Array.from(pointSizes);
  }
  setLinks(links: Float32Array): void {
    this.record('setLinks');
    this.links = Array.from(links);
  }
  setLinkWidths(linkWidths: Float32Array): void {
    this.record('setLinkWidths');
    this.linkWidths = Array.from(linkWidths);
  }
  setPinnedPoints(pinnedIndices: number[] | null): void {
    this.record('setPinnedPoints');
    this.pinned = pinnedIndices === null ? null : [...pinnedIndices];
  }
  render(...args: unknown[]): void {
    this.record('render');
    this.renders.push(args);
  }
  start(alpha?: number): void {
    this.record('start');
    this.starts.push(alpha);
  }
  unpause(): void {
    this.record('unpause');
  }
  fitView(duration?: number): void {
    this.record('fitView');
    this.fits.push(duration);
  }
  fitViewByPointPositions(positions: number[], duration?: number): void {
    this.record('fitViewByPointPositions');
    this.framed.push({ positions: [...positions], duration });
  }
  getPointPositions(): number[] {
    return [...this.live];
  }
  spaceToScreenPosition(spacePosition: [number, number]): [number, number] {
    return [spacePosition[0] * 2, spacePosition[1] * 3];
  }
  spaceToScreenRadius(spaceRadius: number): number {
    return spaceRadius * 10;
  }
  getPointRadiusByIndex(_index: number): number | undefined {
    return 1.5;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

class FakeLegend implements LegendView {
  nodeRows: readonly LegendRow[] = [];
  relationshipRows: readonly LegendRow[] = [];
  private nodeToggle: ((key: string) => void) | undefined;
  private relationshipToggle: ((key: string) => void) | undefined;

  showNodeTypes(rows: readonly LegendRow[], onToggle: (key: string) => void): void {
    this.nodeRows = rows;
    this.nodeToggle = onToggle;
  }
  showRelationshipTypes(rows: readonly LegendRow[], onToggle: (key: string) => void): void {
    this.relationshipRows = rows;
    this.relationshipToggle = onToggle;
  }
  toggleNode(key: string): void {
    if (this.nodeToggle === undefined) throw new Error('no node legend yet');
    this.nodeToggle(key);
  }
  toggleRelationship(key: string): void {
    if (this.relationshipToggle === undefined) throw new Error('no relationship legend yet');
    this.relationshipToggle(key);
  }
  texts(which: 'node' | 'relationship'): string[] {
    return (which === 'node' ? this.nodeRows : this.relationshipRows).map((row) => row.text);
  }
}

class FakeTooltip implements TooltipView {
  shown: { text: string; left: number; top: number } | undefined;
  visible = false;
  show(text: string, left: number, top: number): void {
    this.shown = { text, left, top };
    this.visible = true;
  }
  hide(): void {
    this.visible = false;
  }
}

interface Mounted {
  readonly viz: GraphVisualizer;
  readonly surface: FakeSurface;
  readonly events: SurfaceEvents;
  readonly legend: FakeLegend;
  readonly tooltip: FakeTooltip;
  readonly clicks: GraphNode[];
  readonly setNow: (ms: number) => void;
}

function mount(seed = 7, layout: Pick<GraphVisualizerOptions, 'parentTable'> = {}): Mounted {
  const surface = new FakeSurface();
  const legend = new FakeLegend();
  const tooltip = new FakeTooltip();
  const clicks: GraphNode[] = [];
  const clock = { now: 0 };
  const box: { events?: SurfaceEvents } = {};
  const options: GraphVisualizerOptions = {
    seed,
    ...layout,
    onNodeClick: (node) => {
      clicks.push(node);
    },
    now: () => clock.now,
  };
  const viz = new GraphVisualizer(
    (events) => {
      box.events = events;
      return surface;
    },
    { legend, tooltip },
    options,
  );
  const events = box.events;
  if (events === undefined) throw new Error('makeSurface was not called');
  const setNow = (ms: number): void => {
    clock.now = ms;
  };
  return { viz, surface, events, legend, tooltip, clicks, setNow };
}

const failingSurface = (): GraphSurface => {
  throw new Error('no WebGL');
};

function workspacePath(value: string): WorkspacePath {
  if (!isWorkspacePath(value)) throw new Error(`not a workspace path: ${value}`);
  return value;
}

const node = (id: string, type = 'FILE', name?: string): GraphNode =>
  name === undefined ? { id, type } : { id, type, name };
const edge = (source: string, target: string, type?: string): GraphEdge =>
  type === undefined ? { source, target } : { source, target, type };
const entry = (source: string, target: string): GraphEdge => edge(source, target, 'HAS_ENTRY');

const D = node('d', 'DIRECTORY');
const F = node('f', 'FILE', 'f.ts');
const G = node('g', 'FILE', 'g.ts');
const P1: GraphPayload = { seq: 0, nodes: [D, F, G], edges: [entry('d', 'f'), entry('d', 'g')] };
/** d holds f, and f DEFINES s: the layout adopts s under f, and double-counts that edge in its links. */
const P2: GraphPayload = {
  seq: 0,
  nodes: [D, F, node('s', 'SYMBOL', 'sym')],
  edges: [entry('d', 'f'), edge('f', 's', 'DEFINES')],
};
/** Two roots: index 0 is the synthetic centre, then a and b. */
const P3: GraphPayload = { seq: 0, nodes: [node('a', 'FILE', 'a.ts'), node('b')], edges: [] };
const IMPORTS = edge('f', 'g', 'IMPORTS');

function delta(
  parts: Partial<Pick<GraphDelta, 'addedNodes' | 'addedEdges' | 'removedNodeIds'>>,
): GraphDelta {
  return {
    seq: 1,
    file: workspacePath('src/f.ts'),
    revision_id: 'r1',
    producer: 'filesystem',
    addedNodes: [],
    addedEdges: [],
    removedNodeIds: [],
    ...parts,
  };
}
const edgeOnly = (...addedEdges: GraphEdge[]): GraphDelta => delta({ addedEdges });

/** Moves f to (500, 600), adds h under it, and returns h's offset from there. */
function deltaOffset(m: Mounted): number[] {
  m.surface.live[2] = 500;
  m.surface.live[3] = 600;
  m.viz.applyDelta(delta({ addedNodes: [node('h')], addedEdges: [entry('f', 'h')] }));
  return [(m.surface.positions[6] ?? NaN) - 500, (m.surface.positions[7] ?? NaN) - 600];
}

function expectClose(actual: readonly number[], expected: readonly number[], digits = 4): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, digits));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GraphVisualizer construction', () => {
  it('survives a surface that fails to build, then logs instead of drawing', () => {
    const error = vi.spyOn(console, 'error').mockReturnValue(undefined);
    const legend = new FakeLegend();
    const viz = new GraphVisualizer(
      failingSurface,
      { legend, tooltip: new FakeTooltip() },
      { seed: 1 },
    );
    expect(error).toHaveBeenCalledTimes(1);
    expect(() => viz.render(P1)).not.toThrow();
    expect(error).toHaveBeenCalledTimes(2);
    expect(() => viz.applyDelta(edgeOnly(IMPORTS))).not.toThrow();
    expect(error).toHaveBeenCalledTimes(3);
    expect(() => {
      viz.fitView();
      viz.dispose();
    }).not.toThrow();
    expect(legend.nodeRows).toEqual([]);
  });
});

describe('GraphVisualizer.render', () => {
  it('pushes the layout, with links built from the edge set rather than the layout links', () => {
    const { viz, surface } = mount();
    viz.render(P2);
    const layout = layoutPayload(P2, { seed: 7 });
    expect(surface.colors).toEqual(Array.from(layout.colors));
    expect(surface.sizes).toEqual(Array.from(layout.sizes));
    expect(surface.positions).toEqual(Array.from(layout.positions));
    // The layout carries f→s twice (tree link plus the DEFINES union, stop-list 49); the edge set once.
    expect(layout.links).toHaveLength(6);
    expect(surface.links).toEqual([0, 1, 1, 2]);
    expectClose(surface.linkWidths, [3.76, ((17.6 + 17.6 * 0.88) / 2) * 0.2]);
  });

  it('pins point 0 after the positions, renders after every push, frames, then starts at alpha 1', () => {
    const { viz, surface } = mount();
    viz.render(P1);
    const at = (name: string): number => surface.log.indexOf(name);
    for (const push of [
      'setPointColors',
      'setPointSizes',
      'setLinks',
      'setLinkWidths',
      'setPointPositions',
    ]) {
      expect(at(push)).toBeGreaterThanOrEqual(0);
      expect(at(push)).toBeLessThan(at('render'));
    }
    expect(at('setPinnedPoints')).toBeGreaterThan(at('setPointPositions'));
    // round two (review a9): a pin set after render() is not applied on that render.
    expect(at('setPinnedPoints')).toBeLessThan(at('render'));
    expect(surface.pinned).toEqual([0]);
    expect(at('start')).toBeGreaterThan(at('render'));
    expect(surface.starts).toEqual([1]);
    expect(surface.framed).toEqual([
      { positions: Array.from(layoutPayload(P1, { seed: 7 }).positions), duration: 0 },
    ]);
    expect(surface.links).toEqual([0, 1, 0, 2]);
    expectClose(surface.linkWidths, [3.76, 3.76]);
  });

  it('draws the same payload and seed identically, and a different seed elsewhere', () => {
    const one = mount(7);
    const two = mount(7);
    const other = mount(8);
    for (const m of [one, two, other]) m.viz.render(P1);
    expect(two.surface.positions).toEqual(one.surface.positions);
    expect(two.surface.colors).toEqual(one.surface.colors);
    expect(two.surface.sizes).toEqual(one.surface.sizes);
    expect(two.surface.links).toEqual(one.surface.links);
    expect(two.surface.linkWidths).toEqual(one.surface.linkWidths);
    expect(other.surface.positions).not.toEqual(one.surface.positions);
  });

  it('hides the tooltip and refreshes both legends', () => {
    const { viz, events, legend, tooltip } = mount();
    viz.render(P1);
    events.onPointMouseOver(1, [10, 20]);
    expect(tooltip.visible).toBe(true);
    viz.render(P1);
    expect(tooltip.visible).toBe(false);
    expect(legend.texts('node')).toEqual(['Directories (1)', 'Files (2)']);
    expect(legend.texts('relationship')).toEqual(['Has entry (2)']);
  });

  // round two (review a11): a render replaces the edge set, it does not merge into it.
  it('drops the edges a delta added when a fresh payload renders', () => {
    const { viz, surface, legend } = mount();
    viz.render(P1);
    viz.applyDelta(edgeOnly(IMPORTS));
    viz.render(P1);
    expect(surface.links).toEqual([0, 1, 0, 2]);
    expect(legend.texts('relationship')).toEqual(['Has entry (2)']);
  });

  it('leaves the synthetic root out of the node legend', () => {
    const { viz, legend } = mount();
    viz.render(P3);
    expect(legend.texts('node')).toEqual(['Files (2)']);
  });

  it('never calls Math.random, in a render or a delta', () => {
    const random = vi.spyOn(Math, 'random');
    const { viz } = mount();
    viz.render(P1);
    viz.applyDelta(delta({ addedNodes: [node('h')], addedEdges: [entry('f', 'h')] }));
    viz.applyDelta(delta({ addedNodes: [node('i')] }));
    expect(random).not.toHaveBeenCalled();
  });

  it('logs and survives an error thrown by the surface', () => {
    const error = vi.spyOn(console, 'error').mockReturnValue(undefined);
    const { viz, surface } = mount();
    surface.failOn = 'setPointColors';
    expect(() => viz.render(P1)).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe('GraphVisualizer.applyDelta', () => {
  it('delivers an edge-only delta (C-EXT I-6; the archive returned early at :290)', () => {
    const { viz, surface, legend } = mount();
    viz.render(P1);
    viz.applyDelta(edgeOnly(IMPORTS));
    expect(surface.links).toEqual([0, 1, 0, 2, 1, 2]);
    expectClose(surface.linkWidths, [3.76, 3.76, 17.6 * 0.2]);
    expect(legend.texts('relationship')).toEqual(['Has entry (2)', 'Imports (1)']);
  });

  // Reworked in sprint 26 (decision 85): no unpause() or start() here, since either cuts the fade.
  it('pushes, re-pins point 0 and renders, and neither restarts the simulation nor moves the camera', () => {
    const { viz, surface } = mount();
    viz.render(P1);
    surface.log.length = 0;
    surface.pinned = null;
    viz.applyDelta(edgeOnly(IMPORTS));
    const at = (name: string): number => surface.log.indexOf(name);
    for (const push of [
      'setPointColors',
      'setPointSizes',
      'setLinks',
      'setLinkWidths',
      'setPointPositions',
    ]) {
      expect(at(push)).toBeGreaterThanOrEqual(0);
      expect(at(push)).toBeLessThan(at('render'));
    }
    expect(at('setPinnedPoints')).toBeGreaterThan(at('setPointPositions'));
    // round two (review a9)
    expect(at('setPinnedPoints')).toBeLessThan(at('render'));
    expect(surface.pinned).toEqual([0]);
    // render() with no arguments: the transition animates (render(_, 0) would snap it).
    expect([surface.renders.at(-1), surface.starts, surface.framed.length]).toEqual([[], [1], 1]);
    expect(surface.log.filter((name) => /^(unpause|start|fitView)/.test(name))).toEqual([]);
  });

  it('restarts the simulation once, at 0.1, when the transition a delta began ends uninterrupted', () => {
    const { viz, surface, events } = mount();
    viz.render(P1);
    events.onTransitionEnd(false);
    viz.applyDelta(delta({ addedNodes: [node('h')], addedEdges: [entry('f', 'h')] }));
    viz.applyDelta(delta({ removedNodeIds: ['g'] }));
    events.onTransitionEnd(true);
    expect(surface.starts).toEqual([1]);
    surface.log.length = 0;
    events.onTransitionEnd(false);
    expect([surface.log, surface.starts]).toEqual([
      ['unpause', 'start'],
      [1, 0.1],
    ]);
    events.onTransitionEnd(false);
    expect(surface.starts).toEqual([1, 0.1]);
    // Round two (R12): a later delta arms it again.
    viz.applyDelta(edgeOnly(IMPORTS));
    events.onTransitionEnd(false);
    expect(surface.starts).toEqual([1, 0.1, 0.1]);
  });

  it('never restarts after a render or a legend toggle has started the simulation itself', () => {
    const { viz, surface, events, legend } = mount();
    viz.render(P1);
    viz.applyDelta(edgeOnly(IMPORTS));
    viz.render(P1);
    events.onTransitionEnd(false);
    viz.applyDelta(edgeOnly(IMPORTS));
    legend.toggleNode('FILE');
    events.onTransitionEnd(false);
    expect(surface.starts).toEqual([1, 1, 0.1]);
  });

  it('keeps following with a glide (fitView 250), never a snap, and stays put once the user zoomed', () => {
    const { viz, surface, events, setNow } = mount();
    viz.render(P1);
    viz.applyDelta(delta({ addedNodes: [node('h')], addedEdges: [entry('f', 'h')] }));
    events.onTransitionEnd(false);
    setNow(300);
    events.onSimulationTick();
    expect([surface.fits, surface.framed.length]).toEqual([[250], 1]);
    events.onZoomStart(undefined, true);
    viz.applyDelta(delta({ removedNodeIds: ['h'] }));
    events.onTransitionEnd(false);
    setNow(10_000);
    events.onSimulationTick();
    events.onSimulationEnd();
    expect([surface.fits, surface.framed.length]).toEqual([[250], 1]);
  });

  it('keeps every point where the simulation left it (the archive pushed stale seed positions)', () => {
    const { viz, surface } = mount();
    viz.render(P1);
    const seeded = [...surface.positions];
    surface.live[2] = 500;
    surface.live[3] = 600;
    viz.applyDelta(edgeOnly(IMPORTS));
    expect(surface.positions).toEqual([seeded[0], seeded[1], 500, 600, seeded[4], seeded[5]]);
  });

  it("tombstones a removed node, drops its links and lowers its type's count", () => {
    const { viz, surface, legend } = mount();
    viz.render(P1);
    viz.applyDelta(edgeOnly(IMPORTS));
    viz.applyDelta(delta({ removedNodeIds: ['g'] }));
    expect(surface.positions.slice(4)).toEqual([NaN, NaN]);
    expect(surface.links).toEqual([0, 1]);
    expect(legend.texts('node')).toEqual(['Directories (1)', 'Files (1)']);
    expect(legend.texts('relationship')).toEqual(['Has entry (1)']);
  });

  // Post-implementation (sabotage #72): a removed node's edges leave the edge set, so re-adding the
  // node does not resurrect them (the archive's phantom-edge hazard).
  it("does not bring back a removed node's edges when the node is re-added", () => {
    const { viz, surface } = mount();
    viz.render(P1);
    viz.applyDelta(edgeOnly(IMPORTS));
    viz.applyDelta(delta({ removedNodeIds: ['g'] }));
    viz.applyDelta(delta({ addedNodes: [G] }));
    expect(surface.links).toEqual([0, 1]);
  });

  it('draws a re-delivered edge once (the archive appended, so link springs stacked)', () => {
    const { viz, surface } = mount();
    viz.render(P1);
    viz.applyDelta(edgeOnly(IMPORTS));
    viz.applyDelta(edgeOnly(IMPORTS, entry('d', 'f')));
    expect(surface.links).toEqual([0, 1, 0, 2, 1, 2]);
  });

  it('draws an edge that arrived before its endpoint once the endpoint arrives', () => {
    const { viz, surface } = mount();
    viz.render(P1);
    viz.applyDelta(edgeOnly(edge('g', 'h', 'CALLS')));
    expect(surface.links).toEqual([0, 1, 0, 2]);
    viz.applyDelta(delta({ addedNodes: [node('h')] }));
    expect(surface.links).toEqual([0, 1, 0, 2, 2, 3]);
  });

  it('seeds an added node within one link distance of where its parent is now, and links it', () => {
    const { viz, surface } = mount();
    viz.render(P1);
    surface.live[2] = 500;
    surface.live[3] = 600;
    viz.applyDelta(
      delta({ addedNodes: [node('h', 'FILE', 'h.ts')], addedEdges: [entry('f', 'h')] }),
    );
    expect(surface.positions).toHaveLength(8);
    expect(Math.abs((surface.positions[6] ?? NaN) - 500)).toBeLessThanOrEqual(20);
    expect(Math.abs((surface.positions[7] ?? NaN) - 600)).toBeLessThanOrEqual(20);
    expect(surface.sizes[3]).toBeCloseTo(17.6 * 0.88, 4);
    expect(surface.colors.slice(12)).toEqual(
      Array.from(Float32Array.from([77 / 255, 179 / 255, 1, 1])),
    );
    expect(surface.links).toEqual([0, 1, 0, 2, 1, 3]);
  });

  it('places a delta node the same way for the same seed', () => {
    const one = mount(7);
    const two = mount(7);
    for (const m of [one, two]) {
      m.viz.render(P1);
      m.viz.applyDelta(delta({ addedNodes: [node('h')], addedEdges: [entry('f', 'h')] }));
    }
    expect(two.surface.positions).toEqual(one.surface.positions);
  });

  // round two (review a8): the jitter is the seed's, non-zero, and restarts with every render.
  it('jitters a delta node by the seed, and re-seeds the jitter on every render', () => {
    const seven = mount(7);
    const eight = mount(8);
    seven.viz.render(P1);
    eight.viz.render(P1);
    const first = deltaOffset(seven);
    expect(first.every((offset) => offset !== 0 && Math.abs(offset) <= 20)).toBe(true);
    expect(deltaOffset(eight)).not.toEqual(first);
    seven.viz.render(P1);
    expect(deltaOffset(seven)).toEqual(first);
  });

  // round two (review b1): the hierarchy and fallback options reach the layout and the delta seeding.
  // Sprint 33 rework (BMO-100): the two options are one parent table.
  it("lays out and seeds deltas by the configured parent table's rows", () => {
    const options = {
      parentTable: {
        hierarchy: [{ type: 'CONTAINS', parent: 'source' as const }],
        fallback: [{ type: 'REF', parent: 'source' as const }],
      },
    };
    const m = mount(7, options);
    const chain: GraphPayload = {
      seq: 0,
      nodes: [D, F, G],
      edges: [edge('d', 'f', 'CONTAINS'), edge('f', 'g', 'CONTAINS')],
    };
    m.viz.render(chain);
    // Under the default HAS_ENTRY all three would be roots around a synthetic fourth point.
    expect(m.surface.positions).toEqual(
      Array.from(layoutPayload(chain, { seed: 7, ...options }).positions),
    );
    expect(m.surface.positions).toHaveLength(6);
    m.surface.live[4] = 900;
    m.surface.live[5] = 900;
    m.viz.applyDelta(
      delta({
        addedNodes: [node('h'), node('i')],
        addedEdges: [edge('g', 'h', 'CONTAINS'), entry('d', 'i'), edge('g', 'i', 'REF')],
      }),
    );
    for (const at of [6, 7, 8, 9]) {
      expect(Math.abs((m.surface.positions[at] ?? NaN) - 900)).toBeLessThanOrEqual(20);
    }
  });

  it('seeds a delta node by the default DEFINES fallback when it has no hierarchy edge', () => {
    const { viz, surface } = mount();
    viz.render(P1);
    surface.live[2] = 500;
    surface.live[3] = 600;
    viz.applyDelta(
      delta({ addedNodes: [node('s', 'SYMBOL')], addedEdges: [edge('f', 's', 'DEFINES')] }),
    );
    expect(Math.abs((surface.positions[6] ?? NaN) - 500)).toBeLessThanOrEqual(20);
    expect(Math.abs((surface.positions[7] ?? NaN) - 600)).toBeLessThanOrEqual(20);
  });

  // Sprint 33 (BMO-100, controller decisions 85 and 103): by default the code tier is placed by
  // the parent table, both in the layout and when a save re-adds the file's code nodes.
  it('places a MODULE by its FILE, and seeds a code delta listed child first beside its parents', () => {
    const { viz, surface } = mount();
    const code: GraphPayload = {
      seq: 0,
      nodes: [D, F, node('m', 'MODULE')],
      edges: [entry('d', 'f'), edge('m', 'f', 'SOURCE_FILE')],
    };
    viz.render(code);
    // d, f, m and no synthetic centre: m is not a root.
    expect(surface.positions).toEqual(Array.from(layoutPayload(code, { seed: 7 }).positions));
    expect(surface.positions).toHaveLength(6);
    surface.live = [100, 100, 500, 600, 900, 900];
    const before = { framed: surface.framed.length, starts: [...surface.starts] };
    viz.applyDelta(
      delta({
        removedNodeIds: ['m'],
        addedNodes: [node('c', 'CALL'), node('t', 'METHOD'), node('m', 'MODULE')],
        addedEdges: [
          edge('c', 't', 'IN_SCOPE'),
          edge('m', 't', 'DECLARES'),
          edge('m', 'f', 'SOURCE_FILE'),
        ],
      }),
    );
    // m beside f (500, 600), t beside m, c beside t: within 20, 40 and 60 of f on each axis.
    expect(surface.positions).toHaveLength(10);
    expect(surface.positions.slice(0, 4)).toEqual([100, 100, 500, 600]);
    const far = [4, 6, 8].filter((at) => {
      const dx = Math.abs((surface.positions[at] ?? NaN) - 500);
      const dy = Math.abs((surface.positions[at + 1] ?? NaN) - 600);
      return !(dx <= 60 && dy <= 60);
    });
    expect(far).toEqual([]);
    expect(Math.abs((surface.positions[4] ?? NaN) - 500)).toBeLessThanOrEqual(20);
    expect(Math.abs((surface.positions[5] ?? NaN) - 600)).toBeLessThanOrEqual(20);
    expect({ framed: surface.framed.length, starts: surface.starts }).toEqual(before);
  });

  // round two (review b2)
  it('keeps a hidden relationship type hidden through a delta, new edges of that type included', () => {
    const { viz, surface, legend } = mount();
    viz.render(P1);
    legend.toggleRelationship('HAS_ENTRY');
    viz.applyDelta(delta({ addedNodes: [node('h')], addedEdges: [entry('d', 'h'), IMPORTS] }));
    expect(surface.links).toEqual([1, 2]);
    expect(legend.relationshipRows.map((row) => [row.text, row.pressed])).toEqual([
      ['Has entry (3)', false],
      ['Imports (1)', true],
    ]);
  });

  it('keeps a hidden node type hidden through a delta, new nodes of that type included', () => {
    const { viz, surface, legend } = mount();
    viz.render(P1);
    legend.toggleNode('FILE');
    viz.applyDelta(delta({ addedNodes: [node('h')], addedEdges: [entry('d', 'h')] }));
    expect(surface.positions.slice(2)).toEqual([NaN, NaN, NaN, NaN, NaN, NaN]);
    expect(Number.isFinite(surface.positions[0])).toBe(true);
    expect(legend.texts('node')).toEqual(['Directories (1)', 'Files (3)']);
  });

  it('logs and survives an error thrown by the surface', () => {
    const error = vi.spyOn(console, 'error').mockReturnValue(undefined);
    const { viz, surface } = mount();
    viz.render(P1);
    surface.failOn = 'setLinks';
    expect(() => viz.applyDelta(edgeOnly(IMPORTS))).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe('GraphVisualizer legend toggles', () => {
  it('hides a node type by NaN position and reheats gently', () => {
    const { viz, surface, legend } = mount();
    viz.render(P1);
    surface.log.length = 0;
    legend.toggleNode('FILE');
    expect(surface.positions.slice(2)).toEqual([NaN, NaN, NaN, NaN]);
    expect(surface.positions.slice(0, 2).every(Number.isFinite)).toBe(true);
    expect(surface.log.indexOf('render')).toBeGreaterThan(surface.log.indexOf('setPointPositions'));
    expect(surface.log.indexOf('unpause')).toBeGreaterThan(surface.log.indexOf('render'));
    // round two (review a9): a start before render() is paused again by the position transition.
    expect(surface.log.indexOf('start')).toBeGreaterThan(surface.log.indexOf('render'));
    expect(surface.starts).toEqual([1, 0.1]);
    expect(legend.nodeRows.find((row) => row.key === 'FILE')?.pressed).toBe(false);
    expect(legend.texts('node')).toEqual(['Directories (1)', 'Files (2)']);
  });

  it('brings a re-shown type back where it was when hidden (the archive restored its seed)', () => {
    const { viz, surface, legend } = mount();
    viz.render(P1);
    surface.live[2] = 500;
    surface.live[3] = 600;
    legend.toggleNode('FILE');
    legend.toggleNode('FILE');
    expect(surface.positions.slice(2, 4)).toEqual([500, 600]);
    expect(legend.nodeRows.find((row) => row.key === 'FILE')?.pressed).toBe(true);
  });

  it('keeps a hidden node type hidden across a render, and frames the unmasked layout', () => {
    const { viz, surface, legend } = mount();
    viz.render(P1);
    legend.toggleNode('FILE');
    viz.render(P1);
    expect(surface.positions.slice(2)).toEqual([NaN, NaN, NaN, NaN]);
    expect(surface.starts.at(-1)).toBe(1);
    expect(surface.framed.at(-1)?.positions.every(Number.isFinite)).toBe(true);
    expect(legend.nodeRows.find((row) => row.key === 'FILE')?.pressed).toBe(false);
  });

  it('hides a relationship type by dropping its links, without moving a point', () => {
    const { viz, surface, legend } = mount();
    viz.render(P1);
    viz.applyDelta(edgeOnly(IMPORTS));
    surface.log.length = 0;
    legend.toggleRelationship('HAS_ENTRY');
    expect(surface.links).toEqual([1, 2]);
    expectClose(surface.linkWidths, [17.6 * 0.2]);
    expect(surface.log).not.toContain('setPointPositions');
    expect(surface.log).toContain('render');
    expect(legend.relationshipRows.map((row) => [row.text, row.pressed])).toEqual([
      ['Has entry (2)', false],
      ['Imports (1)', true],
    ]);
    legend.toggleRelationship('HAS_ENTRY');
    expect(surface.links).toEqual([0, 1, 0, 2, 1, 2]);
  });

  it('keeps a hidden relationship type hidden across a render', () => {
    const { viz, surface, legend } = mount();
    viz.render(P1);
    legend.toggleRelationship('HAS_ENTRY');
    viz.render(P1);
    expect(surface.links).toEqual([]);
    expect(legend.relationshipRows.map((row) => row.pressed)).toEqual([false]);
  });
});

describe('GraphVisualizer tooltips', () => {
  it('shows TYPE: name just above a hovered point, and hides on mouse-out', () => {
    const { viz, events, tooltip } = mount();
    viz.render(P1);
    events.onPointMouseOver(1, [10, 20]);
    expect(tooltip.shown).toEqual({ text: 'FILE: f.ts', left: 20, top: 60 - 15 - 6 });
    expect(tooltip.visible).toBe(true);
    events.onPointMouseOut();
    expect(tooltip.visible).toBe(false);
  });

  it('hides for the synthetic root, an absent point or a hidden type', () => {
    const { viz, events, tooltip, legend } = mount();
    viz.render(P3);
    const shown = (): void => {
      events.onPointMouseOver(1, [1, 1]);
      expect(tooltip.visible).toBe(true);
    };
    shown();
    events.onPointMouseOver(0, [2048, 2048]);
    expect(tooltip.visible).toBe(false);
    shown();
    events.onPointMouseOver(2, [NaN, NaN]);
    expect(tooltip.visible).toBe(false);
    shown();
    legend.toggleNode('FILE');
    events.onPointMouseOver(2, [1, 1]);
    expect(tooltip.visible).toBe(false);
  });

  it('hides for a tombstone', () => {
    const { viz, events, tooltip } = mount();
    viz.render(P1);
    viz.applyDelta(delta({ removedNodeIds: ['f'] }));
    events.onPointMouseOver(2, [1, 1]);
    expect(tooltip.visible).toBe(true);
    events.onPointMouseOver(1, [1, 1]);
    expect(tooltip.visible).toBe(false);
  });

  it("anchors a link tooltip at the endpoints' live midpoint, and hides on mouse-out", () => {
    const { viz, surface, events, tooltip } = mount();
    viz.render(P1);
    surface.live.splice(0, 4, 300, 400, 100, 200);
    events.onLinkMouseOver(0);
    expect(tooltip.shown).toEqual({ text: 'Has entry: d → f.ts', left: 400, top: 900 - 6 });
    events.onLinkMouseOut();
    expect(tooltip.visible).toBe(false);
  });

  it('reads a link hover index against the visible links, not all of them', () => {
    const { viz, surface, events, tooltip, legend } = mount();
    viz.render(P1);
    viz.applyDelta(edgeOnly(IMPORTS));
    legend.toggleRelationship('HAS_ENTRY');
    // round two (review a10): the endpoints come from the visible link too, not from all links.
    surface.live.splice(2, 4, 100, 200, 300, 600);
    events.onLinkMouseOver(0);
    expect(tooltip.shown).toEqual({ text: 'Imports: f.ts → g.ts', left: 400, top: 1200 - 6 });
  });

  it('hides for a link with an absent endpoint or an index past the visible links', () => {
    const { viz, surface, events, tooltip } = mount();
    viz.render(P1);
    events.onLinkMouseOver(1);
    expect(tooltip.visible).toBe(true);
    events.onLinkMouseOver(2);
    expect(tooltip.visible).toBe(false);
    events.onLinkMouseOver(1);
    surface.live[4] = NaN;
    events.onLinkMouseOver(1);
    expect(tooltip.visible).toBe(false);
  });
});

describe('GraphVisualizer clicks', () => {
  it('hands a click on a live, shown node to onNodeClick', () => {
    const { viz, events, clicks } = mount();
    viz.render(P1);
    events.onPointClick(1);
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toBe(F);
  });

  it('ignores a click on the synthetic root, a hidden type or a tombstone', () => {
    const { viz, events, clicks, legend } = mount();
    viz.render(P3);
    events.onPointClick(0);
    legend.toggleNode('FILE');
    events.onPointClick(1);
    viz.render(P1);
    legend.toggleNode('FILE');
    viz.applyDelta(delta({ removedNodeIds: ['g'] }));
    events.onPointClick(2);
    expect(clicks).toEqual([]);
    events.onPointClick(1);
    expect(clicks).toEqual([F]);
  });

  it('needs no onNodeClick', () => {
    const box: { events?: SurfaceEvents } = {};
    const viz = new GraphVisualizer(
      (events) => {
        box.events = events;
        return new FakeSurface();
      },
      { legend: new FakeLegend(), tooltip: new FakeTooltip() },
      { seed: 1 },
    );
    viz.render(P1);
    expect(() => box.events?.onPointClick(1)).not.toThrow();
  });
});

describe('GraphVisualizer camera', () => {
  it('follows the settling simulation, throttled, until the user zooms; a render follows again', () => {
    const { viz, surface, events, setNow } = mount();
    viz.render(P1);
    setNow(300);
    events.onSimulationTick();
    expect(surface.fits).toEqual([250]);
    setNow(400);
    events.onSimulationTick();
    expect(surface.fits).toEqual([250]);
    events.onSimulationEnd();
    expect(surface.fits).toEqual([250, undefined]);
    events.onZoomStart(undefined, false);
    setNow(1000);
    events.onSimulationTick();
    expect(surface.fits).toEqual([250, undefined, 250]);
    events.onZoomStart(undefined, true);
    setNow(10_000);
    events.onSimulationTick();
    events.onSimulationEnd();
    expect(surface.fits).toEqual([250, undefined, 250]);
    viz.render(P1);
    setNow(20_000);
    events.onSimulationTick();
    expect(surface.fits).toEqual([250, undefined, 250, 250]);
  });

  // round two (review b3): an unbound performance.now throws ERR_INVALID_THIS, so it is wrapped.
  it('defaults the camera clock to performance.now', () => {
    const box: { events?: SurfaceEvents } = {};
    const surface = new FakeSurface();
    const viz = new GraphVisualizer(
      (events) => {
        box.events = events;
        return surface;
      },
      { legend: new FakeLegend(), tooltip: new FakeTooltip() },
      { seed: 1 },
    );
    viz.render(P1);
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const events = box.events;
    if (events === undefined) throw new Error('makeSurface was not called');
    events.onSimulationTick();
    expect(now).toHaveBeenCalled();
    expect(surface.fits).toEqual([250]);
  });

  it('fitView reframes the surface and dispose destroys it', () => {
    const { viz, surface } = mount();
    viz.render(P1);
    viz.fitView();
    expect(surface.fits).toEqual([undefined]);
    viz.dispose();
    expect(surface.destroyed).toBe(true);
  });
});

// U3.1.1 part 3 (controller decision 32): a theme's node colours reach the points and the legend.
const colours = (...hex: string[]): number[] =>
  Array.from(Float32Array.from(hex.flatMap((value) => [...hexToRgba(value)])));
const swatches = (legend: FakeLegend): string[] => legend.nodeRows.map((row) => row.color);

describe('GraphVisualizer.setNodeColors', () => {
  const THEME = {
    nodeColors: { FILE: '#336699', DIRECTORY: '#000000' },
    defaultNodeColor: '#ff0000',
  };

  it('hands the surface nothing before the first render, which then draws in them', () => {
    const { viz, surface, legend } = mount();
    viz.setNodeColors(THEME);
    expect(surface.log).toEqual([]);
    expect(legend.nodeRows).toEqual([]);
    viz.render(P1);
    expect(surface.colors).toEqual(colours('#000000', '#336699', '#336699'));
    expect(swatches(legend)).toEqual(['#000000', '#336699']);
  });

  it('recolours what is drawn at once, and only that: no move, no links, no simulation, no camera', () => {
    const { viz, surface, legend } = mount();
    viz.render(P1);
    surface.live[2] = 500;
    const before = { positions: surface.positions, starts: surface.starts.length };
    surface.log.length = 0;
    viz.setNodeColors(THEME);
    expect(surface.log).toEqual(['setPointColors', 'render']);
    expect(surface.colors).toEqual(colours('#000000', '#336699', '#336699'));
    expect(swatches(legend)).toEqual(['#000000', '#336699']);
    expect(surface.live[2]).toBe(500);
    expect(surface.positions).toBe(before.positions);
    expect(surface.starts).toHaveLength(before.starts);
  });

  it('keeps them for later deltas and renders, until the next ones', () => {
    const { viz, surface } = mount();
    viz.setNodeColors(THEME);
    viz.render(P1);
    viz.applyDelta(delta({ addedNodes: [node('m', 'MODULE')], addedEdges: [entry('d', 'm')] }));
    expect(surface.colors.slice(12)).toEqual(colours('#ff0000'));
    viz.render(P3);
    // The synthetic centre has no type of its own, so it takes the default.
    expect(surface.colors).toEqual(colours('#ff0000', '#336699', '#336699'));
    viz.setNodeColors(REGISTRY_NODE_COLORS);
    expect(surface.colors).toEqual(Array.from(layoutPayload(P3, { seed: 7 }).colors));
  });

  it('leaves a hidden type hidden and its legend row unpressed', () => {
    const { viz, surface, legend } = mount();
    viz.render(P1);
    legend.toggleNode('FILE');
    viz.setNodeColors(THEME);
    expect(legend.nodeRows.map((row) => [row.key, row.color, row.pressed])).toEqual([
      ['DIRECTORY', '#000000', true],
      ['FILE', '#336699', false],
    ]);
    expect(surface.positions.slice(2).every(Number.isNaN)).toBe(true);
    legend.toggleNode('FILE');
    expect(surface.positions.some(Number.isNaN)).toBe(false);
    expect(swatches(legend)).toEqual(['#000000', '#336699']);
  });

  it('logs a surface that fails to recolour, and does nothing without one', () => {
    const error = vi.spyOn(console, 'error').mockReturnValue(undefined);
    const m = mount();
    m.viz.render(P1);
    m.surface.failOn = 'setPointColors';
    expect(() => m.viz.setNodeColors(THEME)).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
    const views = { legend: new FakeLegend(), tooltip: new FakeTooltip() };
    const broken = new GraphVisualizer(failingSurface, views, { seed: 1 });
    expect(() => broken.setNodeColors(THEME)).not.toThrow();
    expect(views.legend.nodeRows).toEqual([]);
  });
});
