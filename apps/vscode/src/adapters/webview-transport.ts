// SEAT (U3.1.1 part 4, BMO-52): C-EXT's WebviewTransport adapter: VS Code's WebviewPanel and its serializer
// (AM-2, controller decision 27) as graph-panel.ts's PanelSurface.

import type * as vscode from 'vscode';
import type { PanelSurface } from '../graph-panel';

/** The panel's view type; package.json's activationEvents names `onWebviewPanel:` it. */
export const GRAPH_VIEW_TYPE = 'cpg.graph';

/**
 * A new panel beside the active editor, with scripts on, `retainContextWhenHidden`, and `directory` (the
 * page bundle's) as its only localResourceRoots entry (decision 31).
 */
export function createGraphPanel(_directory: string): PanelSurface {
  throw new Error('SEAT: createGraphPanel (U3.1.1 part 4)');
}

/** Hands a panel VS Code restores to `restore`, with the same webview options as a new one. */
export function graphPanelSerializer(
  _directory: string,
  _restore: (surface: PanelSurface) => Promise<void>,
): vscode.WebviewPanelSerializer {
  throw new Error('SEAT: graphPanelSerializer (U3.1.1 part 4)');
}
