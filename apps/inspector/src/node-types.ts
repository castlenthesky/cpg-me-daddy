// REAL (U2b.1 part 1, BMO-35): ported from 21754b4:packages/graph-visualizer/src/nodeTypes.ts.
//
// Single source of truth for node-type colour, shared by the point-colour
// buffer built in `layoutPayload` (layout.ts) and the node legend swatches in
// the renderer (U2b part 2) — so the two can never drift apart. Keys follow
// the CPG schema (`packages/model/src/schema`, `docs/outline/04-schema.yaml`):
// the archive's `directory`/`file` were renamed to `DIRECTORY`/`FILE`, and its
// `LOCAL` row was dropped because `LOCAL` is not a schema label.

import type { ThemeSnapshot } from '@cpg/model';

export type Rgba = readonly [number, number, number, number];

/** The node colours a C-EXT theme carries (controller decision 32). */
export type NodeColors = Pick<ThemeSnapshot, 'nodeColors' | 'defaultNodeColor'>;

export interface NodeTypeDescriptor {
  readonly key: string;
  readonly label: string;
  readonly color: string;
}

export const NODE_TYPES: readonly NodeTypeDescriptor[] = [
  { key: 'DIRECTORY', label: 'Directories', color: '#ff9933' },
  { key: 'FILE', label: 'Files', color: '#4db3ff' },
  // CPG code-tier node labels from the schema (`packages/model/src/schema`,
  // `docs/outline/04-schema.yaml`), keeping the archive palette verbatim.
  { key: 'METHOD', label: 'Methods', color: '#4FC1FF' },
  { key: 'TYPE_DECL', label: 'Types', color: '#4EC9B0' },
  { key: 'CALL', label: 'Calls', color: '#CE9178' },
  { key: 'IMPORT', label: 'Imports', color: '#C586C0' },
  // Cross-file symbols. Appended last so the existing legend order is
  // unchanged. `#DCDCAA` is Dark+'s function-declaration yellow — semantically
  // "the named thing being declared", which is exactly what a SYMBOL is, and
  // the only warm-light hue in this palette not already spent.
  { key: 'SYMBOL', label: 'Symbols', color: '#DCDCAA' },
];

export function hexToRgba(hex: string): Rgba {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.substring(0, 2), 16) / 255;
  const g = Number.parseInt(value.substring(2, 4), 16) / 255;
  const b = Number.parseInt(value.substring(4, 6), 16) / 255;
  return [r, g, b, 1];
}

const DEFAULT_NODE_COLOR_HEX = '#999999';
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function isHexColor(value: string | undefined): value is string {
  return value !== undefined && HEX_COLOR.test(value);
}

// Points whose type isn't in NODE_TYPES (including the synthetic multi-root
// anchor `placeNode` introduces — see layout.ts) fall back to this neutral grey
// rather than being dropped.
export const DEFAULT_NODE_COLOR: Rgba = hexToRgba(DEFAULT_NODE_COLOR_HEX);

export const NODE_TYPE_COLORS: ReadonlyMap<string, Rgba> = new Map(
  NODE_TYPES.map((nodeType) => [nodeType.key, hexToRgba(nodeType.color)]),
);

// Shared by the renderer (U2b part 2, as the cosmos.gl `linkDefaultColor`
// config value) and layout.ts (as the fallback for an edge whose source node
// isn't in NODE_TYPE_COLORS, e.g. the synthetic multi-root anchor) so the two
// can't drift apart — same rationale as NODE_TYPE_COLORS above.
export const DEFAULT_LINK_COLOR_HEX: string = '#4b4b4b';

/**
 * The registry's own colours in a theme's form: every NODE_TYPES row, and DEFAULT_NODE_COLOR as
 * `#rrggbb`. The VS Code host sends these, so the panel and the browser draw the same picture
 * (controller decision 32).
 */
export const REGISTRY_NODE_COLORS: NodeColors = {
  nodeColors: Object.fromEntries(NODE_TYPES.map((nodeType) => [nodeType.key, nodeType.color])),
  defaultNodeColor: DEFAULT_NODE_COLOR_HEX,
};

/**
 * The `#rrggbb` a node of `type` is drawn in under `colors`: its own entry in `nodeColors`, else
 * `defaultNodeColor`, else the registry's default. A value that is not `#rrggbb` (either case) counts
 * as absent, so a theme can recolour the picture and never break it.
 */
export function nodeTypeColor(colors: NodeColors, type: string): string {
  if (Object.hasOwn(colors.nodeColors, type)) {
    const own = colors.nodeColors[type];
    if (isHexColor(own)) return own;
  }
  if (isHexColor(colors.defaultNodeColor)) return colors.defaultNodeColor;
  return DEFAULT_NODE_COLOR_HEX;
}
