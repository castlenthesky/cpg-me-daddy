// REAL (U3.1.2, BMO-56): SPIKE-3, M-LATENCY-render-leg (controller decision 41). The render leg only: from
// the host's post of a message to the arrival of the page's render-report at that epoch and seq. The page
// reports when it has handed the graph to its renderer; nothing here says that a picture was drawn.

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createEngine } from '@cpg/engine';
import { parseWebviewMessage } from '@cpg/inspector';
import { isWorkspacePath, type GraphDelta, type GraphPayload } from '@cpg/model';
import * as vscode from 'vscode';
import type { WebviewTransport } from '../../src/contract';
import type { PanelSurface } from '../../src/graph-panel';
import { measure, within } from './samples';

// The product's own modules, as built: this file is in apps/vscode/dist/host-tests/spikes.
const load = createRequire(__filename);
const DIST = join(__dirname, '..', '..');
const { createGraphPanel }: typeof import('../../src/adapters/webview-transport') = load(
  join(DIST, 'adapters', 'webview-transport.js'),
);
const { PanelGraphHost }: typeof import('../../src/graph-host') = load(join(DIST, 'graph-host.js'));
const { PAGE_SCRIPT, pageDirectory, panelHtml }: typeof import('../../src/panel-page') = load(
  join(DIST, 'panel-page.js'),
);
const { panelTheme }: typeof import('../../src/theme') = load(join(DIST, 'theme.js'));
const { loadWorkspaceConfig }: typeof import('../../src/workspace-config') = load(
  join(DIST, 'workspace-config.js'),
);

const ignore = () => undefined;
const COUNT = 50;
const APART_MS = 50;
const REPORT_MS = 30_000;

/** The graph of the workspace VS Code opened, as graph-session.ts makes it. */
async function indexed(): Promise<GraphPayload> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root, 'no workspace folder');
  const { config } = await loadWorkspaceConfig(root);
  const engine = createEngine({ version: '0.0.0', consumers: config.consumers });
  const session = await engine.connect(config.store, { readOnly: false });
  const { signal } = new AbortController();
  await engine.index({ config, session, resumeFrom: null }, () => undefined, signal);
  const payload = await engine.inspect(session, config);
  await session.close();
  return payload;
}

/** What U4 will send when one file's bytes change: its FILE node, merged in place, and no edge. */
function changed({ nodes }: GraphPayload, seq: number): GraphDelta {
  const node = nodes.find(({ type }) => type === 'FILE');
  const file = node?.data?.['path'];
  assert.ok(node !== undefined && typeof file === 'string' && isWorkspacePath(file), 'no FILE');
  const revision_id = createHash('sha256').update(String(seq)).digest('hex');
  return {
    seq,
    file,
    revision_id,
    producer: 'filesystem',
    addedNodes: [{ ...node, data: { ...node.data, revision_id, content_hash: revision_id } }],
    addedEdges: [],
    removedNodeIds: [],
  };
}

suite('SPIKE-3: the render leg of the panel', () => {
  let payload: GraphPayload;
  let posted = { at: 0, what: '' };
  let reported: (ms: number) => void = ignore;
  let surface: PanelSurface;
  const timed = ({ transport }: PanelSurface): WebviewTransport => ({
    cspSource: transport.cspSource,
    post(message) {
      if (message.type === 'graph' || message.type === 'graph-delta') {
        posted = { at: performance.now(), what: `${String(message.epoch)} ${String(message.seq)}` };
      }
      transport.post(message);
    },
    onMessage: (handler) =>
      transport.onMessage((raw) => {
        const ms = performance.now() - posted.at;
        const message = parseWebviewMessage(raw);
        handler(raw);
        if (message?.type !== 'render-report') return;
        if (`${String(message.epoch)} ${String(message.seq)}` === posted.what) reported(ms);
      }),
  });
  const host = new PanelGraphHost({
    theme: panelTheme(vscode.window.activeColorTheme.kind),
    parse: parseWebviewMessage,
    opener: { open: async () => undefined },
    onReveal: ignore,
    onChange: ignore,
  });
  /** One render leg: `send` makes the host post one graph or graph-delta. */
  async function leg(send: () => Promise<void>): Promise<number> {
    await new Promise((resolve) => {
      setTimeout(resolve, APART_MS);
    });
    const answer = new Promise<number>((resolve) => {
      reported = resolve;
    });
    await send();
    return within(REPORT_MS, answer, 'render-report');
  }

  suiteSetup(async () => {
    payload = await indexed();
    surface = createGraphPanel(pageDirectory());
    host.attach(timed(surface));
  });
  suiteTeardown(() => surface.dispose());

  // The cold sample is the page's first graph: the host posts it when the page is ready, so it includes
  // what the first use of WebGL costs and not the page's own load.
  test('graph', async () => {
    const directory = pageDirectory();
    const script = surface.asUri(join(directory, PAGE_SCRIPT));
    const { cspSource } = surface.transport;
    let html: string | undefined = await panelHtml({ directory, asUri: () => script, cspSource });
    const name = `graph (${String(payload.nodes.length)} nodes, ${String(payload.edges.length)} edges)`;
    await measure({ name }, COUNT, () =>
      leg(async () => {
        await host.onSnapshot(payload, { seq: payload.seq, cause: 'initial' });
        if (html !== undefined) surface.setHtml(html);
        html = undefined;
      }),
    );
    assert.deepEqual(host.faults(), []);
  });

  test('graph-delta', async () => {
    const files = payload.nodes.filter(({ type }) => type === 'FILE').length;
    await measure({ name: `graph-delta (1 of ${String(files)} FILEs)` }, COUNT, () =>
      leg(async () => {
        const seq = host.seq() + 1;
        await host.onDelta(changed(payload, seq), { seq, cause: 'live' });
      }),
    );
    assert.deepEqual(host.faults(), []);
  });
});
