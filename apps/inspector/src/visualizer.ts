// REAL (U2b.1 part 2a, BMO-35): ported from 21754b4:packages/graph-visualizer/src/visualizer.ts (ADAPT).

import type { Graph } from '@cosmos.gl/graph' with { 'resolution-mode': 'import' };
import type { GraphDelta, GraphNode, GraphPayload } from '@cpg/model';
import { BufferStore, deltaParents } from './buffer-store';
import { CAMERA_FOLLOW_THROTTLE_MS, CameraFollow } from './camera';
import { EdgeStore, visibleLinks, type LinkBuffers } from './edge-store';
import {
  createMulberry32,
  DEFAULT_FALLBACK_PARENT_EDGE_TYPES,
  DEFAULT_HIERARCHY_EDGE_TYPE,
  layoutPayload,
} from './layout';
import { nodeLegendRows, relationshipLegendRows, type LegendRow } from './legend';
import { REGISTRY_NODE_COLORS, type NodeColors } from './node-types';
import { relationshipKey } from './relationship-types';
import type { DrawnGraph } from './render-report';
import { linkTooltipText, nodeTooltipText, TOOLTIP_GAP_PX } from './tooltip';

/** The slice of cosmos.gl's Graph the visualizer calls; part 2b passes a real Graph. */
export type GraphSurface = Pick<
  Graph,
  | 'setPointPositions'
  | 'setPointColors'
  | 'setPointSizes'
  | 'setLinks'
  | 'setLinkWidths'
  | 'setPinnedPoints'
  | 'render'
  | 'start'
  | 'unpause'
  | 'fitView'
  | 'fitViewByPointPositions'
  | 'getPointPositions'
  | 'spaceToScreenPosition'
  | 'spaceToScreenRadius'
  | 'getPointRadiusByIndex'
  | 'destroy'
>;

/** The cosmos.gl config callbacks the visualizer handles; part 2b spreads them into the config. */
export interface SurfaceEvents {
  readonly onSimulationTick: () => void;
  readonly onSimulationEnd: () => void;
  readonly onZoomStart: (event: unknown, userDriven: boolean) => void;
  readonly onPointMouseOver: (index: number, pointPosition: [number, number]) => void;
  readonly onPointMouseOut: () => void;
  readonly onPointClick: (index: number) => void;
  readonly onLinkMouseOver: (linkIndex: number) => void;
  readonly onLinkMouseOut: () => void;
  /** A position transition ended; `interrupted` when another replaced it (sprint 26, decision 85). */
  readonly onTransitionEnd: (interrupted: boolean) => void;
}

/** Where the two legends go (part 2b writes the buttons); `onToggle` gets a row's key. */
export interface LegendView {
  showNodeTypes(rows: readonly LegendRow[], onToggle: (key: string) => void): void;
  showRelationshipTypes(rows: readonly LegendRow[], onToggle: (key: string) => void): void;
}

/** The one tooltip both hovers write into; `left`/`top` are screen pixels. */
export interface TooltipView {
  show(text: string, left: number, top: number): void;
  hide(): void;
}

export interface GraphViews {
  readonly legend: LegendView;
  readonly tooltip: TooltipView;
}

export interface GraphVisualizerOptions {
  /** Seeds the layout and the jitter of delta-added nodes (re-seeded on every render). */
  readonly seed: number;
  readonly hierarchyEdgeType?: string;
  readonly fallbackParentEdgeTypes?: ReadonlySet<string>;
  /** A click on a live, shown node; never the synthetic root, a tombstone or a hidden type. */
  readonly onNodeClick?: (node: GraphNode) => void;
  /** The camera throttle's clock; default performance.now. */
  readonly now?: () => number;
}

const EMPTY_LINKS: LinkBuffers = {
  links: new Float32Array(0),
  linkWidths: new Float32Array(0),
  linkEdges: [],
};

function isFiniteNumber(value: number | undefined): value is number {
  return Number.isFinite(value);
}

function toggleSet(set: Set<string>, key: string): void {
  if (set.has(key)) set.delete(key);
  else set.add(key);
}

/**
 * Renders payloads and deltas onto a surface. If `makeSurface` throws, construction still
 * completes (the page must still announce ready) and every later call logs and returns. Hidden
 * node and relationship types persist across renders.
 */
export class GraphVisualizer {
  private readonly surface: GraphSurface | undefined;
  private readonly views: GraphViews;
  private readonly seed: number;
  private readonly hierarchyEdgeType: string;
  private readonly fallbackParentEdgeTypes: ReadonlySet<string>;
  private readonly onNodeClick: ((node: GraphNode) => void) | undefined;
  private readonly camera: CameraFollow;
  private readonly points = new BufferStore();
  private readonly edges = new EdgeStore();
  private readonly hiddenTypes = new Set<string>();
  private readonly hiddenEdgeTypes = new Set<string>();
  private nodeColors: NodeColors = REGISTRY_NODE_COLORS;
  private random: () => number;
  private allLinks: LinkBuffers = EMPTY_LINKS;
  // What cosmos.gl was last handed: a link index from a hover means an offset into this, never allLinks.
  private shownLinks: LinkBuffers = EMPTY_LINKS;
  private settlePending = false;

