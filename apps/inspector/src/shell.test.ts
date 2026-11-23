// The page shell (21754b4:packages/graph-visualizer/src/shell.ts), hardened per C-EXT I-27 as owner
// decision 10a amends it: default-src 'none', connect-src 'none' unless the caller passes exactly
// its own ws://127.0.0.1:<port>, nonce-only scripts, no unsafe-eval, no remote origin. It reserves
// #cpg-verification beside the graph (08-verification §3.3). Colours are pinned in styles.test.ts.

import { describe, expect, it } from 'vitest';
import {
  GRAPH_CONTAINER_ID,
  graphShellHtml,
  VERIFICATION_ID,
  type GraphShellOptions,
} from './shell';

const BASE: GraphShellOptions = {
  scriptUri: 'https://file+.vscode-resource.vscode-cdn.net/ext/dist/page/graph.js',
  cspSource: 'https://file+.vscode-resource.vscode-cdn.net',
  nonce: 'bm9uY2Utb25l',
};

/** The page's one CSP, directive by directive; a repeated directive or meta is a problem. */
function csp(html: string): { directives: Map<string, string[]>; problems: string[] } {
  const metas = [
    ...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/g),
  ];
  const problems = metas.length === 1 ? [] : [`${String(metas.length)} CSP metas`];
  const directives = new Map<string, string[]>();
  for (const part of (metas[0]?.[1] ?? '').split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name === undefined || name === '') continue;
    if (directives.has(name)) problems.push(`repeated ${name}`);
    directives.set(name, sources);
  }
  return { directives, problems };
}

const GRANTING = ['default-src', 'connect-src', 'script-src', 'style-src'];

/** Everything wrong with the page's CSP against I-27: exactly these grants, nothing else. */
function cspProblems(html: string, connect: string): string[] {
  const { directives, problems } = csp(html);
  const want: Record<string, string[]> = {
    'default-src': ["'none'"],
    'connect-src': [connect],
    'script-src': [`'nonce-${BASE.nonce}'`],
    'style-src': [BASE.cspSource, "'unsafe-inline'"],
  };
  for (const [name, sources] of Object.entries(want)) {
    const got = directives.get(name);
    if (JSON.stringify(got) !== JSON.stringify(sources))
      problems.push(`${name}: ${JSON.stringify(got)}`);
  }
  for (const [name, sources] of directives) {
    if (!GRANTING.includes(name) && JSON.stringify(sources) !== `["'none'"]`)
      problems.push(`${name} grants ${sources.join(' ')}`);
    for (const source of sources) {
      if (source === "'unsafe-eval'" || source === '*' || /^[a-z][a-z0-9+.-]*:$/.test(source))
        problems.push(`${name} allows ${source}`);
    }
  }
  return problems;
}

const GOOD_POLICY = `default-src 'none'; connect-src 'none'; style-src ${BASE.cspSource} 'unsafe-inline'; script-src 'nonce-${BASE.nonce}'`;
const page = (policy: string): string =>
  `<meta http-equiv="Content-Security-Policy" content="${policy}" />`;

describe('the CSP check itself', () => {
  it("accepts I-27's policy, and an extra directive that grants nothing", () => {
    expect(cspProblems(page(GOOD_POLICY), "'none'")).toEqual([]);
    expect(cspProblems(page(`${GOOD_POLICY}; frame-src 'none'`), "'none'")).toEqual([]);
  });

  it.each([
    ['another nonce', GOOD_POLICY.replace(BASE.nonce, 'b3RoZXI')],
    ['a wildcard default', GOOD_POLICY.replace("default-src 'none'", 'default-src *')],
    ['an extra grant', `${GOOD_POLICY}; img-src https:`],
    ['unsafe-eval', `${GOOD_POLICY} 'unsafe-eval'`],
    ['a repeated directive', `${GOOD_POLICY}; default-src *`],
    ['a missing connect-src', GOOD_POLICY.replace("connect-src 'none'; ", '')],
  ])('rejects %s', (_what, policy) => {
    expect(cspProblems(page(policy), "'none'")).not.toEqual([]);
  });

  it('rejects two CSP metas', () => {
    expect(cspProblems(page(GOOD_POLICY) + page(GOOD_POLICY), "'none'")).not.toEqual([]);
  });
});

