// SEAT (U3.1.1 part 4, BMO-52): C-EXT's SourceOpener adapter. Ports 21754b4:src/views/graphViewProvider.ts's
// revealNode: one preview tab, the selection, and the whole extent framed.

import type { WorkspacePath } from '@cpg/model';
import type * as vscode from 'vscode';
import type { SourceOpener } from '../contract';

/**
 * Opens a file's preview in the first editor column, so the panel beside it stays in view. `uriOf` is a
 * workspace path's URI. Rejects when VS Code can't open it.
 */
export function createSourceOpener(_uriOf: (path: WorkspacePath) => vscode.Uri): SourceOpener {
  throw new Error('SEAT: createSourceOpener (U3.1.1 part 4)');
}
