// REAL (U3.1.2, BMO-56): SU-9 (controller decision 41). What a snapshot costs to transfer: from just before
// webview.postMessage to the page's acknowledgement. The page only counts what arrived; it draws nothing.

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import {
  isWorkspacePath,
  makeNodeId,
  WORKSPACE_ROOT,
  type GraphEdge,
  type GraphNode,
  type GraphPayload,
  type WorkspacePath,
} from '@cpg/model';
import * as vscode from 'vscode';
import { measure, record, within } from './samples';

const ignore = () => undefined;
const COUNT = 20;
const ANSWER_MS = 120_000;
const FILES_PER_DIRECTORY = 9;

// Reading the counts makes the page decode the whole message before it answers.
const PAGE = `<!DOCTYPE html><html><body><script>
const api = acquireVsCodeApi();
addEventListener('message', ({ data }) => {
  api.postMessage({ seq: data.seq, nodes: data.payload.nodes.length, edges: data.payload.edges.length });
});
api.postMessage({ seq: 0, nodes: 0, edges: 0 });
</script></body></html>`;

function workspacePath(text: string): WorkspacePath {
  assert.ok(isWorkspacePath(text));
  return text;
}

/** `count` nodes in the shape of the engine's filesystem tier, with its edge to every node but the root. */
function syntheticPayload(count: number): GraphPayload {
  const root = makeNodeId({ form: 'directory', path: WORKSPACE_ROOT });
  const nodes: GraphNode[] = [
    { id: root, type: 'DIRECTORY', name: '.', data: { path: '.', name: '.', status: 'ready' } },
  ];
  const edges: GraphEdge[] = [];
  let directory = root;
  let directoryPath = '';
  while (nodes.length < count) {
    const index = nodes.length - 1;
    const isDirectory = index % (FILES_PER_DIRECTORY + 1) === 0;
    const name = `${isDirectory ? 'directory' : 'module'}-${String(index).padStart(6, '0')}`;
    if (isDirectory) {
      directoryPath = `packages/${name}`;
      const path = workspacePath(directoryPath);
      directory = makeNodeId({ form: 'directory', path });
      nodes.push({ id: directory, type: 'DIRECTORY', name, data: { path, name, status: 'ready' } });
      edges.push({ source: root, target: directory, type: 'HAS_ENTRY' });
      continue;
    }
    const file = `${name}.ts`;
    const path = workspacePath(`${directoryPath}/${file}`);
    const id = makeNodeId({ form: 'file', path });
    const revision_id = createHash('sha256').update(path).digest('hex');
    const data = {
      path,
      name: file,
      language: 'typescript',
      content_hash: revision_id,
      revision_id,
    };
    nodes.push({ id, type: 'FILE', name: file, data });
    edges.push({ source: directory, target: id, type: 'HAS_ENTRY' });
  }
  return { seq: -1, nodes, edges };
}

suite('SU-9: what a snapshot costs to transfer', () => {
  let panel: vscode.WebviewPanel;
  let answered: (answer: { readonly at: number; readonly counts: unknown }) => void = ignore;

  suiteSetup(async () => {
    const column = vscode.ViewColumn.One;
    panel = vscode.window.createWebviewPanel('cpg.transfer', 'SU-9', column, {
      enableScripts: true,
    });
    const loaded = new Promise((resolve) => {
      answered = resolve;
    });
    panel.webview.onDidReceiveMessage((counts: unknown) => {
      answered({ at: performance.now(), counts });
    });
    panel.webview.html = PAGE;
    await within(ANSWER_MS, loaded, 'page');
  });
  suiteTeardown(() => panel.dispose());

  for (const count of [10_000, 100_000, 500_000]) {
    test(`${String(count)} nodes`, async () => {
      const payload = syntheticPayload(count);
      const [nodes, edges] = [payload.nodes.length, payload.edges.length];
      const message = (seq: number) => ({ type: 'graph', protocol: 1, epoch: 1, seq, payload });
      const blocked: number[] = [];
      let seq = 0;
      const transfer = async () => {
        seq += 1;
        let from = 0;
        const answer = new Promise<Parameters<typeof answered>[0]>((resolve, reject) => {
          answered = resolve;
          const sent = message(seq);
          from = performance.now();
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- VS Code's webview API takes one argument, not Window.postMessage's targetOrigin.
          panel.webview.postMessage(sent).then(undefined, reject);
          blocked.push(performance.now() - from);
        });
        const { at, counts } = await within(ANSWER_MS, answer, 'answer');
        assert.deepEqual(counts, { seq, nodes, edges });
        return at - from;
      };
      const name = `transfer ${String(nodes)} nodes, ${String(edges)} edges`;
      try {
        const bytes = Buffer.byteLength(JSON.stringify(message(0)));
        await measure({ name, bytes }, COUNT, transfer);
      } finally {
        // postMessage serialises before it returns, on the extension host's own thread.
        const [first, ...samples] = blocked;
        await record({ name: `${name}: the extension host blocked`, samples, first });
      }
    });
  }
});
