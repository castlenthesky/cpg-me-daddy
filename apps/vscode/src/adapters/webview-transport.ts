// REAL (U3.1.1 part 4, BMO-52): C-EXT's WebviewTransport adapter: VS Code's WebviewPanel and its serializer
// (AM-2, controller decision 27) as graph-panel.ts's PanelSurface.

import * as vscode from 'vscode';
import type { PanelSurface } from '../graph-panel';

/** The panel's view type; package.json's activationEvents names `onWebviewPanel:` it. */
export const GRAPH_VIEW_TYPE = 'cpg.graph';

function toSurface(panel: vscode.WebviewPanel, directory: string): PanelSurface {
  panel.webview.options = {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.file(directory)],
  };
  return {
    transport: {
      post(message) {
        // LOSSY by contract: a dropped post shows up as a missing render-report.
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- VS Code's webview API takes one argument, not Window.postMessage's targetOrigin.
        void panel.webview.postMessage(message).then(undefined, () => undefined);
      },
      onMessage(handler) {
        return panel.webview.onDidReceiveMessage(handler);
      },
      cspSource: panel.webview.cspSource,
    },
    asUri(path) {
      return panel.webview.asWebviewUri(vscode.Uri.file(path)).toString();
    },
    setHtml(html) {
      panel.webview.html = html;
    },
    reveal() {
      panel.reveal();
    },
    onDidDispose(listener) {
      return panel.onDidDispose(listener);
    },
    dispose() {
      panel.dispose();
    },
  };
}

/**
 * A new panel beside the active editor, with scripts on, `retainContextWhenHidden`, and `directory` (the
 * page bundle's) as its only localResourceRoots entry (decision 31).
 */
export function createGraphPanel(directory: string): PanelSurface {
  const panel = vscode.window.createWebviewPanel(
    GRAPH_VIEW_TYPE,
    'CPG Graph',
    vscode.ViewColumn.Beside,
    { retainContextWhenHidden: true },
  );
  return toSurface(panel, directory);
}

/** Hands a panel VS Code restores to `restore`, with the same webview options as a new one. */
export function graphPanelSerializer(
  directory: string,
  restore: (surface: PanelSurface) => Promise<void>,
): vscode.WebviewPanelSerializer {
  return {
    deserializeWebviewPanel(panel) {
      return restore(toSurface(panel, directory));
    },
  };
}
