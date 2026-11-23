// SEAT (U2b.1 part 2a, BMO-35): the cosmos.gl GraphVisualizer from
// 21754b4:packages/graph-visualizer/src/visualizer.ts (ADAPT), split into the buffer store, edge
// store, legend rows, tooltip text and camera controller it composes. It drives a GraphSurface (the
// slice of cosmos.gl's Graph it calls) and two views; the page that builds them is part 2b.

import type { GraphDelta, GraphNode, GraphPayload } from '@cpg/model';
import type { LegendRow } from './legend';

/**
 * The slice of cosmos.gl's `Graph` the visualizer calls (the signatures of `@cosmos.gl/graph`
 * 3.6.0).
 */
export interface GraphSurface {
  setPointPositions(pointPositions: Float32Array, dontRescale?: boolean): void;
  setPointColors(pointColors: Float32Array): void;
  setPointSizes(pointSizes: Float32Array): void;
  setLinks(links: Float32Array): void;
  setLinkWidths(linkWidths: Float32Array): void;
  setPinnedPoints(pinnedIndices: number[] | null): void;
  render(simulationAlpha?: number, transitionDuration?: number): void;
  start(alpha?: number): void;
  unpause(): void;
  fitView(duration?: number, padding?: number, enableSimulation?: boolean): void;
  fitViewByPointPositions(
    positions: number[],
    duration?: number,
    padding?: number,
    enableSimulation?: boolean,
  ): void;
  getPointPositions(): number[];
  spaceToScreenPosition(spacePosition: [number, number]): [number, number];
  spaceToScreenRadius(spaceRadius: number): number;
  getPointRadiusByIndex(index: number): number | undefined;
  destroy(): void;
}

/** The cosmos.gl config callbacks the visualizer handles (part 2b spreads them into the config). */
export interface SurfaceEvents {
  readonly onSimulationTick: () => void;
  readonly onSimulationEnd: () => void;
  readonly onZoomStart: (event: unknown, userDriven: boolean) => void;
  readonly onPointMouseOver: (index: number, pointPosition: [number, number]) => void;
  readonly onPointMouseOut: () => void;
  readonly onPointClick: (index: number) => void;
  readonly onLinkMouseOver: (linkIndex: number) => void;
  readonly onLinkMouseOut: () => void;
}

/** Where the two legends go (part 2b writes the buttons). `onToggle` gets a row's key. */
export interface LegendView {
  showNodeTypes(rows: readonly LegendRow[], onToggle: (key: string) => void): void;
  showRelationshipTypes(rows: readonly LegendRow[], onToggle: (key: string) => void): void;
}

/** The one tooltip a point hover and a link hover both write into; `left`/`top` in screen pixels. */
export interface TooltipView {
  show(text: string, left: number, top: number): void;
  hide(): void;
}

export interface GraphViews {
  readonly legend: LegendView;
  readonly tooltip: TooltipView;
}

export interface GraphVisualizerOptions {
  /** Seeds the layout, and the jitter of delta-added nodes (re-seeded on every render). */
  readonly seed: number;
  /** Default `DEFAULT_HIERARCHY_EDGE_TYPE`; must match the layout's. */
  readonly hierarchyEdgeType?: string;
  /** Default `DEFAULT_FALLBACK_PARENT_EDGE_TYPES`; must match the layout's. */
  readonly fallbackParentEdgeTypes?: ReadonlySet<string>;
  /** A click on a live, shown node; never the synthetic root, a tombstone or a hidden type. */
  readonly onNodeClick?: (node: GraphNode) => void;
  /** The camera throttle's clock; default `performance.now`. */
  readonly now?: () => number;
}

function seat(what: string): never {
  throw new Error(`SEAT: ${what} is not built yet (U2b.1 part 2a)`);
}

/**
 * Renders payloads and deltas onto a surface. `makeSurface` receives the event handlers and builds
 * the surface; if it throws, the visualizer is constructed anyway (the page must still announce
 * ready) and every later call logs with `console.error` and returns.
 *
 * render(payload):
 * - lays the payload out with the seed;
 * - pushes colours, sizes, the visible links (built from the edge set, never the layout's `links`)
 *   and positions (masked by the hidden node types);
 * - pins point 0, renders, frames the unmasked positions with no animation, resets the camera to
 *   following, and starts at alpha 1;
 * - hides the tooltip and refreshes both legends.
 * Hidden node and relationship types persist across renders.
 *
 * applyDelta(delta), which has no early return (an edge-only delta is delivered, C-EXT I-6):
 * - copies the live positions into the base;
 * - applies the node changes, then the edge changes;
 * - pushes colours, sizes, the visible links and the masked positions;
 * - re-pins point 0, renders, unpauses, starts at alpha 0.1;
 * - refreshes both legends.
 *
 * Errors thrown inside render or applyDelta are caught and logged with `console.error`.
 */
export class GraphVisualizer {
  constructor(
    _makeSurface: (events: SurfaceEvents) => GraphSurface,
    _views: GraphViews,
    _options: GraphVisualizerOptions,
  ) {
    seat('GraphVisualizer');
  }

  render(_payload: GraphPayload): void {
    seat('GraphVisualizer.render');
  }

  applyDelta(_delta: GraphDelta): void {
    seat('GraphVisualizer.applyDelta');
  }

  /** Reframes the camera on the current graph. */
  fitView(): void {
    seat('GraphVisualizer.fitView');
  }

  /** Releases the surface. */
  dispose(): void {
    seat('GraphVisualizer.dispose');
  }
}
