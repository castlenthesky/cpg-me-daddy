import * as vscode from 'vscode';
import { applyGraphDelta, type GraphPayload } from '@cpg/model';

// W0 smoke command. It exists to prove one thing that no unit test can: that
// `@cpg/model` is genuinely consumable *at runtime* from the extension host,
// across a real package boundary, in the CommonJS context VS Code loads us in.
// Everything past this point is the debate's to decide; this is the seam.
export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('cpg-me-daddy.helloWorld', () => {
    const before: GraphPayload = {
      nodes: [
        { id: '/workspace', type: 'directory', name: 'workspace' },
        { id: '/workspace/a.ts', type: 'file', name: 'a.ts' },
      ],
      edges: [{ source: '/workspace', target: '/workspace/a.ts', type: 'HAS_ENTRY' }],
    };

    const after = applyGraphDelta(before, {
      addedNodes: [{ id: '/workspace/b.ts', type: 'file', name: 'b.ts' }],
      addedEdges: [{ source: '/workspace', target: '/workspace/b.ts', type: 'HAS_ENTRY' }],
      removedNodeIds: ['/workspace/a.ts'],
    });

    vscode.window.showInformationMessage(
      `@cpg/model live: ${before.nodes.length} nodes + delta -> ${after.nodes.length} nodes, ` +
        `${after.edges.length} edges (the edge into the removed node was dropped without being listed).`,
    );
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