  constructor(
    makeSurface: (events: SurfaceEvents) => GraphSurface,
    views: GraphViews,
    options: GraphVisualizerOptions,
  ) {
    this.views = views;
    this.seed = options.seed;
    this.hierarchyEdgeType = options.hierarchyEdgeType ?? DEFAULT_HIERARCHY_EDGE_TYPE;
    this.fallbackParentEdgeTypes =
      options.fallbackParentEdgeTypes ?? DEFAULT_FALLBACK_PARENT_EDGE_TYPES;
    this.onNodeClick = options.onNodeClick;
    this.camera = new CameraFollow(options.now ?? (() => performance.now()));
    this.random = createMulberry32(this.seed);

    const events: SurfaceEvents = {
      onSimulationTick: () => {
        if (this.camera.tick()) this.surface?.fitView(CAMERA_FOLLOW_THROTTLE_MS);
      },
      onSimulationEnd: () => {
        if (this.camera.following) this.surface?.fitView();
      },
      onZoomStart: (_event, userDriven) => this.camera.zoomStarted(userDriven),
      onPointMouseOver: (index, pos) => this.showPointTooltip(index, pos),
      onPointMouseOut: () => this.views.tooltip.hide(),
      onPointClick: (index) => this.handlePointClick(index),
      onLinkMouseOver: (linkIndex) => this.showLinkTooltip(linkIndex),
      onLinkMouseOut: () => this.views.tooltip.hide(),
      onTransitionEnd: (interrupted) => this.handleTransitionEnd(interrupted),
    };

    try {
      this.surface = makeSurface(events);
    } catch (error) {
      console.error('@cpg/inspector: failed to construct GraphSurface', error);
    }
  }

  render(payload: GraphPayload): void {
    const surface = this.surface;
    if (!surface) {
      console.error('@cpg/inspector: got a payload but surface failed to initialize');
      return;
    }
    try {
      const layout = layoutPayload(payload, {
        seed: this.seed,
        hierarchyEdgeType: this.hierarchyEdgeType,
        fallbackParentEdgeTypes: this.fallbackParentEdgeTypes,
      });
      this.random = createMulberry32(this.seed);
      this.points.load(layout, payload);
      this.points.recolour(this.nodeColors);
      this.edges.replace(payload.edges);
      this.views.tooltip.hide();
      this.settlePending = false;
      this.pushBuffers(surface);
      surface.setPinnedPoints([0]);
      surface.render();
      surface.fitViewByPointPositions(Array.from(layout.positions), 0);
      this.camera.reset();
      surface.start(1);
      this.refreshNodeLegend(surface);
      this.refreshRelationshipLegend(surface);
    } catch (error) {
      console.error('@cpg/inspector: failed to render graph', error);
    }
  }

  /**
   * Draws a delta where the picture already is (controller decision 85). No early return on node-empty
   * deltas, so edge-only deltas are delivered (fixes archive :290). Live positions are synced first, so
   * a surviving point stays where the simulation left it; a new point starts next to its parent
   * (deltaParents); a removed point's position becomes NaN, which cosmos.gl fades out in place on the
   * next render. Then the buffers are pushed, point 0 re-pinned and `render()` called, starting that
   * transition. Neither `unpause()` nor `start()` is called here: either ends the transition at once,
   * cutting the fade. The simulation restarts at alpha 0.1 (never 1) when a transition a delta began
   * ends uninterrupted (`onTransitionEnd(false)`): once for any number of deltas, and never for one
   * after a full render or a legend toggle. The camera is not moved: no `fitViewByPointPositions`, no
   * follow reset; the throttled follow (`fitView(250)`) glides while the user has not zoomed.
   */
  applyDelta(delta: GraphDelta): void {
    const surface = this.surface;
    if (!surface) {
      console.error('@cpg/inspector: got a delta but surface failed to initialize');
      return;
    }
    try {
      // Sync live simulation positions first so existing points never snap back to their seeds.
      this.points.syncLive(surface.getPointPositions());
      const parents = deltaParents(
        delta.addedEdges,
        this.hierarchyEdgeType,
        this.fallbackParentEdgeTypes,
      );
      this.points.applyDelta(delta, parents, this.random);
      this.edges.apply(delta.removedNodeIds, delta.addedEdges);
      this.pushBuffers(surface);
      surface.setPinnedPoints([0]);
      surface.render();
      this.settlePending = true;
      this.refreshNodeLegend(surface);
      this.refreshRelationshipLegend(surface);
    } catch (error) {
      console.error('@cpg/inspector: failed to apply graph delta', error);
    }
  }

  /**
   * Draws the points and the node legend's swatches in `colors`, now and on every later render and
   * delta (controller decision 32). It only recolours: positions, links, hidden types, the camera and
   * the simulation are untouched, and before the first render it hands the surface nothing.
   */
  setNodeColors(colors: NodeColors): void {
    const surface = this.surface;
    if (!surface) return;
    this.nodeColors = colors;
    this.points.recolour(colors);
    if (this.points.length === 0) return;
    try {
      surface.setPointColors(this.points.colors);
      surface.render();
      this.refreshNodeLegend(surface);
    } catch (error) {
      console.error('@cpg/inspector: failed to recolour graph', error);
    }
  }

