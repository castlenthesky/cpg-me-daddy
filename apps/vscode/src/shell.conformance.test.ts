// verifyShellContract (C-EXT's conformance_suite: 5 tests; the archived suite is in no reachable commit,
// so these are written from I-27, I-28 and 08-verification §3.3). It judges the page the VS Code panel
// really shows: panelHtml's, from the built @cpg/inspector. apps/inspector/src/shell.test.ts and
// styles.test.ts hold graphShellHtml to the same clauses under the browser inspector.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAGE_SCRIPT, panelHtml } from './panel-page';

const CSP_SOURCE = "'self' https://*.vscode-cdn.net";
const asUri = (path: string): string => `https://file+.vscode-resource.vscode-cdn.net${path}`;

/** The one CSP meta's directives; a second meta or a repeated directive is an error. */
function policy(html: string): Record<string, string[]> {
  const metas = [
    ...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/g),
  ];
  if (metas.length !== 1) throw new Error(`${String(metas.length)} CSP metas`);
  const directives: Record<string, string[]> = {};
  for (const part of (metas[0]?.[1] ?? '').split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name === undefined || name === '') continue;
    if (name in directives) throw new Error(`repeated ${name}`);
    directives[name] = sources;
  }
  return directives;
}

const nonceOf = (html: string): string =>
  (policy(html)['script-src']?.join(' ') ?? '').replace(/^'nonce-(.+)'$/, '$1');

/** Each URL the page names, in an attribute or in CSS. */
function urls(html: string): string[] {
  const attributes = [
    ...html.matchAll(/\s(?:src|href|action|data|srcset|poster)\s*=\s*"([^"]*)"/g),
  ];
  const css = [...html.matchAll(/url\(([^)]*)\)|@import\s+([^;]+)/g)];
  return [...attributes, ...css].map((match) => match[1] ?? match[2] ?? '');
}

const COLOUR_PROPERTY =
  /^(?:color|background(?:-color)?|border(?:-\w+)*|outline(?:-color)?|fill|stroke|box-shadow)$/;
const THEMED = /var\(\s*--vscode-[\w-]+\s*,\s*[A-Z][A-Za-z]+\s*\)/g;
const NOT_A_COLOUR = /^(?:-?\d*\.?\d+(?:px|em|rem|%)?|solid|dashed|dotted|none|inherit)$/;

/** The colour declarations of the page's CSS that name anything but a themed colour. */
function literalColours(html: string): { declarations: number; literal: string[] } {
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)]
    .map((m) => m[1] ?? '')
    .join('');
  const styles = [...html.matchAll(/\sstyle\s*=\s*"([^"]*)"/g)].map((m) => `x { ${m[1] ?? ''} }`);
  const found = [...`${css}${styles.join('')}`.matchAll(/([\w-]+)\s*:\s*([^;{}]+)/g)].filter(
    ([, property]) => COLOUR_PROPERTY.test(property ?? ''),
  );
  const literal = found
    .map(([declaration, , value]) => ({ declaration, rest: (value ?? '').replace(THEMED, ' ') }))
    .filter(({ rest }) => rest.split(/\s+/).some((word) => word !== '' && !NOT_A_COLOUR.test(word)))
    .map(({ declaration }) => declaration);
  return { declarations: found.length, literal };
}

/** C-EXT's shell contract, on the page `make` returns. */
function verifyShellContract(make: () => Promise<string>, scriptUri: () => string): void {
  it('I-27: the CSP grants the nonce script and the webview styles, and nothing else', async () => {
    const html = await make();
    expect(policy(html)).toStrictEqual({
      'default-src': ["'none'"],
      'connect-src': ["'none'"],
      'style-src': [...CSP_SOURCE.split(' '), "'unsafe-inline'"],
      'script-src': [`'nonce-${nonceOf(html)}'`],
    });
    expect(nonceOf(html)).toMatch(/^[A-Za-z0-9+/]{20,}={0,2}$/);
  });

  it('I-27: one script, the bundle, carrying the nonce; nothing inline', async () => {
    const html = await make();
    expect([...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)].map(([tag]) => tag)).toEqual([
      `<script nonce="${nonceOf(html)}" src="${scriptUri()}"></script>`,
    ]);
    expect(html).not.toMatch(/\son\w+\s*=|javascript:/i);
  });

  it('I-27: no remote origin: the bundle is the only thing the page loads', async () => {
    const html = await make();
    expect(urls(html)).toEqual([scriptUri()]);
    expect(html).not.toMatch(/<(?:link|img|iframe|object|embed|base|form)\b|http-equiv="refresh"/i);
  });

  it('I-28: no literal colour: --vscode-* variables with system-colour fallbacks', async () => {
    const { declarations, literal } = literalColours(await make());
    expect(literal).toEqual([]);
    expect(declarations).toBeGreaterThanOrEqual(3);
  });

  it('§3.3: one #cpg-verification, labelled a liveness check, before the graph and its script', async () => {
    const html = await make();
    expect(html.match(/id="cpg-verification"/g)).toHaveLength(1);
    expect(/<div id="cpg-verification"[^>]*>([^<]*)</.exec(html)?.[1]).toMatch(/liveness check/i);
    const order = ['id="cpg-verification"', 'id="graph-container"', '<script'].map((part) =>
      html.indexOf(part),
    );
    expect(order.toSorted((a, b) => a - b)).toEqual(order);
    expect(order).not.toContain(-1);
  });
}

let directory = '';
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'shell-contract-'));
  writeFileSync(join(directory, PAGE_SCRIPT), '');
});
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('verifyShellContract: the VS Code panel', () => {
  verifyShellContract(
    () => panelHtml({ directory, asUri, cspSource: CSP_SOURCE }),
    () => asUri(join(directory, 'graph.js')),
  );
});

describe('the scans themselves (anti-vacuity)', () => {
  it.each([
    'a { color: #ccc; }',
    'a { background: white; }',
    'a { border: 1px solid rgba(0, 0, 0, 0.2); }',
    'a { color: var(--vscode-foreground, #cccccc); }',
    'a { color: var(--vscode-foreground, white); }',
    'a { color: var(--my-own, Canvas); }',
  ])('finds the literal colour in %s', (css) => {
    expect(literalColours(`<style>${css}</style>`).literal).toHaveLength(1);
  });

  it('finds URLs in attributes and in CSS', () => {
    const html = '<img src="a"><a href="b"><style>@import "c"; x { background: url(d) }</style>';
    expect(urls(html)).toEqual(['a', 'b', '"c"', 'd']);
  });
});