describe('graphShellHtml', () => {
  it('is an HTML5 page', () => {
    expect(graphShellHtml(BASE).startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it("allows connections to nothing by default (connect-src 'none', the VS Code panel)", () => {
    expect(cspProblems(graphShellHtml(BASE), "'none'")).toEqual([]);
  });

  it("takes 'none' explicitly", () => {
    expect(cspProblems(graphShellHtml({ ...BASE, connectSrc: "'none'" }), "'none'")).toEqual([]);
  });

  it("allows exactly the browser inspector's own ws://127.0.0.1:<port> (decision 10a)", () => {
    const html = graphShellHtml({ ...BASE, connectSrc: 'ws://127.0.0.1:43117' });
    expect(cspProblems(html, 'ws://127.0.0.1:43117')).toEqual([]);
  });

  it('accepts the lowest and highest ports', () => {
    for (const port of [1, 65535]) {
      const connectSrc = `ws://127.0.0.1:${String(port)}`;
      expect(cspProblems(graphShellHtml({ ...BASE, connectSrc }), connectSrc)).toEqual([]);
    }
  });

  it.each([
    'ws://127.0.0.1:0',
    'ws://127.0.0.1:65536',
    'ws://127.0.0.1:-1',
    'ws://127.0.0.1:80.5',
    'ws://127.0.0.1:NaN',
    'ws://127.0.0.1:',
    'ws://127.0.0.1',
    'ws://127.0.0.1:8080/',
    'ws://localhost:8080',
    'ws://10.0.0.1:8080',
    'ws://127.0.0.10:8080',
    'wss://127.0.0.1:8080',
    'http://127.0.0.1:8080',
    "ws://127.0.0.1:8080; script-src 'unsafe-eval'",
    'ws://127.0.0.1:8080 ws://example.com:80',
    ' ws://127.0.0.1:8080',
    "'self'",
    '*',
    "'none' ws://127.0.0.1:8080",
    '',
    // Round two (review a1): forms a Number()-based port check would admit.
    'ws://127.0.0.1: 8080',
    'ws://127.0.0.1:8080 ',
    'ws://127.0.0.1:+80',
    'ws://127.0.0.1:0x50',
    'ws://127.0.0.1:1e2',
    // The server's port in decimal, as it prints it: no leading zero.
    'ws://127.0.0.1:080',
  ])('rejects the connect source %j (no remote origin, no injected directive)', (connectSrc) => {
    const call = (): string => graphShellHtml({ ...BASE, connectSrc });
    expect(call).toThrow(/connect-src/);
    expect(call).toThrow(connectSrc);
  });

  it('loads the one script by nonce, with no inline script body', () => {
    const html = graphShellHtml(BASE);
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)];
    expect(scripts).toHaveLength(1);
    expect(html).toContain(`<script nonce="${BASE.nonce}" src="${BASE.scriptUri}"></script>`);
  });

  it('provides the empty mount element, positioned so the overlays can sit on it', () => {
    const html = graphShellHtml(BASE);
    expect(GRAPH_CONTAINER_ID).toBe('graph-container');
    expect(html.split('id="graph-container"')).toHaveLength(2);
    expect(html).toContain('<div id="graph-container"></div>');
    expect(html).toMatch(/#graph-container\s*\{[^}]*position:\s*relative/);
  });

  it('mounts on a caller-named element instead', () => {
    const html = graphShellHtml({ ...BASE, containerId: 'mount' });
    expect(html).toContain('<div id="mount"></div>');
    expect(html).toMatch(/#mount\s*\{[^}]*position:\s*relative/);
    expect(html).not.toContain('graph-container');
  });

  it('reserves one #cpg-verification region outside the graph, labelled a liveness check', () => {
    const html = graphShellHtml(BASE);
    expect(VERIFICATION_ID).toBe('cpg-verification');
    expect(html.split(`id="${VERIFICATION_ID}"`)).toHaveLength(2);
    const region = /<div id="cpg-verification"[^>]*>([^<]*)<\/div>/.exec(html);
    expect(region?.[1]).toMatch(/liveness check/i);
    // Present before the script runs, so the page can find it (part 3 fills it).
    expect(html.indexOf(`id="${VERIFICATION_ID}"`)).toBeLessThan(html.indexOf('<script'));
  });

  // Round two (review a2): the script looks the container up at load, so both elements precede it.
  it.each([undefined, 'mount'])(
    'orders the body: the region, then the container (%s), then the script',
    (containerId) => {
      const html = graphShellHtml(containerId === undefined ? BASE : { ...BASE, containerId });
      const region = html.indexOf(`id="${VERIFICATION_ID}"`);
      const container = html.indexOf(`<div id="${containerId ?? GRAPH_CONTAINER_ID}"></div>`);
      const script = html.indexOf('<script');
      expect(region).toBeGreaterThan(html.indexOf('<body'));
      expect(container).toBeGreaterThan(region);
      expect(script).toBeGreaterThan(container);
    },
  );

  // Round two (review a3).
  it("allows styles from the caller's own origin, whatever it is", () => {
    const html = graphShellHtml({ ...BASE, cspSource: 'http://127.0.0.1:43117' });
    expect(csp(html).directives.get('style-src')).toEqual([
      'http://127.0.0.1:43117',
      "'unsafe-inline'",
    ]);
  });

  it('carries the nonce and script URI through unchanged per call', () => {
    const html = graphShellHtml({ ...BASE, nonce: 'c2Vjb25k', scriptUri: '/graph.js' });
    expect(csp(html).directives.get('script-src')).toEqual(["'nonce-c2Vjb25k'"]);
    expect(html).toContain('<script nonce="c2Vjb25k" src="/graph.js"></script>');
  });
});