  fitView(): void {
    this.surface?.fitView();
  }

  /**
   * What is drawn now, for the render-report: a payload id is drawn when it has a live point (never
   * the synthetic root), and edgeCount is the edges drawn, legend toggles ignored (part 3a-i).
   */
  drawn(): DrawnGraph {
    return {
      isDrawn: (id) => this.points.liveIndex(id) !== undefined,
      edgeCount: this.allLinks.linkEdges.length,
    };
  }

  dispose(): void {
    this.surface?.destroy();
  }

  private pushBuffers(surface: GraphSurface): void {
    this.allLinks = this.edges.build((id) => this.points.liveIndex(id), this.points.sizes);
    surface.setPointColors(this.points.colors);
    surface.setPointSizes(this.points.sizes);
    this.pushLinks(surface);
    surface.setPointPositions(this.points.masked(this.hiddenTypes));
  }

  private pushLinks(surface: GraphSurface): void {
    this.shownLinks = visibleLinks(this.allLinks, this.hiddenEdgeTypes);
    surface.setLinks(this.shownLinks.links);
    surface.setLinkWidths(this.shownLinks.linkWidths);
  }

  private refreshNodeLegend(surface: GraphSurface): void {
    this.views.legend.showNodeTypes(
      nodeLegendRows(this.points.liveTypes(), this.hiddenTypes, this.nodeColors),
      (key) => this.toggleNodeType(surface, key),
    );
  }

  private refreshRelationshipLegend(surface: GraphSurface): void {
    this.views.legend.showRelationshipTypes(
      relationshipLegendRows(
        this.allLinks.linkEdges.map((edge) => relationshipKey(edge.type)),
        this.hiddenEdgeTypes,
      ),
      (key) => this.toggleRelationshipType(surface, key),
    );
  }

  private toggleNodeType(surface: GraphSurface, key: string): void {
    // Snapshot live positions before the masked push turns the hidden ones NaN (the archive
    // snapshotted after toggling, so a just-hidden type came back at its seed).
    this.points.syncLive(surface.getPointPositions());
    toggleSet(this.hiddenTypes, key);
    this.settlePending = false;
    surface.setPointPositions(this.points.masked(this.hiddenTypes));
    surface.render();
    surface.unpause();
    surface.start(0.1);
    this.refreshNodeLegend(surface);
  }

  private handleTransitionEnd(interrupted: boolean): void {
    if (interrupted || !this.settlePending) return;
    this.settlePending = false;
    const surface = this.surface;
    if (!surface) return;
    try {
      surface.unpause();
      surface.start(0.1);
    } catch (error) {
      console.error('@cpg/inspector: failed to settle graph after delta', error);
    }
  }

  private toggleRelationshipType(surface: GraphSurface, key: string): void {
    toggleSet(this.hiddenEdgeTypes, key);
    this.pushLinks(surface);
    surface.render();
    this.refreshRelationshipLegend(surface);
  }

  private showPointTooltip(index: number, pointPosition: [number, number]): void {
    const node = this.points.nodeAt(index);
    if (
      !this.surface ||
      !node ||
      this.hiddenTypes.has(node.type) ||
      !Number.isFinite(pointPosition[0])
    ) {
      this.views.tooltip.hide();
      return;
    }
    const [screenX, screenY] = this.surface.spaceToScreenPosition(pointPosition);
    const radius = this.surface.spaceToScreenRadius(this.surface.getPointRadiusByIndex(index) ?? 0);
    this.views.tooltip.show(nodeTooltipText(node), screenX, screenY - radius - TOOLTIP_GAP_PX);
  }

  private showLinkTooltip(linkIndex: number): void {
    const edge = this.shownLinks.linkEdges[linkIndex];
    if (!this.surface || !edge) {
      this.views.tooltip.hide();
      return;
    }
    const sourceIndex = Number(this.shownLinks.links[linkIndex * 2]);
    const targetIndex = Number(this.shownLinks.links[linkIndex * 2 + 1]);
    const live = this.surface.getPointPositions();
    const x1 = live[sourceIndex * 2];
    const y1 = live[sourceIndex * 2 + 1];
    const x2 = live[targetIndex * 2];
    const y2 = live[targetIndex * 2 + 1];
    if (!isFiniteNumber(x1) || !isFiniteNumber(y1) || !isFiniteNumber(x2) || !isFiniteNumber(y2)) {
      this.views.tooltip.hide();
      return;
    }
    const [screenX, screenY] = this.surface.spaceToScreenPosition([(x1 + x2) / 2, (y1 + y2) / 2]);
    this.views.tooltip.show(
      linkTooltipText(edge, this.points.node(edge.source), this.points.node(edge.target)),
      screenX,
      screenY - TOOLTIP_GAP_PX,
    );
  }

  private handlePointClick(index: number): void {
    const node = this.points.nodeAt(index);
    if (!node || this.hiddenTypes.has(node.type)) return;
    this.onNodeClick?.(node);
  }
}
