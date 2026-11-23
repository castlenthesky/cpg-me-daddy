// REAL (U2b.1 part 2b, BMO-35): the DOM halves ported from 21754b4:packages/graph-visualizer/src/legend.ts
// (appendLegendItem) and visualizer.ts (the constructor's elements, showTooltip).

import type { LegendRow } from './legend';
import { GRAPH_VISUALIZER_STYLES } from './styles';
import type { GraphViews } from './visualizer';

/** The style properties the views write. */
export interface ViewStyle {
  left: string;
  top: string;
  background: string;
}

/**
 * The slice of an HTMLElement the views use, with `E` the element type itself: `HTMLElement`
 * satisfies `ViewElement<HTMLElement>`, so the page passes the real DOM and tests pass a fake.
 */
export interface ViewElement<E> {
  id: string;
  className: string;
  title: string;
  hidden: boolean;
  textContent: string | null;
  innerHTML: string;
  readonly style: ViewStyle;
  setAttribute(name: string, value: string): void;
  append(...children: E[]): void;
  replaceChildren(...children: E[]): void;
  addEventListener(type: 'click', listener: () => void): void;
}

/** The slice of a Document the views use; `document` satisfies `ViewDocument<HTMLElement>`. */
export interface ViewDocument<E extends ViewElement<E>> {
  createElement(tagName: 'button' | 'div' | 'span' | 'style'): E;
}

const FIT_VIEW_SVG =
  '<svg viewBox="0 0 24 24"><path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" /></svg>';

function renderLegend<E extends ViewElement<E>>(
  doc: ViewDocument<E>,
  legendEl: E,
  rows: readonly LegendRow[],
  onToggle: (key: string) => void,
): void {
  const items = rows.map((row) => {
    const item = doc.createElement('button');
    item.setAttribute('type', 'button');
    item.className = 'legend-item';
    item.setAttribute('aria-pressed', String(row.pressed));
    item.title = row.title;

    const swatch = doc.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = row.color;

    const label = doc.createElement('span');
    label.className = 'legend-label';
    label.textContent = row.text;

    item.append(swatch, label);
    item.addEventListener('click', () => onToggle(row.key));
    return item;
  });
  legendEl.replaceChildren(...items);
}

/**
 * Appends the views' elements to `container` (after anything already in it): the component
 * styles, the fit-view button (calls `onFitView`), `#legend-container` holding `#legend` and
 * `#relationship-legend`, and the hidden `#node-tooltip`. Returns the views `GraphVisualizer` takes.
 */
export function mountGraphViews<E extends ViewElement<E>>(
  doc: ViewDocument<E>,
  container: E,
  onFitView: () => void,
): GraphViews {
  const styleEl = doc.createElement('style');
  styleEl.textContent = GRAPH_VISUALIZER_STYLES;

  const fitViewButton = doc.createElement('button');
  fitViewButton.setAttribute('type', 'button');
  fitViewButton.id = 'fit-view-button';
  fitViewButton.title = 'Zoom to fit';
  fitViewButton.innerHTML = FIT_VIEW_SVG;
  fitViewButton.addEventListener('click', onFitView);

  const legendContainer = doc.createElement('div');
  legendContainer.id = 'legend-container';

  const legendEl = doc.createElement('div');
  legendEl.id = 'legend';

  const relationshipLegendEl = doc.createElement('div');
  relationshipLegendEl.id = 'relationship-legend';

  legendContainer.append(legendEl, relationshipLegendEl);

  const tooltipEl = doc.createElement('div');
  tooltipEl.id = 'node-tooltip';
  tooltipEl.hidden = true;

  container.append(styleEl, fitViewButton, legendContainer, tooltipEl);

  return {
    legend: {
      showNodeTypes: (rows, onToggle) => renderLegend(doc, legendEl, rows, onToggle),
      showRelationshipTypes: (rows, onToggle) =>
        renderLegend(doc, relationshipLegendEl, rows, onToggle),
    },
    tooltip: {
      show: (text, left, top) => {
        tooltipEl.textContent = text;
        tooltipEl.style.left = `${left}px`;
        tooltipEl.style.top = `${top}px`;
        tooltipEl.hidden = false;
      },
      hide: () => {
        tooltipEl.hidden = true;
      },
    },
  };
}
