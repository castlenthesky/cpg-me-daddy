// The DOM halves the page mounts (BMO-35 line 2's legend and tooltip, as DOM): the elements the
// archived GraphVisualizer constructor created (21754b4 visualizer.ts:140-168), the legend row
// button (legend.ts appendLegendItem) and the tooltip writes (visualizer.ts showTooltip). A fake
// document records what a browser would hold; `click()` fires the element's click listeners.

import { describe, expect, it } from 'vitest';
import { mountGraphViews, type ViewDocument, type ViewElement, type ViewStyle } from './dom-views';
import type { LegendRow } from './legend';
import { GRAPH_VISUALIZER_STYLES } from './styles';
import type { GraphViews } from './visualizer';

class FakeElement implements ViewElement<FakeElement> {
  id = '';
  className = '';
  title = '';
  hidden = false;
  textContent: string | null = null;
  innerHTML = '';
  readonly style: ViewStyle = { left: '', top: '', background: '' };
  readonly attributes = new Map<string, string>();
  children: FakeElement[] = [];
  private readonly listeners: (() => void)[] = [];

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }
  replaceChildren(...children: FakeElement[]): void {
    this.children = [...children];
  }
  addEventListener(_type: 'click', listener: () => void): void {
    this.listeners.push(listener);
  }
  click(): void {
    for (const listener of this.listeners) listener();
  }
  find(id: string): FakeElement {
    for (const child of this.children) {
      if (child.id === id) return child;
      try {
        return child.find(id);
      } catch {
        // not under this child
      }
    }
    throw new Error(`no #${id}`);
  }
}

const doc: ViewDocument<FakeElement> = { createElement: (tagName) => new FakeElement(tagName) };

interface Mounted {
  readonly container: FakeElement;
  readonly views: GraphViews;
  readonly fits: number[];
}

function mount(container = new FakeElement('div')): Mounted {
  const fits: number[] = [];
  const views = mountGraphViews(doc, container, () => fits.push(fits.length));
  return { container, views, fits };
}

const row = (key: string, text: string, pressed = true): LegendRow => ({
  key,
  text,
  title: `Click to ${pressed ? 'hide' : 'show'} ${key.toLowerCase()}`,
  color: key === 'FILE' ? '#4db3ff' : '#ff9933',
  pressed,
});

describe('mountGraphViews', () => {
  it('appends the styles, the fit-view button, the legends and the hidden tooltip', () => {
    const { container } = mount();
    expect(container.children.map((c) => [c.tagName, c.id])).toEqual([
      ['style', ''],
      ['button', 'fit-view-button'],
      ['div', 'legend-container'],
      ['div', 'node-tooltip'],
    ]);
    const [style, button, legends, tooltip] = container.children;
    expect(style?.textContent).toBe(GRAPH_VISUALIZER_STYLES);
    expect(button?.attributes.get('type')).toBe('button');
    expect(button?.title).toBe('Zoom to fit');
    expect(button?.innerHTML).toMatch(/^<svg\b[\s\S]*<\/svg>$/);
    expect(legends?.children.map((c) => [c.tagName, c.id])).toEqual([
      ['div', 'legend'],
      ['div', 'relationship-legend'],
    ]);
    expect(legends?.children.every((c) => c.children.length === 0)).toBe(true);
    expect(tooltip?.hidden).toBe(true);
  });

  it('keeps what the container already holds', () => {
    const container = new FakeElement('div');
    const canvas = new FakeElement('canvas');
    container.append(canvas);
    mount(container);
    expect(container.children[0]).toBe(canvas);
    expect(container.children).toHaveLength(5);
  });

  it('reframes on a fit-view click, and only then', () => {
    const { container, fits } = mount();
    expect(fits).toEqual([]);
    container.find('fit-view-button').click();
    expect(fits).toEqual([0]);
  });
});

type Show = (
  views: GraphViews,
  rows: readonly LegendRow[],
  onToggle: (key: string) => void,
) => void;
const noop = (): void => {};
const texts = (element: FakeElement): (string | null | undefined)[] =>
  element.children.map((item) => item.children[1]?.textContent);

