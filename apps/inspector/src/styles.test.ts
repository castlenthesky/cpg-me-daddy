// The component CSS (ADAPT of 21754b4:packages/graph-visualizer/src/styles.ts) and the shell's page
// CSS. C-EXT I-28: no literal colour in the shell. Owner decision 11a: --vscode-* variables, and
// outside VS Code CSS system-colour keywords (Canvas, CanvasText, GrayText, ...), which are not
// literal colours. The archive hard-coded rgba(30, 30, 30, 0.85) and #cccccc.

import { describe, expect, it } from 'vitest';
import { graphShellHtml } from './shell';
import { GRAPH_VISUALIZER_STYLES } from './styles';

/** CSS Color 4 §6.2, the non-deprecated system colours. */
const SYSTEM_COLOURS = [
  'AccentColor',
  'AccentColorText',
  'ActiveText',
  'ButtonBorder',
  'ButtonFace',
  'ButtonText',
  'Canvas',
  'CanvasText',
  'Field',
  'FieldText',
  'GrayText',
  'Highlight',
  'HighlightText',
  'LinkText',
  'Mark',
  'MarkText',
  'SelectedItem',
  'SelectedItemText',
  'VisitedText',
];
const COLOUR_PROPERTY =
  /^(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?|fill|stroke|box-shadow|text-shadow|caret-color|accent-color|text-decoration-color|column-rule(?:-color)?)$/;
const THEMED = new RegExp(
  String.raw`var\(\s*--vscode-[A-Za-z0-9.-]+\s*,\s*(?:${SYSTEM_COLOURS.join('|')})\s*\)`,
  'g',
);
const NON_COLOUR_WORD =
  /^(?:-?\d*\.?\d+(?:px|em|rem|%)?|solid|dashed|dotted|none|currentColor|inherit)$/;
const LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i;

type Rules = Map<string, Map<string, string>>;

function rules(css: string): Rules {
  const out: Rules = new Map();
  for (const [, selectors = '', body = ''] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = new Map<string, string>();
    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon === -1) continue;
      declarations.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
    }
    for (const selector of selectors.split(',')) {
      const key = selector.trim().replaceAll("'", '"');
      out.set(key, new Map([...(out.get(key) ?? []), ...declarations]));
    }
  }
  return out;
}

/** Every colour problem in `css`: a literal anywhere, or a colour value that is not themed. */
function colourProblems(css: string): string[] {
  const problems: string[] = [];
  for (const [selector, declarations] of rules(css)) {
    for (const [property, value] of declarations) {
      const where = `${selector} { ${property}: ${value} }`;
      if (LITERAL.test(value)) problems.push(`literal colour: ${where}`);
      if (!COLOUR_PROPERTY.test(property)) continue;
      const rest = value.replace(THEMED, ' ').split(/\s+/).filter(Boolean);
      for (const word of rest) {
        if (!NON_COLOUR_WORD.test(word)) problems.push(`not themed (${word}): ${where}`);
      }
    }
  }
  return problems;
}

/** Colour declarations in `css`, to show the scan saw something. */
function colourDeclarations(css: string): number {
  let count = 0;
  for (const declarations of rules(css).values()) {
    for (const property of declarations.keys()) if (COLOUR_PROPERTY.test(property)) count += 1;
  }
  return count;
}

const shellCss = (): string => {
  const html = graphShellHtml({ scriptUri: '/graph.js', cspSource: "'self'", nonce: 'bm9uY2U' });
  return [...html.matchAll(/<style>([^<]*)<\/style>/g)].map((m) => m[1] ?? '').join('\n');
};

describe('the colour scan itself', () => {
  it.each([
    'a { color: #ccc; }',
    'a { color: #CCCCCC; }',
    'a { background: rgba(30, 30, 30, 0.85); }',
    'a { color: white; }',
    'a { border: 1px solid rgba(255, 255, 255, 0.2); }',
    'a { color: var(--vscode-foreground, #cccccc); }',
    'a { color: var(--vscode-foreground, white); }',
    'a { color: var(--vscode-foreground); }',
    'a { background: transparent; }',
    'a { box-shadow: 0 0 2px hsl(0 0% 0%); }',
  ])('rejects %s', (css) => {
    expect(colourProblems(css)).not.toEqual([]);
  });

  it.each([
    'a { color: var(--vscode-foreground, CanvasText); }',
    'a { border: 1px solid var(--vscode-widget-border, GrayText); }',
    'a { background: none; stroke: currentColor; }',
    'a { font-family: var(--vscode-font-family, sans-serif); opacity: 0.45; }',
  ])('accepts %s', (css) => {
    expect(colourProblems(css)).toEqual([]);
  });
});

describe.each([
  // The archive's component CSS coloured the button, both legends, the rows and the tooltip.
  ['the component styles', (): string => GRAPH_VISUALIZER_STYLES, 6],
  ['the shell page CSS', shellCss, 1],
])('%s (decision 11a)', (_name, css, atLeast) => {
  it('has colour declarations to check', () => {
    expect(colourDeclarations(css())).toBeGreaterThanOrEqual(atLeast);
  });

  it('holds no literal colour: every colour is a --vscode-* variable with a system-colour fallback', () => {
    expect(colourProblems(css())).toEqual([]);
  });
});

const css = (): Rules => rules(GRAPH_VISUALIZER_STYLES);
const declaration = (selector: string, property: string): string | undefined =>
  css().get(selector)?.get(property);

describe('GRAPH_VISUALIZER_STYLES', () => {
  it('styles every element mountGraphViews creates', () => {
    const missing = [
      '#fit-view-button',
      '#legend-container',
      '#legend',
      '#relationship-legend',
      '.legend-item',
      '.legend-swatch',
      '.legend-label',
      '#node-tooltip',
    ].filter((selector) => !css().has(selector));
    expect(missing).toEqual([]);
  });

  it('overlays the button, the legends and the tooltip on the canvas', () => {
    expect(declaration('#fit-view-button', 'position')).toBe('absolute');
    expect(declaration('#legend-container', 'position')).toBe('absolute');
    expect(declaration('#node-tooltip', 'position')).toBe('absolute');
    const legendZ = Number(declaration('#legend-container', 'z-index'));
    expect(Number(declaration('#node-tooltip', 'z-index'))).toBeGreaterThan(legendZ);
  });

  it('never lets the tooltip take the pointer from the canvas', () => {
    expect(declaration('#node-tooltip', 'pointer-events')).toBe('none');
  });

  it('hides a hidden tooltip and an empty relationship legend', () => {
    expect(declaration('#node-tooltip[hidden]', 'display')).toBe('none');
    expect(declaration('#relationship-legend:empty', 'display')).toBe('none');
  });

  it('dims an unpressed (hidden-type) legend row', () => {
    const opacity = Number(declaration('.legend-item[aria-pressed="false"]', 'opacity'));
    expect(opacity).toBeGreaterThan(0);
    expect(opacity).toBeLessThan(1);
  });
});
