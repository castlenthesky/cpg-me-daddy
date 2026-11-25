// What the graph panel shows (controller decision 31): the shell on the bundled page, or, when the
// bundle is missing, a message naming the build command. The shell contract itself is in
// shell.conformance.test.ts. The last block joins @cpg/inspector's front door to the panel's host.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWebviewMessage } from '@cpg/inspector';
import type { HostToWebview } from '@cpg/model';
import { afterEach, describe, expect, it } from 'vitest';
import { PanelGraphHost } from './graph-host';
import { PAGE_SCRIPT, pageDirectory, panelHtml } from './panel-page';
import { panelTheme } from './theme';

// Round two (review d2): require.resolve answers with real paths.
const REPO = realpathSync(join(__dirname, '..', '..', '..'));
const CSP_SOURCE = "'self' https://*.vscode-cdn.net";
const asUri = (path: string): string => `https://file+.vscode-resource.vscode-cdn.net${path}`;

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function directory(name = 'page'): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'panel-page-')), name);
  temporary.push(join(dir, '..'));
  mkdirSync(dir);
  return dir;
}

/** A new directory, filled by `fill`. */
function holding(fill: (dir: string) => void): string {
  const dir = directory();
  fill(dir);
  return dir;
}

const built = (): string => holding((dir) => writeFileSync(join(dir, PAGE_SCRIPT), ''));

const nonceOf = (html: string): string | undefined => /script-src 'nonce-([^']+)'/.exec(html)?.[1];

