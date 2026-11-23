// SEAT (U2b.1 part 2b, BMO-35): the DOM halves ported from 21754b4:packages/graph-visualizer/src/legend.ts
// (appendLegendItem) and visualizer.ts (the constructor's elements, showTooltip).

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

/**
 * Appends the views' elements to `container` (after anything already in it): the component
 * styles, the fit-view button (calls `onFitView`), `#legend-container` holding `#legend` and
 * `#relationship-legend`, and the hidden `#node-tooltip`. Returns the views `GraphVisualizer` takes.
 */
export function mountGraphViews<E extends ViewElement<E>>(
  _doc: ViewDocument<E>,
  _container: E,
  _onFitView: () => void,
): GraphViews {
  throw new Error('SEAT: mountGraphViews is U2b.1 part 2b');
}
