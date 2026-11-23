// SEAT (U2b.1 part 1, BMO-35): the seeded radial seed layout, ported from
// 21754b4:packages/graph-visualizer/src/layout.ts with a seed threaded through both Math.random()
// sites. Not built yet: every export is a placeholder.

import type { GraphPayload } from '@cpg/model';

const seat = (what: string): Error =>
  new Error(`SEAT: ${what} is not built yet (U2b.1 part 1, BMO-35)`);

// SEAT
export const LINK_DISTANCE: number = Number.NaN;
// SEAT
export const SPACE_SIZE: number = Number.NaN;
// SEAT
export const ROOT_POINT_SIZE: number = Number.NaN;
// SEAT
export const DEFAULT_HIERARCHY_EDGE_TYPE: string = '';
// SEAT
export const DEFAULT_FALLBACK_PARENT_EDGE_TYPES: ReadonlySet<string> = new Set();

// SEAT
export function childPointSize(_parentSize: number): number {
  throw seat('childPointSize');
}

// SEAT
export function linkWidthForSizes(_sizeA: number, _sizeB: number): number {
  throw seat('linkWidthForSizes');
}

export interface LayoutOptions {
  /** Required: the only source of jitter. The same payload and seed give byte-identical buffers. */
  readonly seed: number;
  /** Edge type that seeds the tree; default `DEFAULT_HIERARCHY_EDGE_TYPE` (`'HAS_ENTRY'`). */
  readonly hierarchyEdgeType?: string;
  /** Edge types that may adopt a still-parentless node; default `DEFAULT_FALLBACK_PARENT_EDGE_TYPES`. */
  readonly fallbackParentEdgeTypes?: ReadonlySet<string>;
}

export interface LayoutResult {
  /** x, y per point. */
  readonly positions: Float32Array;
  /** r, g, b, a per point. */
  readonly colors: Float32Array;
  /** Point-index pairs. */
  readonly links: Float32Array;
  /** Node type per point. */
  readonly types: readonly string[];
  /** Node id per point, parallel to positions/colors/types. */
  readonly ids: readonly string[];
  /** Point size per point. */
  readonly sizes: Float32Array;
  /** Width per link (one entry per pair in `links`). */
  readonly linkWidths: Float32Array;
}

// SEAT
export function layoutPayload(_payload: GraphPayload, _options: LayoutOptions): LayoutResult {
  throw seat('layoutPayload');
}
