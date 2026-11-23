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

/** Each rule's selectors and EVERY declaration in order (a repeated property is kept, not merged). */
type Rule = {
  readonly selectors: readonly string[];
  readonly declarations: readonly [string, string][];
};

function parse(css: string): Rule[] {
  const out: Rule[] = [];
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const [, selectors = '', body = ''] of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations: [string, string][] = [];
    for (const text of body.split(';')) {
      const colon = text.indexOf(':');
      if (colon === -1) continue;
      declarations.push([text.slice(0, colon).trim(), text.slice(colon + 1).trim()]);
    }
    out.push({
      selectors: selectors.split(',').map((selector) => selector.trim().replaceAll("'", '"')),
      declarations,
    });
  }
  return out;
}

/** Every colour problem in `css`: a literal anywhere, or a colour value that is not themed. */
function colourProblems(css: string): string[] {
  const problems: string[] = [];
  for (const { selectors, declarations } of parse(css)) {
    for (const [property, value] of declarations) {
      const where = `${selectors.join(', ')} { ${property}: ${value} }`;
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
  return parse(css)
    .flatMap((rule) => rule.declarations)
    .filter(([property]) => COLOUR_PROPERTY.test(property)).length;
}

/** All of a page's CSS: every <style> element, and every style attribute as a rule of its own. */
function pageCss(html: string): string {
  const sheets = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? '');
  const inline = [...html.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(
    (m) => `[style] { ${m[1] ?? m[2] ?? ''} }`,
  );
  return [...sheets, ...inline].join('\n');
}

const shellCss = (): string =>
  pageCss(graphShellHtml({ scriptUri: '/graph.js', cspSource: "'self'", nonce: 'bm9uY2U' }));

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
    // Round two (review a4): an overridden literal, and a declaration behind a comment.
    'a { background: #1e1e1e; background: var(--vscode-editor-background, Canvas); }',
    'a { /* note */ background: transparent; }',
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

  // Round two (review a5): a page's colours can also sit in a style attribute or an attributed tag.
  it.each([
    '<body style="background: #1e1e1e"></body>',
    '<div id="x" style=\'color: #ccc\'></div>',
    '<style media="screen">a { color: white; }</style>',
  ])('finds the colour in %s', (html) => {
    expect(colourProblems(pageCss(html))).not.toEqual([]);
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

/** The last value `selector` gives `property` in the component styles (as the cascade would). */
function declaration(selector: string, property: string): string | undefined {
  let value: string | undefined;
  for (const rule of parse(GRAPH_VISUALIZER_STYLES)) {
    if (!rule.selectors.includes(selector)) continue;
    for (const [name, v] of rule.declarations) if (name === property) value = v;
  }
  return value;
}

const hasRule = (selector: string): boolean =>
  parse(GRAPH_VISUALIZER_STYLES).some((rule) => rule.selectors.includes(selector));

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
    ].filter((selector) => !hasRule(selector));
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