describe('pageDirectory', () => {
  it("is the installed @cpg/inspector's dist/page, which build:inspector writes", () => {
    expect(pageDirectory()).toBe(join(REPO, 'apps', 'inspector', 'dist', 'page'));
    expect(PAGE_SCRIPT).toBe('graph.js');
  });

  // Round two (review a1): a packaged extension has another layout. The package is found through its
  // manifest, not through a path in this repository or the directory its main is in.
  it('follows the package wherever it is installed', { timeout: 20_000 }, () => {
    const root = realpathSync(directory('install'));
    const installed = join(root, 'node_modules', '@cpg', 'inspector');
    mkdirSync(join(installed, 'lib', 'deep'), { recursive: true });
    mkdirSync(join(root, 'app'));
    writeFileSync(join(installed, 'package.json'), '{"main":"./lib/deep/main.js"}');
    writeFileSync(join(installed, 'lib', 'deep', 'main.js'), '');
    const copied = join(root, 'app', 'panel-page.js');
    copyFileSync(join(__dirname, '..', 'dist', 'panel-page.js'), copied);
    const script = 'process.stdout.write(require(process.argv[1]).pageDirectory())';
    const run = spawnSync(process.execPath, ['-e', script, copied], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(`${run.stdout}${run.stderr}`).toBe(join(installed, 'dist', 'page'));
  });
});

describe('panelHtml with a built bundle', () => {
  it('loads the bundle from the directory, through the webview, and nothing else', async () => {
    const dir = built();
    const asked: string[] = [];
    const html = await panelHtml({
      directory: dir,
      asUri: (path) => {
        asked.push(path);
        return `uri:${path}`;
      },
      cspSource: CSP_SOURCE,
    });
    expect(asked).toEqual([join(dir, 'graph.js')]);
    expect(html).toContain(`src="uri:${join(dir, 'graph.js')}"`);
    expect(html).toContain('<div id="graph-container"></div>');
    expect(html).not.toContain('bun run');
  });

  it('makes a fresh 128-bit nonce per load', async () => {
    const options = { directory: built(), asUri, cspSource: CSP_SOURCE };
    const nonces = [nonceOf(await panelHtml(options)), nonceOf(await panelHtml(options))];
    expect(nonces[0]).not.toBe(nonces[1]);
    expect(nonces.map((nonce) => Buffer.from(nonce ?? '', 'base64').length)).toEqual([16, 16]);
  });
});

describe('panelHtml with no bundle (decision 31: never a blank panel)', () => {
  it.each([
    ['the bundle is missing', () => directory()],
    ['the directory is missing', () => join(directory(), 'nowhere')],
    // Round two (review a2): whatever is there instead, it can't be read as the bundle.
    ['a directory is in its place', () => holding((dir) => mkdirSync(join(dir, 'graph.js')))],
    ['the directory is a file', () => join(built(), 'graph.js')],
  ])('%s: says which file and names the build command, and runs nothing', async (_what, make) => {
    const dir = make();
    const html = await panelHtml({ directory: dir, asUri, cspSource: CSP_SOURCE });
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '';
    expect(body).toContain('bun run compile');
    expect(body).toContain(join(dir, 'graph.js'));
    const policies = html.match(/<meta http-equiv="Content-Security-Policy"[^>]*>/g);
    expect(policies).toEqual([
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'" />`,
    ]);
    expect(html).not.toMatch(/<style|style=/);
    expect(html).not.toMatch(/<script|<link|<img|src=|graph-container/);
  });

  // Post-implementation: closes sabotage survivor "the read permission is not checked". Root reads all.
  it.skipIf(process.getuid?.() === 0)('a bundle it may not read gets the message', async () => {
    const dir = built();
    chmodSync(join(dir, PAGE_SCRIPT), 0);
    const html = await panelHtml({ directory: dir, asUri, cspSource: CSP_SOURCE });
    expect(html).toContain('bun run compile');
    expect(html).not.toContain('<script');
  });

  // C-EXT may_not: sync fs (L-11).
  it('uses async fs only', () => {
    const source = readFileSync(join(__dirname, 'panel-page.ts'), 'utf8');
    expect(source).toContain('node:fs/promises');
    expect(source).not.toMatch(/\w+Sync\s*\(/);
  });

  it('shows the path as text, never as markup', async () => {
    const dir = join(directory(), 'a & <b>');
    const html = await panelHtml({ directory: dir, asUri, cspSource: CSP_SOURCE });
    expect(html).not.toContain('<b>');
    expect(html).toContain('a &amp; &lt;b&gt;');
  });
});

/** A host joined to the front door's parser and the panel's theme, with a page attached. */
function attached() {
  const posted: HostToWebview[] = [];
  const handlers: ((message: unknown) => void)[] = [];
  const host = new PanelGraphHost({
    theme: panelTheme(2),
    parse: parseWebviewMessage,
    opener: { open: () => Promise.resolve() },
    onReveal: () => undefined,
    onChange: () => undefined,
  });
  host.attach({
    cspSource: CSP_SOURCE,
    post: (message) => void posted.push(message),
    onMessage: (handler) => {
      handlers.push(handler);
      return { dispose: () => undefined };
    },
  });
  return { host, posted, send: (message: unknown) => handlers.forEach((run) => run(message)) };
}

// Sprint 17 passes exactly these two to the host; the host has no parser and no palette of its own.
describe("the panel host on the front door's parser and the panel's theme", () => {
  it('answers ready with the theme, then the graph, and re-posts a changed theme alone (I-4)', async () => {
    const { host, posted, send } = attached();
    const payload = { seq: 3, nodes: [{ id: 'a', type: 'FILE' }], edges: [] };
    await host.onSnapshot(payload, { seq: 3, cause: 'initial' });
    send({ type: 'ready', protocol: 1 });
    host.setTheme(panelTheme(1));
    expect(posted).toStrictEqual([
      { type: 'theme', protocol: 1, epoch: 1, theme: panelTheme(2) },
      { type: 'graph', protocol: 1, epoch: 1, seq: 3, payload },
      { type: 'theme', protocol: 1, epoch: 1, theme: panelTheme(1) },
    ]);
  });

  it('takes a render-report and records a message that is none of the four as a fault', async () => {
    const { host, send } = attached();
    const report = {
      payloadNodeCount: 1,
      renderedNodeCount: 1,
      renderedEdgeCount: 0,
      duplicateEdges: 0,
      droppedNodeIds: [],
      frameMs: 2,
    };
    send({ type: 'ready', protocol: 1 });
    send({ type: 'render-report', epoch: 0, seq: 3, report });
    send({ type: 'render-report', epoch: 0, seq: 3, report: { ...report, frameMs: '2' } });
    expect(host.renderReport()).toStrictEqual({ type: 'render-report', epoch: 0, seq: 3, report });
    expect(host.faults().map((fault) => fault.kind)).toEqual(['unknown-message']);
  });
});
