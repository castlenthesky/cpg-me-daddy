// SEAT (U2b.1 part 2a, BMO-35): the legend rows from
// 21754b4:packages/graph-visualizer/src/legend.ts, as data. The DOM writer that turns a row into a
// button is part 2b.

/** One legend row: what the button shows, its tooltip, its swatch, and its aria-pressed state. */
export interface LegendRow {
  /** The type key reported to `onToggle`. */
  readonly key: string;
  /** `Label (count)`. */
  readonly text: string;
  /** `Click to hide label` while shown, `Click to show label` while hidden (label lower-cased). */
  readonly title: string;
  /** The swatch colour from the registry. */
  readonly color: string;
  /** `aria-pressed`: true while the type is shown. */
  readonly pressed: boolean;
}

function seat(what: string): never {
  throw new Error(`SEAT: ${what} is not built yet (U2b.1 part 2a)`);
}

/** How many times each type occurs. */
export function countByType(_types: readonly string[]): Map<string, number> {
  return seat('countByType');
}

/** One row per NODE_TYPES entry present in `types`, in registry order; a type not in it gets no row. */
export function nodeLegendRows(
  _types: readonly string[],
  _hidden: ReadonlySet<string>,
): LegendRow[] {
  return seat('nodeLegendRows');
}

/** One row per relationship key present, sorted; label and colour from the relationship registry. */
export function relationshipLegendRows(
  _edgeTypeKeys: readonly string[],
  _hidden: ReadonlySet<string>,
): LegendRow[] {
  return seat('relationshipLegendRows');
}
