// SEAT (U3.1.1 part 4, BMO-52): C-EXT's FilesystemProbe adapter, over vscode.workspace.fs so that remote file
// systems work (L-11). What is admitted is decided in workspace-probe.ts.

import type { WorkspacePath } from '@cpg/model';
import type * as vscode from 'vscode';
import type { WorkspaceFileSystem } from '../workspace-probe';

/** The workspace's files; `uriOf` is a workspace path's URI. */
export function workspaceFileSystem(
  _uriOf: (path: WorkspacePath) => vscode.Uri,
): WorkspaceFileSystem {
  throw new Error('SEAT: workspaceFileSystem (U3.1.1 part 4)');
}
