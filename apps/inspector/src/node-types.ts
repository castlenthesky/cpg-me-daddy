// SEAT (U2b.1 part 1, BMO-35): the node-type colour and label registry, ported from
// 21754b4:packages/graph-visualizer/src/nodeTypes.ts. Not built yet: every export is a placeholder.

export type Rgba = readonly [number, number, number, number];

export interface NodeTypeDescriptor {
  readonly key: string;
  readonly label: string;
  readonly color: string;
}

const seat = (what: string): Error =>
  new Error(`SEAT: ${what} is not built yet (U2b.1 part 1, BMO-35)`);

// SEAT
export const NODE_TYPES: readonly NodeTypeDescriptor[] = [];

// SEAT
export function hexToRgba(_hex: string): Rgba {
  throw seat('hexToRgba');
}

// SEAT
export const DEFAULT_NODE_COLOR: Rgba = [Number.NaN, Number.NaN, Number.NaN, Number.NaN];

// SEAT
export const NODE_TYPE_COLORS: ReadonlyMap<string, Rgba> = new Map();

// SEAT
export const DEFAULT_LINK_COLOR_HEX: string = '';