// Round two (review a6): both legends get the whole row contract, not only the node one.
describe.each<[string, Show, string, string]>([
  [
    'node types',
    (views, rows, onToggle) => views.legend.showNodeTypes(rows, onToggle),
    'legend',
    'relationship-legend',
  ],
  [
    'relationship types',
    (views, rows, onToggle) => views.legend.showRelationshipTypes(rows, onToggle),
    'relationship-legend',
    'legend',
  ],
])('the legend view: %s', (_name, show, id, otherId) => {
  it(`writes one row button per row into #${id}, and leaves #${otherId} alone`, () => {
    const { container, views } = mount();
    const other: Show = (v, r, t) =>
      id === 'legend' ? v.legend.showRelationshipTypes(r, t) : v.legend.showNodeTypes(r, t);
    other(views, [row('HAS_ENTRY', 'Has entry (2)')], noop);
    show(views, [row('DIRECTORY', 'Directories (1)'), row('FILE', 'Files (2)', false)], noop);
    const items = container.find(id).children;
    expect(items).toHaveLength(2);
    for (const [index, expected] of [
      {
        text: 'Directories (1)',
        pressed: 'true',
        title: 'Click to hide directory',
        color: '#ff9933',
      },
      { text: 'Files (2)', pressed: 'false', title: 'Click to show file', color: '#4db3ff' },
    ].entries()) {
      const item = items[index];
      expect(item?.tagName).toBe('button');
      expect(item?.attributes.get('type')).toBe('button');
      expect(item?.className).toBe('legend-item');
      expect(item?.attributes.get('aria-pressed')).toBe(expected.pressed);
      expect(item?.title).toBe(expected.title);
      const [swatch, label, ...rest] = item?.children ?? [];
      expect(rest).toEqual([]);
      expect(swatch?.tagName).toBe('span');
      expect(swatch?.className).toBe('legend-swatch');
      expect(swatch?.style.background).toBe(expected.color);
      expect(label?.tagName).toBe('span');
      expect(label?.className).toBe('legend-label');
      expect(label?.textContent).toBe(expected.text);
    }
    expect(texts(container.find(otherId))).toEqual(['Has entry (2)']);
  });

  it("reports a clicked row's key, and only that key", () => {
    const { container, views } = mount();
    const toggled: string[] = [];
    show(views, [row('DIRECTORY', 'Directories (1)'), row('FILE', 'Files (2)')], (key) =>
      toggled.push(key),
    );
    container.find(id).children[1]?.click();
    expect(toggled).toEqual(['FILE']);
  });

  it('replaces the rows on every show: more with fewer, then none', () => {
    const { container, views } = mount();
    show(views, [row('DIRECTORY', 'Directories (1)'), row('FILE', 'Files (2)')], noop);
    show(views, [row('FILE', 'Files (3)')], noop);
    const legend = container.find(id);
    expect(texts(legend)).toEqual(['Files (3)']);
    show(views, [], noop);
    expect(legend.children).toEqual([]);
  });

  it('calls the latest toggle after a re-show', () => {
    const { container, views } = mount();
    const first: string[] = [];
    const second: string[] = [];
    show(views, [row('FILE', 'Files (1)')], (key) => first.push(key));
    show(views, [row('FILE', 'Files (1)', false)], (key) => second.push(key));
    container.find(id).children[0]?.click();
    expect(first).toEqual([]);
    expect(second).toEqual(['FILE']);
  });
});

describe('the tooltip view', () => {
  it('shows text at screen pixels, and hides', () => {
    const { container, views } = mount();
    const tooltip = container.find('node-tooltip');
    views.tooltip.show('FILE: a.ts', 12.5, -4);
    expect(tooltip.textContent).toBe('FILE: a.ts');
    expect(tooltip.style.left).toBe('12.5px');
    expect(tooltip.style.top).toBe('-4px');
    expect(tooltip.hidden).toBe(false);
    views.tooltip.hide();
    expect(tooltip.hidden).toBe(true);
  });

  it('shows again with new text and position after a hide', () => {
    const { container, views } = mount();
    const tooltip = container.find('node-tooltip');
    views.tooltip.show('FILE: a.ts', 1, 2);
    views.tooltip.hide();
    views.tooltip.show('Has entry: d → f', 30, 40);
    expect(tooltip.textContent).toBe('Has entry: d → f');
    expect([tooltip.style.left, tooltip.style.top, tooltip.hidden]).toEqual([
      '30px',
      '40px',
      false,
    ]);
  });
});
