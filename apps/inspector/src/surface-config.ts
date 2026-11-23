// REAL (U2b.1 part 2b, BMO-35): the cosmos.gl config from 21754b4:packages/graph-visualizer/src/visualizer.ts
// (the constructor's `new Graph(container, { ... })`).

import type { GraphConfig } from '@cosmos.gl/graph' with { 'resolution-mode': 'import' };
import { LINK_DISTANCE, SPACE_SIZE } from './layout';
import { DEFAULT_LINK_COLOR_HEX } from './node-types';
import type { SurfaceEvents } from './visualizer';

/**
 * The config the page constructs cosmos.gl's Graph with: the archive's physics, sizing and hover
 * settings, with the visualizer's `events` as the callbacks. Its colour literals are the archive's,
 * kept under stop-list 45.
 */
export function graphConfig(events: SurfaceEvents): GraphConfig {
  return {
    backgroundColor: '#1e1e1e',
    spaceSize: SPACE_SIZE,
    randomSeed: 'cpg-me-daddy',
    // We frame the camera ourselves once real data exists (see GraphVisualizer.render's
    // fitViewByPointPositions) — fitViewOnInit would instead frame the empty canvas at init.
    fitViewOnInit: false,
    pointDefaultSize: 8,
    linkDefaultColor: DEFAULT_LINK_COLOR_HEX,
    // Each link's RGB is interpolated from its two endpoint points' own colours (set via
    // setPointColors) instead of a flat per-link colour — a directory-to-directory edge reads as
    // solid directory orange, a directory-to-file edge fades from orange to blue. linkDefaultColor
    // above still supplies the alpha channel (and the RGB fallback for an untyped point).
    linkColorInterpolateFromEndpoints: true,
    simulationLinkDistance: LINK_DISTANCE,
    // The seed layout (see layout.ts) is already centred on spaceSize/2 — cosmos.gl's gravity
    // target — so gravity only needs to gently compact the tree, not haul it in from a corner.
    simulationGravity: 0.15,
    // Higher than the 1.0 default so the physics visibly reshapes the jittered seed (unconnected
    // branches pushing apart into organic clusters) instead of barely moving it.
    simulationRepulsion: 1.4,
    // Dense sibling clusters (many points with no link between them, all pulled toward the same
    // parent) settle by pushing apart on contact instead of relying solely on many-body repulsion
    // to keep them separated.
    simulationCollision: 0.5,
    // Damps residual oscillation faster than the 0.85 default, working with simulationDecay below
    // to settle without overshooting.
    simulationFriction: 0.8,
    // Alpha decays as e^(-6.9 * tick / simulationDecay), so this settles in ~10s at 60fps — long
    // enough to actually see the layout reshape, well short of the 5000 default's ~83s.
    simulationDecay: 600,
    renderHoveredPointRing: true,
    hoveredPointRingColor: '#ffffff',
    hoveredPointCursor: 'pointer',
    hoveredLinkCursor: 'pointer',
    hoveredLinkColor: '#ffffff',
    hoveredLinkWidthIncrease: 2,
    // Spreads the visualizer's eight callbacks, including onPointClick (never the canvas-wide
    // onClick, which also fires on empty canvas clicks with an undefined index).
    ...events,
  };
}
