import * as vscode from 'vscode';
import { applyGraphDelta, toWorkspacePath, type GraphPayload } from '@cpg/model';

// W0 smoke command. It exists to prove one thing that no unit test can: that
// `@cpg/model` is genuinely consumable *at runtime* from the extension host,
// across a real package boundary, in the CommonJS context VS Code loads us in.
// Everything past this point is the debate's to decide; this is the seam.
export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('cpg-me-daddy.helloWorld', () => {
    const before: GraphPayload = {
      seq: -1,
      nodes: [
        { id: '/workspace', type: 'directory', name: 'workspace' },
        { id: '/workspace/a.ts', type: 'file', name: 'a.ts' },
      ],
      edges: [{ source: '/workspace', target: '/workspace/a.ts', type: 'HAS_ENTRY' }],
    };

    const result = applyGraphDelta(before, {
      seq: 0,
      file: toWorkspacePath('/workspace', '/workspace/b.ts'),
      revision_id: 'smoke',
      producer: 'filesystem',
      addedNodes: [{ id: '/workspace/b.ts', type: 'file', name: 'b.ts' }],
      addedEdges: [{ source: '/workspace', target: '/workspace/b.ts', type: 'HAS_ENTRY' }],
      removedNodeIds: ['/workspace/a.ts'],
    });

    switch (result.outcome) {
      case 'applied':
      case 'already-applied':
        vscode.window.showInformationMessage(
          `@cpg/model live: ${before.nodes.length} nodes + delta -> ${result.payload.nodes.length} nodes, ` +
            `${result.payload.edges.length} edges (the edge into the removed node was dropped without being listed).`,
        );
        break;
      case 'gap':
        vscode.window.showWarningMessage(
          `@cpg/model live: delta seq gap (expected ${result.expected}, got ${result.got}).`,
        );
        break;
      case 'malformed':
        vscode.window.showWarningMessage(
          `@cpg/model live: malformed delta (${result.defects.map((d) => `${d.code} ${d.nodeId}`).join(', ')}).`,
        );
        break;
    }
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
