// REAL (U3.1.1 part 4, BMO-52): C-EXT's SourceOpener adapter. Ports 21754b4:src/views/graphViewProvider.ts's
// revealNode: one preview tab, the selection, and the whole extent framed.

import type { SourceRange, WorkspacePath } from '@cpg/model';
import * as vscode from 'vscode';
import type { SourceOpener } from '../contract';

function toRange(range: SourceRange): vscode.Range {
  return new vscode.Range(
    new vscode.Position(range.startRow, range.startColumn),
    new vscode.Position(range.endRow, range.endColumn),
  );
}

/**
 * Opens a file's preview in the first editor column, so the panel beside it stays in view. `uriOf` is a
 * workspace path's URI. Rejects when VS Code can't open it.
 */
export function createSourceOpener(uriOf: (path: WorkspacePath) => vscode.Uri): SourceOpener {
  return {
    async open(request) {
      const editor = await vscode.window.showTextDocument(uriOf(request.filePath), {
        preview: true,
        viewColumn: vscode.ViewColumn.One,
        ...(request.selection !== undefined ? { selection: toRange(request.selection) } : {}),
      });
      if (request.frame !== undefined) {
        editor.revealRange(
          toRange(request.frame),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
      }
    },
  };
}
